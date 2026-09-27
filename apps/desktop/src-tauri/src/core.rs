//! Supervises the Godmode core daemon: spawns it, reads its `GODMODE_READY` line, restarts it when it dies
//! and shuts it down gracefully when the app quits.
//!
//! * Release builds run the bundled sidecar `godmode-core serve --mode desktop`.
//! * Debug builds run `bun <repo>/packages/core/src/index.ts serve --mode desktop` so core edits apply on restart.
//! * `GODMODE_CORE_CMD` overrides the command prefix in any build (e.g. `/path/to/godmode` or `bun /path/index.ts`).
//!
//! The access token is handed over as the first line of the core's stdin (`--token-stdin`), never through the
//! environment, where any process of the same user (e.g. a prompt-injected agent) could read it via `ps eww`.
//! After that the core's stdin stays piped: when this process goes away (even on a crash) the pipe closes and the
//! core shuts itself down.

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::paths;

const SIDECAR: &str = "godmode-core";
const READY_PREFIX: &str = "GODMODE_READY ";
/// Give up after this many consecutive crashes.
const MAX_RESTARTS: u32 = 3;
/// First restart delay; doubles for every consecutive crash.
const RESTART_BACKOFF: Duration = Duration::from_secs(1);
/// A core that stayed up this long is considered healthy again (resets the crash counter).
const STABLE_AFTER: Duration = Duration::from_secs(120);
/// How long the core gets to stop its runs and browsers before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(6);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Returned to the UI by the `core_info` command and sent with `core-restarted`.
#[derive(Clone, Debug, Serialize)]
pub struct CoreInfo {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreFailed {
    message: String,
    logs_path: Option<String>,
}

#[derive(Deserialize)]
struct ReadyLine {
    url: String,
}

pub struct CoreManager {
    token: String,
    info: Mutex<Option<CoreInfo>>,
    process: Mutex<Option<Arc<CoreProcess>>>,
    shutting_down: AtomicBool,
    log_file: Mutex<Option<File>>,
}

struct CoreProcess {
    pid: u32,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CoreManager {
    pub fn new() -> Self {
        Self {
            token: generate_token(),
            info: Mutex::new(None),
            process: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            log_file: Mutex::new(None),
        }
    }

    /// `{ url, token }` once the core reported it is listening; `None` while it (re)starts.
    pub fn info(&self) -> Option<CoreInfo> {
        lock(&self.info).clone()
    }

    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Stops the core: close its stdin (+ SIGTERM on Unix), wait for a clean exit, then kill its process tree.
    /// Called from `RunEvent::Exit`; blocks for at most a few seconds.
    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        *lock(&self.info) = None;
        let Some(process) = lock(&self.process).take() else { return };
        self.log("stopping core");
        process.request_stop();
        if process.wait_timeout(SHUTDOWN_GRACE).is_none() {
            self.log("core did not stop in time, killing it");
            process.kill_tree();
            let _ = process.wait_timeout(Duration::from_secs(2));
        }
    }

    fn open_log(&self, app: &AppHandle) {
        let Some(dir) = paths::logs_dir(app) else { return };
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("desktop.log");
        if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
            let _ = fs::rename(&path, dir.join("desktop.log.1"));
        }
        *lock(&self.log_file) = OpenOptions::new().create(true).append(true).open(path).ok();
    }

    /// Shell messages: terminal + `desktop.log`.
    fn log(&self, message: &str) {
        eprintln!("[godmode] {message}");
        self.append_log(&format!("{} [shell] {message}", timestamp()));
    }

    fn append_log(&self, line: &str) {
        if let Some(file) = lock(&self.log_file).as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }
}

impl CoreProcess {
    fn try_wait(&self) -> Result<Option<ExitStatus>, std::io::Error> {
        lock(&self.child).try_wait()
    }

