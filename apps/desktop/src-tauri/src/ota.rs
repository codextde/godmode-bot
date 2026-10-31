use std::{
    borrow::Cow,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
};

use semver::Version;
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    App, Assets, Runtime, Url,
};

pub const BUNDLE_ENV: &str = "GODMODE_CORE_BUNDLE";
const FEED_BASE: &str = "https://github.com/codextde/godmode-bot/releases/download/canary/";
const CURRENT_FILE: &str = "current";
const FAILED_FILE: &str = "failed";
const PARTIAL_PREFIX: &str = ".partial-";

pub struct Patch {
    pub version: String,
    root: PathBuf,
}

impl Patch {
    pub fn core_entry(&self) -> PathBuf {
        self.root.join("core").join("index.js")
    }

    fn ui_dir(&self) -> PathBuf {
        self.root.join("ui")
    }

    fn asset(&self, key: &AssetKey) -> Option<Vec<u8>> {
        let rel = Path::new(key.as_ref().trim_start_matches('/'));
        if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return None;
        }
        fs::read(self.ui_dir().join(rel)).ok()
    }

    fn is_complete(&self) -> bool {
        self.core_entry().is_file() && self.ui_dir().join("index.html").is_file()
    }
}

pub struct Patches {
    dir: Option<PathBuf>,
    app_version: String,
    active: RwLock<Option<Arc<Patch>>>,
}

impl Patches {
    pub fn load(data_dir: Option<PathBuf>, app_version: String, enabled: bool) -> Self {
        let dir = data_dir.map(|data| data.join("updates").join("patch").join(&app_version));
        let patches = Self { dir, app_version, active: RwLock::new(None) };
        if let Some(dir) = &patches.dir {
            remove_other_bases(dir);
        }
        if !enabled {
            return patches;
        }
        let Some(dir) = patches.dir.clone() else { return patches };
        let Some(version) = read_trimmed(&dir.join(CURRENT_FILE)) else { return patches };
        if read_trimmed(&dir.join(FAILED_FILE)).as_deref() == Some(version.as_str()) {
            return patches;
        }
        let patch = Patch { root: dir.join(&version), version };
        if patch.is_complete() {
            *patches.active.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(patch));
        }
        patches
    }

    pub fn active(&self) -> Option<Arc<Patch>> {
        self.active.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn feed(&self) -> Result<Url, String> {
        Url::parse(&format!("{FEED_BASE}patch-{}.json", self.app_version)).map_err(|err| err.to_string())
    }

    pub fn wants(&self, remote: &Version) -> bool {
        let Some(dir) = &self.dir else { return false };
        if read_trimmed(&dir.join(FAILED_FILE))
            .is_some_and(|failed| Version::parse(&failed).ok().as_ref() == Some(remote))
        {
            return false;
        }
        let installed = self.active().map_or(self.app_version.clone(), |patch| patch.version.clone());
        Version::parse(&installed).is_ok_and(|installed| remote > &installed)
    }

    pub fn stage(&self, version: &str, archive: &[u8]) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("No data directory")?;
        Version::parse(version).map_err(|err| format!("invalid patch version {version}: {err}"))?;
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
        let keep = self.active().map(|patch| patch.version.clone());
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.path().is_dir() && Some(&name) != keep.as_ref() {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let partial = dir.join(format!("{PARTIAL_PREFIX}{version}"));
        let _ = fs::remove_dir_all(&partial);
        fs::create_dir_all(&partial).map_err(|err| err.to_string())?;
        let unpacked = tar::Archive::new(flate2::read::GzDecoder::new(archive)).unpack(&partial);
        let patch = Patch { version: version.to_string(), root: partial.clone() };
        if let Err(err) = unpacked.map_err(|err| err.to_string()).and_then(|()| {
            if patch.is_complete() {
                Ok(())
            } else {
                Err("the patch has no core/index.js or ui/index.html".into())
            }
        }) {
            let _ = fs::remove_dir_all(&partial);
            return Err(err);
        }
        fs::rename(&partial, dir.join(version)).map_err(|err| err.to_string())
    }

    pub fn activate(&self, version: &str) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("No data directory")?;
        if !(Patch { version: version.to_string(), root: dir.join(version) }).is_complete() {
            return Err(format!("patch {version} is not on disk"));
        }
        fs::write(dir.join(CURRENT_FILE), version).map_err(|err| err.to_string())
    }

    pub fn fail(&self) -> Option<String> {
        let patch = self.active.write().unwrap_or_else(|p| p.into_inner()).take()?;
        if let Some(dir) = &self.dir {
            let _ = fs::write(dir.join(FAILED_FILE), &patch.version);
            let _ = fs::remove_file(dir.join(CURRENT_FILE));
        }
        Some(patch.version.clone())
    }
}

