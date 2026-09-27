//! Auto-update: checks the release feed in the background, downloads a newer build silently and keeps it until the
//! user clicks "Restart to update". The webview only sees the state and two commands, never the updater itself.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::core::{lock, CoreManager};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// Sooner after a failure: right after login the network is often not up yet.
const RETRY_INTERVAL: Duration = Duration::from_secs(20 * 60);
/// Wall-clock polling instead of one long sleep: the monotonic clock stands still while a laptop sleeps.
const TICK: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Per read, so a stalled connection fails instead of leaving the updater stuck in "downloading".
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);
const STATE_EVENT: &str = "update-state";
/// Set for the relaunched app, which inherits the original arguments: after an update it must show its window even
/// when the first launch was a hidden `--autostart`.
pub const RELAUNCHED_ENV: &str = "GODMODE_UPDATED";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateState {
    /// Debug builds: installing over a dev binary makes no sense.
    Disabled,
    Idle,
    Checking,
    UpToDate {
        checked_at: u64,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
    Installing {
        version: String,
    },
    Error {
        message: String,
    },
}

impl UpdateState {
    fn is_busy(&self) -> bool {
        matches!(self, Self::Checking | Self::Downloading { .. } | Self::Ready { .. } | Self::Installing { .. })
    }
}

pub struct Updater {
    state: Mutex<UpdateState>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
}

impl Updater {
    pub fn new() -> Self {
        let state = if cfg!(debug_assertions) { UpdateState::Disabled } else { UpdateState::Idle };
        Self { state: Mutex::new(state), downloaded: Mutex::new(None) }
    }

    fn set(&self, app: &AppHandle, state: UpdateState) {
        *lock(&self.state) = state.clone();
        let _ = app.emit(STATE_EVENT, state);
    }

    /// Claims the updater for a check; `false` while another check, a download or a pending install is running.
    fn begin_check(&self, app: &AppHandle) -> bool {
        let mut state = lock(&self.state);
        if state.is_busy() || matches!(*state, UpdateState::Disabled) {
            return false;
        }
        *state = UpdateState::Checking;
        drop(state);
        let _ = app.emit(STATE_EVENT, UpdateState::Checking);
        true
    }

    fn failed(&self) -> bool {
        matches!(*lock(&self.state), UpdateState::Error { .. })
    }
}

pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    thread::Builder::new()
        .name("godmode-updater".into())
        .spawn(move || {
            thread::sleep(FIRST_CHECK_DELAY);
            let updater = app.state::<Arc<Updater>>().inner().clone();
            let mut last_check: Option<SystemTime> = None;
            loop {
                let interval = if updater.failed() { RETRY_INTERVAL } else { CHECK_INTERVAL };
                if last_check.is_none_or(|at| at.elapsed().map_or(true, |since| since >= interval)) {
                    tauri::async_runtime::block_on(check_and_download(&app));
                    last_check = Some(SystemTime::now());
                }
                thread::sleep(TICK);
            }
        })
        .expect("failed to start the updater thread");
}

async fn check_and_download(app: &AppHandle) {
    let updater = app.state::<Arc<Updater>>().inner().clone();
    if !updater.begin_check(app) {
        return;
    }
    let core = app.state::<Arc<CoreManager>>().inner().clone();
    let next = match find_and_download(app, &updater, &core).await {
        Ok(Some((update, mut bytes))) => {
            core.log(&format!("update {} downloaded and verified", update.version));
            bytes.shrink_to_fit();
            let state = UpdateState::Ready { version: update.version.clone(), notes: update.body.clone() };
            *lock(&updater.downloaded) = Some((update, bytes));
            state
        }
        Ok(None) => UpdateState::UpToDate { checked_at: now_millis() },
        Err(message) => {
            core.log(&format!("update check failed: {message}"));
            UpdateState::Error { message }
        }
    };
    updater.set(app, next);
}

async fn find_and_download(
    app: &AppHandle,
    updater: &Updater,
    core: &Arc<CoreManager>,
) -> Result<Option<(Update, Vec<u8>)>, String> {
    let (core, handle) = (core.clone(), app.clone());
    let checker = app
        .updater_builder()
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT))
        // Windows only: the installer replaces godmode-core.exe, so the core has to be gone before it starts.
        .on_before_exit(move || {
            std::env::set_var(RELAUNCHED_ENV, "1");
            let _ = handle.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
            core.shutdown();
            handle.cleanup_before_exit();
        })
        .build()
        .map_err(|err| err.to_string())?;
    let Some(update) = checker.check().await.map_err(|err| err.to_string())? else { return Ok(None) };

    let version = update.version.clone();
    app.state::<Arc<CoreManager>>().log(&format!("update {version} available, downloading"));
    updater.set(app, UpdateState::Downloading { version: version.clone(), downloaded: 0, total: None });
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_emit.elapsed() >= PROGRESS_THROTTLE {
                    last_emit = Instant::now();
                    updater.set(app, UpdateState::Downloading { version: version.clone(), downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|err| err.to_string())?;
    Ok(Some((update, bytes)))
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub fn update_state(updater: State<'_, Arc<Updater>>) -> UpdateState {
    lock(&updater.state).clone()
}

/// Progress arrives through `update-state` events.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) {
    check_and_download(&app).await;
}

/// Installs the downloaded update and relaunches. On Windows the installer takes over and restarts the app itself.
#[tauri::command]
pub async fn install_update(app: AppHandle, updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    let (update, bytes) = lock(&updater.downloaded).take().ok_or("No update has been downloaded yet")?;
    let core = app.state::<Arc<CoreManager>>();
    let version = update.version.clone();
    core.log(&format!("installing update {version}"));
    updater.set(&app, UpdateState::Installing { version: version.clone() });
    let (update, bytes, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = update.install(&bytes);
        (update, bytes, result)
    })
    .await
    .map_err(|err| err.to_string())?;

    if let Err(err) = result {
        let message = err.to_string();
        core.log(&format!("update install failed: {message}"));
        if cfg!(windows) {
            // The pre-exit hook already stopped the core and removed the tray: only a relaunch recovers.
            tauri::process::restart(&app.env());
        }
        let notes = update.body.clone();
        *lock(&updater.downloaded) = Some((update, bytes));
        updater.set(&app, UpdateState::Ready { version, notes });
        return Err(message);
    }
    std::env::set_var(RELAUNCHED_ENV, "1");
    app.request_restart();
    Ok(())
}