    /// Blocks until the process exits. `None` if its status could not be read.
    fn wait(&self) -> Option<ExitStatus> {
        loop {
            match self.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(_) => return None,
            }
        }
    }

    fn wait_timeout(&self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(_) => return None,
            }
        }
        None
    }

    fn request_stop(&self) {
        // EOF on stdin is the core's cross-platform shutdown signal (desktop mode).
        lock(&self.stdin).take();
        #[cfg(unix)]
        if matches!(self.try_wait(), Ok(None)) {
            // SAFETY: kill(2) on the pid of our own child, which has not been reaped yet.
            unsafe {
                libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }

    fn kill_tree(&self) {
        #[cfg(unix)]
        // SAFETY: the core runs in its own process group (see `spawn_core`), so this reaches Chromium, claude, …
        // (not a visible Chromium on macOS: LaunchServices starts it, and the next core adopts it)
        unsafe {
            libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = lock(&self.child).kill();
    }
}

/// Starts the supervisor thread. Returns immediately.
pub fn start(app: AppHandle) {
    let manager = app.state::<Arc<CoreManager>>().inner().clone();
    manager.open_log(&app);
    thread::Builder::new()
        .name("godmode-core-supervisor".into())
        .spawn(move || supervise(app, manager))
        .expect("failed to start the core supervisor thread");
}

fn supervise(app: AppHandle, manager: Arc<CoreManager>) {
    let path_env = user_path(&app);
    let mut crashes = 0u32;
    loop {
        let started = Instant::now();
        let status = match spawn_core(&app, &manager, crashes > 0, path_env.as_ref()) {
            Ok(process) => process.wait(),
            Err(err) => {
                manager.log(&err);
                None
            }
        };
        *lock(&manager.info) = None;
        lock(&manager.process).take();
        if manager.is_shutting_down() {
            return;
        }

        let status = status.map_or_else(|| "unknown status".to_string(), |s| s.to_string());
        if started.elapsed() >= STABLE_AFTER {
            crashes = 0;
        }
        if crashes >= MAX_RESTARTS {
            let message = format!("Godmode core stopped ({status}) and did not recover after {MAX_RESTARTS} restarts");
            manager.log(&message);
            let logs_path = paths::logs_dir(&app).map(|p| p.display().to_string());
            let _ = app.emit("core-failed", CoreFailed { message, logs_path });
            return;
        }
        crashes += 1;
        let delay = RESTART_BACKOFF * 2u32.pow(crashes - 1);
        manager.log(&format!(
            "core exited unexpectedly ({status}); restarting in {}s (attempt {crashes}/{MAX_RESTARTS})",
            delay.as_secs()
        ));
        let deadline = Instant::now() + delay;
        while Instant::now() < deadline {
            if manager.is_shutting_down() {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

fn spawn_core(
    app: &AppHandle,
    manager: &Arc<CoreManager>,
    is_restart: bool,
    path_env: Option<&OsString>,
) -> Result<Arc<CoreProcess>, String> {
    let (mut cmd, description) = core_command(app)?;
    cmd.args(["serve", "--mode", "desktop", "--token-stdin"])
        // Never pass the token via the environment (not even one inherited from our own parent).
        .env_remove("GODMODE_TOKEN")
        .env("GODMODE_MODE", "desktop")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cfg!(debug_assertions) {
        // Lets the core accept the Vite dev server origin (http://127.0.0.1:1420).
        cmd.env("GODMODE_DEV", "1");
    }
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group, so a forced shutdown can take the core's children (Chromium, claude) with it.
        cmd.process_group(0);
    }

    // Holding the slot while spawning closes the race with `shutdown()`.
    let mut slot = lock(&manager.process);
    if manager.is_shutting_down() {
        return Err("not starting the core: app is shutting down".into());
    }
    let mut child = cmd.spawn().map_err(|err| format!("failed to start the core ({description}): {err}"))?;
    manager.log(&format!("started core ({description}), pid {}", child.id()));
    // A single short line fits in the pipe buffer, so this doesn't block even before the core reads it.
    if let Some(stdin) = child.stdin.as_mut() {
        if let Err(err) = write_token_line(stdin, &manager.token) {
            manager.log(&format!("could not send the access token to the core: {err}"));
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let process =
        Arc::new(CoreProcess { pid: child.id(), stdin: Mutex::new(child.stdin.take()), child: Mutex::new(child) });
    *slot = Some(process.clone());
    drop(slot);

    if let Some(stdout) = stdout {
        let (app, manager) = (app.clone(), manager.clone());
        thread::spawn(move || {
            for_each_line(stdout, |line| {
                if let Some(json) = line.strip_prefix(READY_PREFIX) {
                    on_ready(&app, &manager, json, is_restart);
                }
                eprintln!("[core] {line}");
            })
        });
    }
    if let Some(stderr) = stderr {
        let manager = manager.clone();
        thread::spawn(move || {
            for_each_line(stderr, |line| {
                eprintln!("[core] {line}");
                manager.append_log(&format!("[core] {line}"));
            })
        });
    }
    Ok(process)
}

/// The `--token-stdin` handshake: the token followed by a newline.
fn write_token_line(out: &mut impl Write, token: &str) -> std::io::Result<()> {
    out.write_all(token.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

fn on_ready(app: &AppHandle, manager: &CoreManager, json: &str, is_restart: bool) {
    let ready = match serde_json::from_str::<ReadyLine>(json) {
        Ok(ready) => ready,
        Err(err) => {
            manager.log(&format!("could not parse the core ready line: {err}"));
            return;
        }
    };
    let info = CoreInfo { url: ready.url, token: manager.token.clone() };
    manager.log(&format!("core ready at {}", info.url));
    *lock(&manager.info) = Some(info.clone());
    if is_restart {
        let _ = app.emit("core-restarted", info);
    }
}

fn for_each_line(stream: impl Read, mut handle: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                handle(line.trim_end_matches(['\r', '\n']));
            }
        }
    }
}

/// The command prefix used to run the core (without `serve …`), plus a description for the logs.
fn core_command(app: &AppHandle) -> Result<(Command, String), String> {
    let home = app.path().home_dir().ok();

    if let Some(custom) = std::env::var("GODMODE_CORE_CMD").ok().filter(|v| !v.trim().is_empty()) {
        let mut parts = split_command_line(&custom)?;
        let program = parts.remove(0);
        let mut cmd: Command = app.shell().command(program).into();
        cmd.args(parts);
        if let Some(home) = &home {
            cmd.current_dir(home);
        }
        return Ok((cmd, custom));
    }

    #[cfg(debug_assertions)]
    {
        use std::path::Path;
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/src/index.ts");
        if let Ok(entry) = entry.canonicalize() {
            let mut cmd: Command = app.shell().command("bun").into();
            cmd.arg(&entry);
            if let Some(core_dir) = entry.parent().and_then(Path::parent) {
                cmd.current_dir(core_dir);
            }
            return Ok((cmd, format!("bun {}", entry.display())));
        }
    }

    let mut cmd: Command = app.shell().sidecar(SIDECAR).map_err(|err| format!("core sidecar not found: {err}"))?.into();
    if let Some(home) = &home {
        cmd.current_dir(home);
    }
    Ok((cmd, format!("sidecar {SIDECAR}")))
}

/// Splits `GODMODE_CORE_CMD` on whitespace, honouring '…' and "…" quotes (no escapes, so Windows paths work).
fn split_command_line(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_arg = false;
    let mut quote: Option<char> = None;
    for c in input.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                in_arg = true;
            }
            None if c.is_whitespace() => {
                if in_arg {
                    args.push(std::mem::take(&mut current));
                    in_arg = false;
                }
            }
            None => {
                current.push(c);
                in_arg = true;
            }
        }
    }
    if quote.is_some() {
        return Err("GODMODE_CORE_CMD has an unterminated quote".into());
    }
    if in_arg {
        args.push(current);
    }
    if args.is_empty() {
        return Err("GODMODE_CORE_CMD is empty".into());
    }
    Ok(args)
}

/// Apps started from Finder / a desktop launcher get a minimal PATH, but the core needs `claude`, `uvx`, `git`
/// and friends. Merge the login shell's PATH (release builds) with the usual install locations.
#[cfg(unix)]
fn user_path(app: &AppHandle) -> Option<OsString> {
    let home = app.path().home_dir().ok();
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if !cfg!(debug_assertions) {
        if let Some(login) = login_shell_path() {
            dirs.extend(std::env::split_paths(&login));
        }
    }
    if let Some(current) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&current));
    }
    let extra_home = [".local/bin", ".bun/bin", ".cargo/bin", ".npm-global/bin", ".volta/bin"];
    let extra_system = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    let candidates = home
        .iter()
        .flat_map(|h| extra_home.iter().map(move |d| h.join(d)))
        .chain(extra_system.iter().map(PathBuf::from));
    dirs.extend(candidates.filter(|d| d.is_dir()));

    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    std::env::join_paths(dirs).ok()
}

