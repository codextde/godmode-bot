//! Godmode Bot desktop shell: hosts the React UI, supervises the core daemon (sidecar) and lives in the tray.

mod clock;
mod commands;
mod core;
mod ota;
mod paths;
mod tray;
mod updater;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tauri::{Manager, RunEvent, Window, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

use crate::{core::CoreManager, ota::Patches, updater::Updater};

/// Passed by the OS login item; the app then starts in the tray instead of opening its window.
const AUTOSTART_ARG: &str = "--autostart";

/// Closing the window keeps Godmode (and its routines) running in the tray. Linux trays are not reliable
/// enough to be the only way back into the app, so there closing quits.
const CLOSE_TO_TRAY: bool = cfg!(any(target_os = "macos", windows));

/// User preference (Settings → General → "Minimize to tray"), pushed by the UI via `set_close_to_tray`.
pub struct CloseToTray(pub AtomicBool);

/// Called by the UI whenever the "Minimize to tray" setting is loaded or changed.
#[tauri::command]
fn set_close_to_tray(state: tauri::State<'_, CloseToTray>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

pub fn run() {
    let mut context = tauri::generate_context!();
    let patches = Arc::new(Patches::load(
        paths::data_dir_before_start(),
        context.package_info().version.to_string(),
        !cfg!(debug_assertions) && updater::canary_enabled_in(paths::data_dir_before_start()),
    ));
    ota::PatchAssets::wrap(&mut context, patches.clone());
    let app = tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| tray::show_main_window(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility is ours to decide (tray / autostart), never restore it.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(CoreManager::new()))
        .manage(Arc::new(Updater::new()))
        .manage(patches)
        .manage(CloseToTray(AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![
            clock::system_clock,
            commands::core_info,
            commands::write_file,
            commands::core_logs_path,
            commands::restart_app,
            set_close_to_tray,
            tray::set_tray_labels,
            updater::update_state,
            updater::check_for_updates,
            updater::install_update,
            updater::canary_updates,
            updater::set_canary_updates
        ])
        .setup(|app| {
            let handle = app.handle();
            core::start(handle.clone());
            updater::start(handle.clone());
            tray::create(handle)?;
            let after_update = updater::take_relaunch_marker(handle);
            let start_hidden = CLOSE_TO_TRAY && !after_update && std::env::args().any(|arg| arg == AUTOSTART_ARG);
            if !start_hidden {
                tray::show_main_window(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let enabled = window.state::<CloseToTray>().0.load(Ordering::Relaxed);
                if CLOSE_TO_TRAY && enabled && window.label() == tray::MAIN_WINDOW {
                    api.prevent_close();
                    hide_to_tray(window);
                }
            }
        })
        .build(context)
        .expect("error while building Godmode Bot");

    app.run(|app, event| match event {
        RunEvent::Exit => app.state::<Arc<CoreManager>>().shutdown(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => tray::show_main_window(app),
        _ => {}
    });
}

fn hide_to_tray(window: &Window) {
    // Hiding a fullscreen window on macOS leaves an empty black Space behind: leave fullscreen first.
    if cfg!(target_os = "macos") && window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
        let window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            let _ = window.hide();
        });
        return;
    }
    let _ = window.hide();
}
