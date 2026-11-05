use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager,
};
// L-G5 fix: 引入 OnceLock 保存 status 菜单项的引用，供 set_status_text 在状态变化时调用。
use std::sync::OnceLock;

// L-G5 fix: 全局保存 status MenuItem 引用，服务器状态变化时调用 set_text 更新文本。
// 之前状态菜单创建时设为"启动中..."，全文无 set_text 调用，状态永不更新。
// 使用 tauri::Wry（默认运行时）作为具体类型，避免泛型参数问题。
static STATUS_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
        let _ = window.set_always_on_top(false);
    }
}

/// L-G5 fix: 服务器状态变化时调用此函数更新托盘菜单文本。
/// 由 sidecar 模块在 spawn/崩溃/停止时调用。
pub fn set_status_text(_app: &tauri::AppHandle, text: &str) {
    if let Some(item) = STATUS_MENU_ITEM.get() {
        if let Err(e) = item.set_text(text) {
            log::warn!("[tray] Failed to update status menu text: {}", e);
        }
    } else {
        log::warn!("[tray] STATUS_MENU_ITEM not yet initialized, cannot set text: {}", text);
    }
}

pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "服务器状态: 启动中...", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &status, &check_update, &separator, &quit])?;

    // L-G5 fix: 保存 status 菜单项引用，供后续 set_text 更新文本。
    let _ = STATUS_MENU_ITEM.set(status);

    let tray_builder = TrayIconBuilder::with_id("main-tray")
        .tooltip(app.package_info().name.clone())
        // M-G5 fix: default_window_icon() 可能返回 None（图标缺失），
        // 之前 .unwrap() 会 panic。改用 if let Some 优雅降级，缺图标时使用空图标。
        .icon(if let Some(icon) = app.default_window_icon() {
            icon.clone()
        } else {
            log::warn!("[tray] default_window_icon() returned None, using fallback empty icon");
            tauri::image::Image::new(&[], 0, 0)
        })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                show_main_window(app);
            }
            "status" => {
                show_main_window(app);
            }
            "update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_and_prompt_update(&handle).await;
                });
            }
            "quit" => {
                sidecar::stop_node_server();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    tray_builder.build(app)?;

    Ok(())
}

async fn check_and_prompt_update(app: &tauri::AppHandle) {
    show_main_window(app);
    if let Err(error) = crate::update::check(app, false).await { log::warn!("Update check failed: {}",error); }
}

use crate::sidecar;
