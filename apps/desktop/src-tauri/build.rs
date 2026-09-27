use std::{
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

/// Written at the start of the placeholder sidecar so release builds can refuse to bundle it.
const PLACEHOLDER_MARKER: &[u8] = b"GODMODE_CORE_PLACEHOLDER";

fn main() {
    ensure_sidecar();
    tauri_build::build();
}

/// `bundle.externalBin` has to exist for every build. Debug builds run the core from source
/// (see `src/core.rs`), so a placeholder is enough there; release builds must ship the real binary
/// produced by `pnpm build:sidecar`.
fn ensure_sidecar() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let target = env::var("TARGET").expect("TARGET");
    let exe = if target.contains("windows") { ".exe" } else { "" };
    let sidecar = manifest_dir.join("binaries").join(format!("godmode-core-{target}{exe}"));
    println!("cargo:rerun-if-changed={}", sidecar.display());

    let release = env::var("PROFILE").as_deref() == Ok("release");
    match (sidecar.is_file(), is_placeholder(&sidecar), release) {
        (true, false, _) => {}
        (_, _, true) => panic!(
            "\n\nThe core sidecar {} is missing (or is the dev placeholder).\n\
             Build it first: `pnpm build:sidecar` (or `bun run packages/core/scripts/build.ts --sidecar --target=<bun target>`).\n\n",
            sidecar.display()
        ),
        (false, _, false) => write_placeholder(&sidecar),
        (true, true, false) => {}
    }
}

fn is_placeholder(path: &Path) -> bool {
    let mut head = [0u8; 256];
    let Ok(mut file) = File::open(path) else { return false };
    let n = file.read(&mut head).unwrap_or(0);
    head[..n].windows(PLACEHOLDER_MARKER.len()).any(|w| w == PLACEHOLDER_MARKER)
}

fn write_placeholder(path: &Path) {
    let marker = String::from_utf8_lossy(PLACEHOLDER_MARKER);
    let script = format!(
        "#!/bin/sh\n# {marker}\necho 'godmode-core placeholder: debug builds run packages/core from source; run `pnpm build:sidecar` for a real sidecar.' >&2\nexit 1\n"
    );
    fs::create_dir_all(path.parent().expect("binaries dir")).expect("create binaries dir");
    fs::write(path, script).expect("write sidecar placeholder");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod sidecar placeholder");
    }
    println!("cargo:warning=created a placeholder core sidecar at {} (debug build)", path.display());
}
