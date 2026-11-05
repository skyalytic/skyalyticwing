mod tray;
mod sidecar;
mod commands;
mod browser;
mod shell_plugin;
mod office;
mod update;
mod edition;
mod desktop_surfaces;

use tauri::Manager;
use tauri::Emitter;
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};
use std::sync::Mutex;

static STARTUP_FAILURE: Mutex<Option<String>> = Mutex::new(None);

fn set_startup_message(app: &tauri::AppHandle, message: &str, failed: bool) {
    if let Some(window) = app.get_webview("main") {
        let text = serde_json::to_string(message).unwrap_or_default();
        let script = format!("(() => {{ const p = document.getElementById('startup-status'); if (p) {{ p.textContent = {}; document.body.classList.toggle('startup-failed', {}); const h = document.getElementById('startup-heading'); if (h) h.textContent = {} ? '暂时无法启动工作台' : '正在准备你的工作空间'; }} }})()", text, failed, failed);
        let _ = window.eval(&script);
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
        commands::get_server_status, commands::start_server, commands::stop_server,
        commands::check_for_updates, commands::install_update, commands::get_app_version,
        update::update_prepared, update::cancel_update, update::update_healthy,
        browser::native_browser_command, browser::native_browser_bounds, office::native_office_view,
        desktop_surfaces::desktop_surface,
    ]);
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if STARTUP_FAILURE.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                    set_startup_message(webview.app_handle(), "请重新启动 Wing。如果仍无法打开，请联系支持协助处理。", true);
                }
            }
        })
        .manage(browser::BrowserState::default())
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(shell_plugin::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.set_always_on_top(true);
                let _ = window.set_always_on_top(false);
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(move |invoke| {
            // Custom commands are private to the shell, even on a same-origin local page.
            if invoke.message.webview_ref().label() != "main" {
                invoke.resolver.reject("网页不能调用应用管理命令");
                return true;
            }
            handler(invoke)
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "quit" => {
                    sidecar::stop_node_server();
                    app.exit(0);
                }
                "new_session" => {
                    let _ = app.emit("menu-new-session", ());
                }
                "toggle_theme" => {
                    let _ = app.emit("menu-toggle-theme", ());
                }
                "about" => {
                    let _ = app.emit("menu-about", ());
                }
                _ => {}
            }
        })
        .setup(|app| {
            edition::configure(app.handle())?;
            // 原生系统菜单 (像微信/QQ一样有顶部菜单栏)
            let menu = Menu::with_items(app, &[
                &Submenu::with_items(app, "文件", true, &[
                    &MenuItem::with_id(app, "new_session", "新建会话", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
                ])?,
                &Submenu::with_items(app, "视图", true, &[
                    &MenuItem::with_id(app, "toggle_theme", "切换主题", true, None::<&str>)?,
                ])?,
                &Submenu::with_items(app, "帮助", true, &[
                    &MenuItem::with_id(app, "about", "关于 SkyalyticWing", true, None::<&str>)?,
                ])?,
            ])?;
            app.set_menu(menu)?;

            let args: Vec<String> = std::env::args().collect();
            let start_minimized = args.contains(&"--minimized".to_string());

            tray::create_tray(app)?;
            if update::resume_recovery(app.handle()) { std::process::exit(0); }

            // Keep the native navigation and platform CSP on the same local port.
            // Unix systems use an unprivileged port, without root/capability changes.
            let port = sidecar::startup_port();
            sidecar::set_server_port(port);

            if let Some(window) = app.get_window("main") {
                window.set_title("SkyalyticWing").unwrap_or_default();

            }

            let handle = app.handle().clone();
            let port_for_sidecar = port;
            tauri::async_runtime::spawn(async move {
                // M-G1 fix: start_node_server_on_port 现在返回 Result，
                // 启动失败时记录错误日志（此处无法向用户弹窗，错误通过 sidecar 内部日志输出）。
                if let Err(e) = sidecar::start_node_server_on_port(&handle, port_for_sidecar).await {
                    log::error!("[lib] Failed to start node server on port {}: {}", port_for_sidecar, e);
                    *STARTUP_FAILURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
                    crate::tray::set_status_text(&handle, "服务器状态: 启动失败");
                }
            });

            // The initial page is embedded in the executable. Keep it visible
            // until both the local service and the actual workbench are ready.
            let ready_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(2))
                    .build().unwrap_or_default();
                let base = format!("http://127.0.0.1:{}", port);
                let started = std::time::Instant::now();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    if sidecar::is_intentional_exit() { return; }
                    let failure = STARTUP_FAILURE.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if failure.is_some() {
                        set_startup_message(&ready_handle, "请重新启动 Wing。如果仍无法打开，请联系支持协助处理。", true);
                        return;
                    }
                    if sidecar::is_server_running() {
                        if let Ok(response) = client.get(format!("{}/health", base)).send().await {
                            if response.status().is_success() {
                                if let Ok(page) = client.get(&base).send().await {
                                    if page.status().is_success() && page.text().await.unwrap_or_default().contains("id=\"root\"") {
                                        if let Some(window) = ready_handle.get_webview("main") {
                                            if let Ok(url) = base.parse() {
                                                match window.navigate(url) {
                                                    Ok(()) => return,
                                                    Err(error) => log::warn!("[startup] Workbench navigation failed: {}", error),
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if started.elapsed().as_secs() >= 120 {
                        log::error!("[startup] Workbench did not become ready within 120 seconds");
                        *STARTUP_FAILURE.lock().unwrap_or_else(|e| e.into_inner()) = Some("Startup timed out".into());
                        set_startup_message(&ready_handle, "启动时间比预期长，请重新启动 Wing。你的账号、聊天和文件会保留。", true);
                        return;
                    } else if started.elapsed().as_secs() >= 15 {
                        set_startup_message(&ready_handle, "正在完成首次准备，请稍候。准备完成后将自动进入工作台。", false);
                    }
                }
            });

            if !start_minimized {
                if let Some(window) = app.get_window("main") {
                    window.show().unwrap_or_default();
                }
            }

            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                check_update_on_start(&update_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "wing-approval" || window.label() == "wing-desktop-control" {
                    if let Some(view) = window.app_handle().get_webview(window.label()) {
                        let _ = view.eval("window.dispatchEvent(new Event('wing-surface-close'))");
                    }
                } else { window.hide().unwrap_or_default(); }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                sidecar::stop_node_server();
            }
        });
}

async fn check_update_on_start(app: &tauri::AppHandle) {
    if let Err(error) = update::check(app, true).await { log::warn!("Update check failed: {}",error); }
}
