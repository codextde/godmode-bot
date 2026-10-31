use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

pub const MAIN_WINDOW: &str = "main";

/// Brings the main window to the front (also un-hides the app on macOS after ⌘H).
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, open: &str, new_chat: &str, quit: &str) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", new_chat, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &new_chat, &separator, &quit])
}

/// The app sends the tray labels in its language once it knows it.
#[tauri::command]
pub fn set_tray_labels<R: Runtime>(app: AppHandle<R>, open: String, new_chat: String, quit: String) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("no tray")?;
    let menu = build_menu(&app, &open, &new_chat, &quit).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, "Open Godmode", "New chat", "Quit Godmode")?;

    // macOS: monochrome template image that adapts to the menu bar; elsewhere the full-colour app icon.
    #[cfg(target_os = "macos")]
    let icon = Some(tauri::include_image!("icons/tray@2x.png"));
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().cloned();

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Godmode Bot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "new-chat" => {
                show_main_window(app);
                let _ = app.emit("navigate", "/");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
