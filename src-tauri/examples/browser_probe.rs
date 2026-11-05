//! Isolated native browser acceptance harness; never packaged with the application.
#[path = "../src/browser.rs"]
mod browser;
#[path = "../src/shell_plugin.rs"]
mod shell_plugin;
mod sidecar {
    pub fn get_server_port() -> u16 {
        19112
    }
}
use tauri::Manager;
#[tauri::command]
fn probe_finish(app: tauri::AppHandle) {
    app.exit(0);
}
fn main() {
    tauri::Builder::default()
        .plugin(shell_plugin::init())
        .manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            browser::native_browser_command,
            browser::native_browser_bounds,
            probe_finish
        ])
        .setup(|app| {
            app.get_webview("main")
                .unwrap()
                .navigate("http://127.0.0.1:19112/".parse().unwrap())?;
            let window = app.get_window("main").unwrap();
            window.set_title("Wing 2.0.1 浏览器隔离验证")?;
            if std::env::var_os("WING_BROWSER_PROBE_VISIBLE").is_some() {
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("browser probe");
}
