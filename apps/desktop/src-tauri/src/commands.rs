use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use tauri::{AppHandle, Manager, State};

use crate::{
    core::{CoreInfo, CoreManager},
    paths,
};

/// `{ url, token }` of the running core, or `null` while it is (re)starting.
#[tauri::command]
pub fn core_info(core: State<'_, Arc<CoreManager>>) -> Option<CoreInfo> {
    core.info()
}

/// Directory holding `core.log` (core) and `desktop.log` (this shell).
#[tauri::command]
pub fn core_logs_path(app: AppHandle) -> Result<String, String> {
    let dir = paths::logs_dir(&app).ok_or("could not determine the home directory")?;
    let _ = fs::create_dir_all(&dir);
    Ok(dir.display().to_string())
}

/// Saves bytes chosen by the user in a save dialog (exports, backups, attachments).
/// Only absolute paths; system directories and sensitive home locations are refused.
#[tauri::command]
pub async fn write_file(app: AppHandle, path: String, data: Vec<u8>) -> Result<(), String> {
    let protected = ProtectedPaths::new(app.path().home_dir().ok(), paths::data_dir(&app));
    tauri::async_runtime::spawn_blocking(move || {
        let target = validate_write_target(Path::new(&path), &protected)?;
        write_atomically(&target, &data).map_err(|err| format!("could not write {}: {err}", target.display()))
    })
    .await
    .map_err(|err| err.to_string())?
}

pub struct ProtectedPaths {
    system_roots: Vec<PathBuf>,
    home: Option<PathBuf>,
    home_entries: Vec<PathBuf>,
}

impl ProtectedPaths {
    pub fn new(home: Option<PathBuf>, data_dir: Option<PathBuf>) -> Self {
        #[cfg(unix)]
        let system: Vec<PathBuf> = [
            "/bin",
            "/sbin",
            "/usr",
            "/etc",
            "/boot",
            "/dev",
            "/proc",
            "/sys",
            "/lib",
            "/lib32",
            "/lib64",
            "/libx32",
            "/opt",
            "/var",
            "/snap",
            "/System",
            "/Library",
            "/Applications",
            "/private/etc",
            "/private/var",
            "/cores",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        #[cfg(windows)]
        let system: Vec<PathBuf> =
            ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]
                .iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .collect();

        // Places where a written file could run code or leak credentials.
        let sensitive = [
            ".ssh",
            ".gnupg",
            ".aws",
            ".kube",
            ".docker",
            ".claude",
            ".config/autostart",
            ".config/systemd",
            ".config/environment.d",
            ".local/bin",
            ".local/share/applications",
            ".cargo/bin",
            ".bun/bin",
            "Library/LaunchAgents",
            "Library/LaunchDaemons",
            "AppData/Roaming/Microsoft/Windows/Start Menu",
        ];
        let home = home.map(|h| h.canonicalize().unwrap_or(h));
        let mut home_entries: Vec<PathBuf> =
            home.iter().flat_map(|h| sensitive.iter().map(move |rel| h.join(rel))).collect();
        home_entries.extend(data_dir);

        Self { system_roots: with_canonical(system), home, home_entries: with_canonical(home_entries) }
    }

    fn check(&self, target: &Path) -> Result<(), String> {
        let parent = target.parent().ok_or("refusing to write to a filesystem root")?;
        if parent.parent().is_none() {
            return Err("refusing to write to the root of a drive".into());
        }
        if let Some(root) = self.system_roots.iter().find(|root| is_within(target, root)) {
            return Err(format!("refusing to write inside the system directory {}", root.display()));
        }
        if let Some(entry) = self.home_entries.iter().find(|entry| is_within(target, entry)) {
            return Err(format!("refusing to write inside the protected location {}", entry.display()));
        }
        let hidden = target.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if hidden && self.home.as_deref().is_some_and(|home| same_path(parent, home)) {
            return Err("refusing to overwrite a hidden file in your home folder".into());
        }
        Ok(())
    }
}

/// Adds the symlink-resolved form of every existing path (e.g. /etc → /private/etc on macOS).
fn with_canonical(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(paths.len() * 2);
    for path in paths {
        if let Ok(canonical) = path.canonicalize() {
            if canonical != path {
                out.push(canonical);
            }
        }
        out.push(path);
    }
    out
}