fn remove_other_bases(dir: &Path) {
    let (Some(parent), Some(own)) = (dir.parent(), dir.file_name()) else { return };
    let Ok(entries) = fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        if entry.file_name() != own && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

pub struct PatchAssets<R: Runtime> {
    fallback: Box<dyn Assets<R>>,
    patches: Arc<Patches>,
}

impl<R: Runtime> PatchAssets<R> {
    pub fn wrap(context: &mut tauri::Context<R>, patches: Arc<Patches>) {
        let fallback = context.set_assets(Box::new(NoAssets));
        context.set_assets(Box::new(Self { fallback, patches }));
    }
}

impl<R: Runtime> Assets<R> for PatchAssets<R> {
    fn setup(&self, app: &App<R>) {
        self.fallback.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.patches.active() {
            Some(patch) => patch.asset(key).map(Cow::Owned),
            None => self.fallback.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.fallback.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.fallback.csp_hashes(html_path)
    }
}

struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("godmode-ota-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn archive(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, body.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn release(dir: &Path, canary: bool) -> Patches {
        Patches::load(Some(dir.to_path_buf()), "0.2.39-23".into(), canary)
    }

    const GOOD: &[(&str, &str)] = &[("core/index.js", "core"), ("ui/index.html", "<html>"), ("ui/assets/app.js", "js")];

    #[test]
    fn stages_activates_and_serves_a_patch() {
        let dir = temp_dir("stage");
        let patches = release(&dir, true);
        assert!(patches.active().is_none());
        assert!(patches.wants(&Version::parse("0.2.39-40").unwrap()));
        assert!(!patches.wants(&Version::parse("0.2.39-23").unwrap()));
        patches.stage("0.2.39-40", &archive(GOOD)).unwrap();
        patches.activate("0.2.39-40").unwrap();

        let patches = release(&dir, true);
        let patch = patches.active().expect("active patch");
        assert_eq!(patch.version, "0.2.39-40");
        assert!(patch.core_entry().ends_with("0.2.39-40/core/index.js"));
        assert_eq!(patch.asset(&AssetKey::from("assets/app.js")).as_deref(), Some(b"js".as_slice()));
        assert_eq!(patch.asset(&AssetKey::from("/index.html")).as_deref(), Some(b"<html>".as_slice()));
        assert!(patch.asset(&AssetKey::from("../current")).is_none());
        assert!(!patches.wants(&Version::parse("0.2.39-40").unwrap()));
        assert!(patches.wants(&Version::parse("0.2.39-41").unwrap()));
        assert!(release(&dir, false).active().is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_incomplete_patches() {
        let dir = temp_dir("incomplete");
        let patches = release(&dir, true);
        assert!(patches.stage("0.2.39-40", &archive(&[("core/index.js", "core")])).is_err());
        assert!(patches.activate("0.2.39-40").is_err());
        assert!(patches.stage("0.2.39-40", b"not a tarball").is_err());
        assert!(patches.stage("latest", &archive(GOOD)).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_patch_is_dropped_and_not_offered_again() {
        let dir = temp_dir("failed");
        let patches = release(&dir, true);
        patches.stage("0.2.39-40", &archive(GOOD)).unwrap();
        patches.activate("0.2.39-40").unwrap();
        let patches = release(&dir, true);
        assert_eq!(patches.fail().as_deref(), Some("0.2.39-40"));
        assert!(patches.active().is_none());
        assert!(!patches.wants(&Version::parse("0.2.39-40").unwrap()));
        assert!(patches.wants(&Version::parse("0.2.39-41").unwrap()));
        assert!(release(&dir, true).active().is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_shell_version_removes_patches_of_the_old_one() {
        let dir = temp_dir("bases");
        let old = dir.join("updates/patch/0.2.39-10/0.2.39-12");
        fs::create_dir_all(&old).unwrap();
        let _ = release(&dir, true);
        assert!(!old.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
