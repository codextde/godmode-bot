use tauri::{
    menu::{Menu, MenuEvent, MenuItem, MenuItemKind},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{tray, updater};

const CHECK_UPDATES: &str = "check-updates";

pub struct CheckUpdatesItem(MenuItem<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        app_menu.insert(&item, 1)?;
    }
    app.manage(CheckUpdatesItem(item));
    Ok(menu)
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    if event.id() != CHECK_UPDATES {
        return;
    }
    tray::show_main_window(app);
    let _ = app.emit("navigate", "/settings/about");
    let app = app.clone();
    tauri::async_runtime::spawn(async move { updater::check_for_updates(app).await });
}

pub fn set_label(app: &AppHandle, label: &str) {
    if let Some(item) = app.try_state::<CheckUpdatesItem>() {
        let _ = item.0.set_text(label);
    }
}
