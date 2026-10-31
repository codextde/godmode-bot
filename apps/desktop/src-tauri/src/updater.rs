//! Auto-update: checks the release feed in the background, downloads a newer build silently and keeps it until the
//! user clicks "Restart to update". The webview only sees the state and two commands, never the updater itself.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, Updater as Checker, UpdaterBuilder, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::{
    core::{lock, CoreManager},
    ota::Patches,
    paths,
};

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
/// The relaunched app gets the original arguments: after an update it must show its window even when the first
/// launch was a hidden `--autostart`.
const RELAUNCH_MARKER: &str = "show-after-update";
const CANARY_MARKER: &str = "update-channel-canary";
const CANARY_FEED: &str = "https://github.com/codextde/godmode-bot/releases/download/canary/latest.json";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateState {
    Disabled,
    Idle,
    Checking,
    UpToDate { checked_at: u64 },
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    Ready { version: String, notes: Option<String> },
    Installing { version: String },
    Error { message: String },
}

impl UpdateState {
    fn is_busy(&self) -> bool {
        matches!(self, Self::Checking | Self::Downloading { .. } | Self::Ready { .. } | Self::Installing { .. })
    }
}

enum Pending {
    Full(Box<Update>, Vec<u8>),
    Patch(String),
}

struct Found {
    version: String,
    notes: Option<String>,
    pending: Pending,
}

pub struct Updater {
    state: Mutex<UpdateState>,
    downloaded: Mutex<Option<Pending>>,
    /// Windows: the pre-exit hook stopped the core and removed the tray.
    exiting: AtomicBool,
}

impl Updater {
    pub fn new() -> Self {
        let state = if cfg!(debug_assertions) { UpdateState::Disabled } else { UpdateState::Idle };
        Self { state: Mutex::new(state), downloaded: Mutex::new(None), exiting: AtomicBool::new(false) }
    }

    fn set(&self, app: &AppHandle, state: UpdateState) {
        *lock(&self.state) = state.clone();
        let _ = app.emit(STATE_EVENT, state);
    }

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
        Ok(Some(found)) => {
            let kind = if matches!(found.pending, Pending::Patch(_)) { "patch" } else { "update" };
            core.log(&format!("{kind} {} downloaded and verified", found.version));
            let state = UpdateState::Ready { version: found.version, notes: found.notes };
            *lock(&updater.downloaded) = Some(found.pending);
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
) -> Result<Option<Found>, String> {
    let canary_channel = canary_enabled(app);
    let canary = if canary_channel {
        let feed = Url::parse(CANARY_FEED).map_err(|err| err.to_string())?;
        match checker(app, core, Some(vec![feed]))?.check().await {
            Ok(update) => update,
            Err(err) => {
                core.log(&format!("canary update check failed, falling back to stable: {err}"));
                None
            }
        }
    } else {
        None
    };
    let found = match canary {
        Some(update) => Some(update),
        None => checker(app, core, None)?.check().await.map_err(|err| err.to_string())?,
    };
    let Some(update) = found else {
        return if canary_channel { find_patch(app, updater, core).await } else { Ok(None) };
    };

    let mut bytes = download(app, updater, &update, "update").await?;
    bytes.shrink_to_fit();
    Ok(Some(Found {
        version: update.version.clone(),
        notes: update.body.clone(),
        pending: Pending::Full(Box::new(update), bytes),
    }))
}

async fn find_patch(app: &AppHandle, updater: &Updater, core: &Arc<CoreManager>) -> Result<Option<Found>, String> {
    let patches = app.state::<Arc<Patches>>().inner().clone();
    let feed = patches.feed()?;
    let wanted = patches.clone();
    let checker = builder(app, core)
        .endpoints(vec![feed])
        .map_err(|err| err.to_string())?
        .version_comparator(move |_, remote| wanted.wants(&remote.version))
        .build()
        .map_err(|err| err.to_string())?;
    let update = match checker.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(None),
        Err(err) => {
            core.log(&format!("no canary patch for this build: {err}"));
            return Ok(None);
        }
    };
    let bytes = download(app, updater, &update, "patch").await?;
    let version = update.version.clone();
    let staged = version.clone();
    tauri::async_runtime::spawn_blocking(move || patches.stage(&staged, &bytes))
        .await
        .map_err(|err| err.to_string())??;
    Ok(Some(Found { notes: update.body.clone(), pending: Pending::Patch(version.clone()), version }))
}

async fn download(app: &AppHandle, updater: &Updater, update: &Update, kind: &str) -> Result<Vec<u8>, String> {
    let version = update.version.clone();
    app.state::<Arc<CoreManager>>().log(&format!("{kind} {version} available, downloading"));
    updater.set(app, UpdateState::Downloading { version: version.clone(), downloaded: 0, total: None });
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    update
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
        .map_err(|err| err.to_string())
}