/// Case-insensitive on macOS and Windows, whose default filesystems are.
fn fold(path: &Path) -> PathBuf {
    if cfg!(any(target_os = "macos", windows)) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

fn is_within(path: &Path, root: &Path) -> bool {
    fold(path).starts_with(fold(root))
}

fn same_path(a: &Path, b: &Path) -> bool {
    fold(a) == fold(b)
}

pub fn validate_write_target(raw: &Path, protected: &ProtectedPaths) -> Result<PathBuf, String> {
    if raw.as_os_str().is_empty() {
        return Err("no path given".into());
    }
    if !raw.is_absolute() {
        return Err(format!("path must be absolute: {}", raw.display()));
    }
    // Check the raw string too: in Windows verbatim paths (`\\?\C:\…`) `..` is not parsed as a parent component.
    let has_parent_segment = raw.to_string_lossy().split(['/', '\\']).any(|segment| segment == "..");
    if has_parent_segment || raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path must not contain '..'".into());
    }
    let file_name = raw.file_name().ok_or("path must name a file")?;
    let parent = raw.parent().ok_or("path must name a file")?;
    let parent =
        parent.canonicalize().map_err(|err| format!("folder {} is not accessible: {err}", parent.display()))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    let target = parent.join(file_name);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("refusing to write through a symbolic link".into());
        }
        if meta.is_dir() {
            return Err(format!("{} is a folder", target.display()));
        }
    }
    protected.check(&target)?;
    Ok(target)
}

/// Write to a temp file next to the target, then rename over it: no half-written files on failure.
fn write_atomically(target: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().expect("validated target has a parent");
    let name = target.file_name().expect("validated target has a file name").to_string_lossy();
    let mut suffix = [0u8; 6];
    let _ = getrandom::fill(&mut suffix);
    let suffix: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dir.join(format!(".{name}.{suffix}.godmode-tmp"));

    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/write-file-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn protected(home: &Path) -> ProtectedPaths {
        ProtectedPaths::new(Some(home.to_path_buf()), Some(home.join(".godmode")))
    }

    #[test]
    fn writes_regular_files_atomically() {
        let dir = scratch("ok");
        let target =
            validate_write_target(&dir.join("export.json"), &protected(Path::new("/nonexistent-home"))).unwrap();
        write_atomically(&target, b"{}").unwrap();
        write_atomically(&target, b"[1]").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"[1]");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "temp file left behind");
    }

    #[test]
    fn rejects_relative_and_parent_paths() {
        let p = protected(Path::new("/nonexistent-home"));
        assert!(validate_write_target(Path::new("export.json"), &p).is_err());
        assert!(validate_write_target(Path::new(""), &p).is_err());
        let dir = scratch("dotdot");
        assert!(validate_write_target(&dir.join("../x.json"), &p).is_err());
    }

    #[test]
    fn rejects_missing_folders_and_directories() {
        let p = protected(Path::new("/nonexistent-home"));
        let dir = scratch("dirs");
        assert!(validate_write_target(&dir.join("missing/x.json"), &p).is_err());
        fs::create_dir(dir.join("sub")).unwrap();
        assert!(validate_write_target(&dir.join("sub"), &p).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_system_directories_and_symlinks() {
        let p = protected(Path::new("/nonexistent-home"));
        assert!(validate_write_target(Path::new("/etc/hosts"), &p).is_err());
        assert!(validate_write_target(Path::new("/usr/local/bin/evil"), &p).is_err());
        assert!(validate_write_target(Path::new("/x.json"), &p).is_err());

        let dir = scratch("symlink");
        std::os::unix::fs::symlink("/etc/hosts", dir.join("link")).unwrap();
        assert!(validate_write_target(&dir.join("link"), &p).is_err());
        std::os::unix::fs::symlink("/etc", dir.join("etc")).unwrap();
        assert!(validate_write_target(&dir.join("etc/x"), &p).is_err());
    }

    #[test]
    fn rejects_sensitive_home_locations() {
        let home = scratch("home");
        for dir in [".ssh", ".godmode", "Documents"] {
            fs::create_dir_all(home.join(dir)).unwrap();
        }
        let p = protected(&home);
        assert!(validate_write_target(&home.join(".ssh/authorized_keys"), &p).is_err());
        assert!(validate_write_target(&home.join(".godmode/godmode.db"), &p).is_err());
        assert!(validate_write_target(&home.join(".zshrc"), &p).is_err());
        assert!(validate_write_target(&home.join("Documents/.notes"), &p).is_ok());
        assert!(validate_write_target(&home.join("backup.godmode-backup"), &p).is_ok());
    }
}
