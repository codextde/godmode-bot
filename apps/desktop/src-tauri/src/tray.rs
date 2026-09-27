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

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Godmode", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Godmode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &separator, &quit])?;

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