fn checker(app: &AppHandle, core: &Arc<CoreManager>, endpoints: Option<Vec<Url>>) -> Result<Checker, String> {
    let mut builder = builder(app, core);
    if let Some(endpoints) = endpoints {
        builder = builder.endpoints(endpoints).map_err(|err| err.to_string())?;
    }
    builder.build().map_err(|err| err.to_string())
}

fn builder(app: &AppHandle, core: &Arc<CoreManager>) -> UpdaterBuilder {
    let (core, handle, shared) = (core.clone(), app.clone(), app.state::<Arc<Updater>>().inner().clone());
    app.updater_builder()
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT))
        // Windows only: the installer replaces godmode-core.exe, so the core has to be gone before it starts.
        .on_before_exit(move || {
            shared.exiting.store(true, Ordering::SeqCst);
            mark_relaunch(&handle);
            let _ = handle.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
            core.shutdown();
            handle.cleanup_before_exit();
        })
}

fn canary_marker(app: &AppHandle) -> Option<PathBuf> {
    paths::data_dir(app).map(|dir| dir.join(CANARY_MARKER))
}

pub fn canary_enabled_in(data_dir: Option<PathBuf>) -> bool {
    data_dir.is_some_and(|dir| dir.join(CANARY_MARKER).exists())
}

fn canary_enabled(app: &AppHandle) -> bool {
    canary_marker(app).is_some_and(|marker| marker.exists())
}

fn relaunch_marker(app: &AppHandle) -> Option<PathBuf> {
    paths::data_dir(app).map(|dir| dir.join(RELAUNCH_MARKER))
}

pub fn mark_relaunch(app: &AppHandle) {
    if let Some(marker) = relaunch_marker(app) {
        let _ = fs::write(marker, b"");
    }
}

pub fn take_relaunch_marker(app: &AppHandle) -> bool {
    relaunch_marker(app).is_some_and(|marker| fs::remove_file(marker).is_ok())
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub fn update_state(updater: State<'_, Arc<Updater>>) -> UpdateState {
    lock(&updater.state).clone()
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) {
    check_and_download(&app).await;
}

#[tauri::command]
pub fn canary_updates(app: AppHandle) -> bool {
    canary_enabled(&app)
}

#[tauri::command]
pub async fn set_canary_updates(app: AppHandle, enabled: bool) -> Result<(), String> {
    let marker = canary_marker(&app).ok_or("No data directory")?;
    if enabled {
        if let Some(dir) = marker.parent() {
            fs::create_dir_all(dir).map_err(|err| err.to_string())?;
        }
        fs::write(&marker, b"").map_err(|err| err.to_string())?;
        check_and_download(&app).await;
    } else if marker.exists() {
        fs::remove_file(&marker).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// On Windows the installer takes over and restarts the app itself.
#[tauri::command]
pub async fn install_update(app: AppHandle, updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    let pending = lock(&updater.downloaded).take().ok_or("No update has been downloaded yet")?;
    let core = app.state::<Arc<CoreManager>>();
    let (update, bytes) = match pending {
        Pending::Full(update, bytes) => (*update, bytes),
        Pending::Patch(version) => {
            core.log(&format!("installing patch {version}"));
            if let Err(err) = app.state::<Arc<Patches>>().activate(&version) {
                core.log(&format!("patch install failed: {err}"));
                updater.set(&app, UpdateState::Error { message: err.clone() });
                return Err(err);
            }
            updater.set(&app, UpdateState::Installing { version });
            mark_relaunch(&app);
            app.request_restart();
            return Ok(());
        }
    };
    let version = update.version.clone();
    core.log(&format!("installing update {version}"));
    updater.set(&app, UpdateState::Installing { version: version.clone() });
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let result = update.install(&bytes);
        (update, bytes, result)
    })
    .await;

    let message = match installed {
        Ok((_, _, Ok(()))) => {
            mark_relaunch(&app);
            app.request_restart();
            return Ok(());
        }
        Ok((update, bytes, Err(err))) => {
            let notes = update.body.clone();
            *lock(&updater.downloaded) = Some(Pending::Full(Box::new(update), bytes));
            updater.set(&app, UpdateState::Ready { version, notes });
            err.to_string()
        }
        Err(err) => {
            updater.set(&app, UpdateState::Error { message: err.to_string() });
            err.to_string()
        }
    };
    core.log(&format!("update install failed: {message}"));
    if updater.exiting.load(Ordering::SeqCst) {
        // Only a relaunch brings the core and the tray back.
        tauri::process::restart(&app.env());
    }
    Err(message)
}
