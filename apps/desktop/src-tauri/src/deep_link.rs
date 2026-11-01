//! `godmode://` links from the browser, e.g. `godmode://license?key=GM-…` from the welcome page after checkout.
//! The shell only hands them over: the UI takes them with `take_deep_links` (links that arrive before it listens,
//! on a cold start, wait here) and decides what to do with them.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::tray;

/// Tells the UI that links are waiting.
const EVENT: &str = "deep-link";
const SCHEME: &str = "godmode:";
const MAX_PENDING: usize = 8;

#[derive(Default)]
pub struct PendingLinks(Mutex<Vec<String>>);

pub fn start(app: &AppHandle) {
    // Windows and Linux learn the scheme at run time (AppImage, portable installs); macOS from the bundle's Info.plist.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(err) = app.deep_link().register_all() {
        app.state::<std::sync::Arc<crate::core::CoreManager>>()
            .log(&format!("couldn't register godmode:// links: {err}"));
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, urls.into_iter().map(String::from).collect());
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, event.urls().into_iter().map(String::from).collect()));
}

fn receive(app: &AppHandle, urls: Vec<String>) {
    let urls: Vec<String> = urls.into_iter().filter(|url| url.to_ascii_lowercase().starts_with(SCHEME)).collect();
    if urls.is_empty() {
        return;
    }
    {
        let state = app.state::<PendingLinks>();
        let mut pending = state.0.lock().unwrap_or_else(|e| e.into_inner());
        for url in urls {
            if !pending.contains(&url) {
                pending.push(url);
            }
        }
        let extra = pending.len().saturating_sub(MAX_PENDING);
        pending.drain(..extra);
    }
    tray::show_main_window(app);
    let _ = app.emit(EVENT, ());
}

/// The links that arrived since the last call, oldest first.
#[tauri::command]
pub fn take_deep_links(state: tauri::State<'_, PendingLinks>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}
