//! Keep shell commands and process lifecycle without the plugin's global link interceptor.
//! The upstream script cancels every target=_blank link, including unprivileged browser
//! pages, where shell.open is correctly denied. Main UI links are handled explicitly by
//! frontend/services/tauri-bridge.ts; embedded pages must reach native popup handling.
use tauri::{plugin::Plugin, AppHandle, Runtime};

struct NativeShell<R: Runtime>(Box<dyn Plugin<R>>);

pub fn init<R: Runtime>() -> impl Plugin<R> {
    NativeShell(Box::new(tauri_plugin_shell::init()))
}

impl<R: Runtime> Plugin<R> for NativeShell<R> {
    fn name(&self) -> &'static str { self.0.name() }

    fn initialize(&mut self, app: &AppHandle<R>, config: serde_json::Value)
        -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    // Intentionally inherit None for both initialization_script methods.
    fn window_created(&mut self, window: tauri::Window<R>) { self.0.window_created(window); }
    fn webview_created(&mut self, webview: tauri::Webview<R>) { self.0.webview_created(webview); }
    fn on_navigation(&mut self, webview: &tauri::Webview<R>, url: &tauri::Url) -> bool {
        self.0.on_navigation(webview, url)
    }
    fn on_page_load(&mut self, webview: &tauri::Webview<R>, payload: &tauri::webview::PageLoadPayload<'_>) {
        self.0.on_page_load(webview, payload);
    }
    fn on_event(&mut self, app: &AppHandle<R>, event: &tauri::RunEvent) {
        self.0.on_event(app, event);
    }
    fn extend_api(&mut self, invoke: tauri::ipc::Invoke<R>) -> bool { self.0.extend_api(invoke) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_commands_keep_their_namespace_without_intercepting_browser_links() {
        let upstream = tauri_plugin_shell::init::<tauri::Wry>();
        assert!(upstream.initialization_script_2().unwrap().script.contains("preventDefault"));
        let plugin = init::<tauri::Wry>();
        assert_eq!(plugin.name(), upstream.name());
        assert!(plugin.initialization_script().is_none());
        assert!(plugin.initialization_script_2().is_none());
    }
}