#[cfg(windows)]
fn user_path(_app: &AppHandle) -> Option<OsString> {
    None
}

/// PATH as seen by the user's interactive login shell (5 s timeout).
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    const MARKER: &str = "__GODMODE_ENV__";
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }.into());
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &format!("echo {MARKER}; /usr/bin/env")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let output = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    let (_, env) = output.split_once(MARKER)?;
    env.lines().find_map(|line| line.strip_prefix("PATH=")).map(str::to_owned).filter(|p| !p.is_empty())
}

/// 32 random bytes, base64url without padding.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random number generator is unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// UTC timestamp like `2026-09-27T18:04:05Z` (no chrono dependency needed for log lines).
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_bytes_base64url() {
        let token = generate_token();
        assert_eq!(token.len(), 43);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(token, generate_token());
    }

    #[test]
    fn writes_token_line() {
        let mut out = Vec::new();
        write_token_line(&mut out, "abc_DEF-123").unwrap();
        assert_eq!(out, b"abc_DEF-123\n");
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(split_command_line("bun /x/index.ts").unwrap(), ["bun", "/x/index.ts"]);
        assert_eq!(
            split_command_line(r#""C:\Program Files\bun.exe"  'a b' c"#).unwrap(),
            [r"C:\Program Files\bun.exe", "a b", "c"]
        );
        assert_eq!(split_command_line(r#"bun """#).unwrap(), ["bun", ""]);
        assert!(split_command_line("  ").is_err());
        assert!(split_command_line("bun 'x").is_err());
    }

    #[test]
    fn converts_days_to_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_723), (2026, 9, 27));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn parses_ready_line() {
        let line = r#"GODMODE_READY {"url":"http://127.0.0.1:7777","port":7777,"version":"0.1.0"}"#;
        let ready: ReadyLine = serde_json::from_str(line.strip_prefix(READY_PREFIX).unwrap()).unwrap();
        assert_eq!(ready.url, "http://127.0.0.1:7777");
    }
}
