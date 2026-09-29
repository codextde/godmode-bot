use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// The Godmode data directory: `$GODMODE_HOME` or `~/.godmode` (mirrors `packages/core/src/config.ts`).
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("GODMODE_HOME").filter(|v| !v.is_empty()) {
        return std::path::absolute(PathBuf::from(home)).ok();
    }
    app.path().home_dir().ok().map(|home| home.join(".godmode"))
}

/// Where the core writes `godmode.jsonl` and the shell writes `desktop.log`.
pub fn logs_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    data_dir(app).map(|dir| dir.join("logs"))
}
