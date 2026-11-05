use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    webview::WebviewBuilder,
    LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};
#[cfg(not(target_os = "windows"))]
use tauri::webview::NewWindowResponse;
#[cfg(not(target_os = "windows"))]
use tauri::webview::DownloadEvent;
#[cfg(target_os = "windows")]
#[path = "browser-downloads.rs"]
mod windows_downloads;

#[derive(Clone, Serialize)]
struct Tab {
    id: String,
    session_id: String,
    label: String,
    url: String,
    title: String,
    zoom: f64,
    loading: bool,
    created_at: u64,
    opener_label: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Download {
    id: String,
    session_id: String,
    name: String,
    path: String,
    status: String,
    url: String,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    total_bytes: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}
#[derive(Default)]
pub struct BrowserState {
    tabs: Mutex<HashMap<String, Tab>>,
    active: Mutex<HashMap<String, String>>,
    downloads: Mutex<Vec<Download>>,
    errors: Mutex<HashMap<String, String>>,
    history_loaded: Mutex<HashSet<String>>,
    history_io: Mutex<()>,
}

fn download_history_path(app: &tauri::AppHandle, session: &str) -> Result<std::path::PathBuf, String> {
    if !valid_id(session) { return Err("无效的浏览器会话".into()); }
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("browser-downloads").join(format!("{}.json", session)))
}
fn load_download_history(app: &tauri::AppHandle, session: &str) {
    let state = app.state::<BrowserState>();
    let _io = state.history_io.lock().unwrap();
    if !state.history_loaded.lock().unwrap().insert(session.into()) { return; }
    let Ok(path) = download_history_path(app, session) else { return };
    if std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) { return; }
    let Ok(bytes) = std::fs::read(path) else { return };
    let Ok(mut items) = serde_json::from_slice::<Vec<Download>>(&bytes) else { return };
    items.retain(|d| d.session_id == session && valid_id(&d.id));
    for item in &mut items { if item.status == "pending" { item.status = "failed".into(); } }
    state.downloads.lock().unwrap().extend(items.into_iter().rev().take(500).collect::<Vec<_>>().into_iter().rev());
}
fn save_download_history(app: &tauri::AppHandle, session: &str) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let _io = state.history_io.lock().unwrap();
    let path = download_history_path(app, session)?;
    let items: Vec<_> = state.downloads.lock().unwrap().iter().filter(|d| d.session_id == session).cloned().collect();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.next");
    std::fs::write(&temp, serde_json::to_vec(&items).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
pub struct Command {
    pub session_id: String,
    pub op: String,
    #[serde(default)]
    pub args: Value,
}
#[derive(Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    page_id: Option<String>,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn trusted(caller: &Webview) -> Result<(), String> {
    let url = caller.url().map_err(|e| e.to_string())?;
    if caller.label() != "main"
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(crate::sidecar::get_server_port())
    {
        return Err("仅 Wing 主界面可控制内置浏览器".into());
    }
    Ok(())
}
fn active(app: &tauri::AppHandle, session: &str, page_id: Option<&str>) -> Result<Tab, String> {
    let state = app.state::<BrowserState>();
    let id = page_id
        .map(str::to_string)
        .or_else(|| state.active.lock().unwrap().get(session).cloned())
        .ok_or("浏览器页面尚未打开")?;
    let tab = state
        .tabs
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("页面已关闭")?;
    if tab.session_id != session {
        return Err("页面不属于当前会话".into());
    }
    Ok(tab)
}
async fn evaluate(view: &Webview, op: &str, args: &Value) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let script = format!(
        "{}; window.__wingBrowser({}, {})",
        include_str!("browser-page.js"),
        serde_json::to_string(op).unwrap(),
        args
    );
    view.eval_with_callback(script, move |value| {
        if let Some(tx) = sender.lock().unwrap().take() {
            let _ = tx.send(value);
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "网页响应超时")?
        .map_err(|_| "页面已关闭")?;
    let data: Value = serde_json::from_str(&raw).map_err(|_| "页面正在加载，请稍后重试")?;
    if data["ok"] != true {
        return Err(data["error"]
            .as_str()
            .unwrap_or("页面正在加载，请稍后重试")
            .into());
    }
    Ok(data["value"].clone())
}
fn allowed_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "file") || url.as_str() == "about:blank"
}
// WebView2's in-process protocol. No debugging port or external browser is exposed.
#[cfg(target_os = "windows")]
async fn cdp(view: &Webview, method: &str, params: Value) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let method = method.to_string();
    let params = params.to_string();
    view.with_webview(move |platform| {
        let done = sender.clone();
        let callback = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |status, result| {
                if let Some(tx) = done.lock().unwrap().take() {
                    let _ = tx.send(status.map(|_| result).map_err(|e| e.to_string()));
                }
                Ok(())
            },
        ));
        let method = windows::core::HSTRING::from(method);
        let params = windows::core::HSTRING::from(params);
        let result = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .and_then(|core| core.CallDevToolsProtocolMethod(&method, &params, &callback))
        };
        if let Err(error) = result {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(Err(error.to_string()));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "网页操作超时")?
        .map_err(|_| "页面已关闭")??;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
async fn native_zoom(view: &Webview) -> Result<f64, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let mut scale = 1.0;
        let result = unsafe { platform.controller().ZoomFactor(&mut scale) };
        let _ = tx.send(result.map(|_| scale).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_millis(200), rx)
        .await
        .map_err(|_| "读取缩放超时")?
        .map_err(|_| "页面已关闭")?
}

#[cfg(target_os = "windows")]
async fn native_input(view: &Webview, op: &str, args: &Value) -> Result<Value, String> {
    if matches!(op, "fill" | "type") {
        evaluate(
            view,
            "focus",
            &json!({"index":args["index"],"x":args["x"],"y":args["y"],"selectAll":op=="fill"}),
        )
        .await?;
        if op == "fill" && args["text"].as_str().or_else(|| args["value"].as_str()).unwrap_or("").is_empty() {
            cdp(view, "Input.dispatchKeyEvent", json!({"type":"keyDown","key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8})).await?;
            return cdp(view, "Input.dispatchKeyEvent", json!({"type":"keyUp","key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8})).await;
        }
        return cdp(
            view,
            "Input.insertText",
            json!({"text":args["text"].as_str().or_else(||args["value"].as_str()).unwrap_or("")}),
        )
        .await;
    }
    if op == "key" {
        let raw = args["key"].as_str().ok_or("需要按键名称")?;
        let parts: Vec<_> = raw.split('+').collect();
        let name = parts.last().copied().unwrap_or("");
        let mut modifiers = 0;
        for p in &parts[..parts.len().saturating_sub(1)] {
            modifiers |= match p.to_lowercase().as_str() {
                "alt" => 1,
                "control" | "ctrl" => 2,
                "meta" | "cmd" => 4,
                "shift" => 8,
                _ => return Err("不支持的组合键".into()),
            };
        }
        let (key, code, vk) = match name {
            "Enter" => ("Enter", "Enter", 13),
            "Tab" => ("Tab", "Tab", 9),
            "Backspace" => ("Backspace", "Backspace", 8),
            "Escape" => ("Escape", "Escape", 27),
            "ArrowUp" => ("ArrowUp", "ArrowUp", 38),
            "ArrowDown" => ("ArrowDown", "ArrowDown", 40),
            "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37),
            "ArrowRight" => ("ArrowRight", "ArrowRight", 39),
            "Delete" => ("Delete", "Delete", 46),
            "Home" => ("Home", "Home", 36),
            "End" => ("End", "End", 35),
            "PageUp" => ("PageUp", "PageUp", 33),
            "PageDown" => ("PageDown", "PageDown", 34),
            "a" | "A" => ("a", "KeyA", 65),
            "c" | "C" => ("c", "KeyC", 67),
            "v" | "V" => ("v", "KeyV", 86),
            "x" | "X" => ("x", "KeyX", 88),
            "z" | "Z" => ("z", "KeyZ", 90),
            _ => return Err("不支持的按键；输入文本请使用 type".into()),
        };
        let mut event = json!({"type":"keyDown","key":key,"code":code,"windowsVirtualKeyCode":vk,"nativeVirtualKeyCode":vk,"modifiers":modifiers});
        if key == "Enter" {
            event["text"] = json!("\r");
        }
        cdp(view, "Input.dispatchKeyEvent", event.clone()).await?;
        event["type"] = json!("keyUp");
        event.as_object_mut().unwrap().remove("text");
        return cdp(view, "Input.dispatchKeyEvent", event).await;
    }
    let point = if op == "scroll" {
        evaluate(view, "point", &json!({})).await?
    } else {
        json!({})
    };
    let element = if op == "scroll" {
        json!({})
    } else {
        evaluate(view, "input-target", args).await?
    };
    let x = args["x"].as_f64().unwrap_or(
        point["x"]
            .as_f64()
            .unwrap_or(element["x"].as_f64().unwrap_or(0.)),
    );
    let y = args["y"].as_f64().unwrap_or(
        point["y"]
            .as_f64()
            .unwrap_or(element["y"].as_f64().unwrap_or(0.)),
    );
    if op == "scroll" {
        return cdp(view,"Input.dispatchMouseEvent",json!({"type":"mouseWheel","x":x,"y":y,"deltaX":args["dx"].as_f64().unwrap_or(0.),"deltaY":args["dy"].as_f64().unwrap_or(600.)})).await;
    }
    cdp(
        view,
        "Input.dispatchMouseEvent",
        json!({"type":"mouseMoved","x":x,"y":y}),
    )
    .await?;
    if op == "hover" {
        return Ok(json!({}));
    }
    cdp(
        view,
        "Input.dispatchMouseEvent",
        json!({"type":"mousePressed","button":"left","clickCount":1,"x":x,"y":y}),
    )
    .await?;
    cdp(
        view,
        "Input.dispatchMouseEvent",
        json!({"type":"mouseReleased","button":"left","clickCount":1,"x":x,"y":y}),
    )
    .await
}
async fn create_tab(
    app: &tauri::AppHandle,
    session: &str,
    id: &str,
    url: tauri::Url,
) -> Result<Tab, String> {
    create_tab_with_builder(app, session, id, url, None).await
}

async fn create_tab_with_builder(
    app: &tauri::AppHandle,
    session: &str,
    id: &str,
    url: tauri::Url,
    supplied: Option<WebviewBuilder<tauri::Wry>>,
) -> Result<Tab, String> {
    let state = app.state::<BrowserState>();
    if !valid_id(id) || !valid_id(session) {
        return Err("无效的页面标识".into());
    }
    if state.tabs.lock().unwrap().contains_key(id) {
        return Err("页面标识已被占用".into());
    }
    if state
        .tabs
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.session_id == session)
        .count()
        >= 12
    {
        return Err("请先关闭不用的标签页".into());
    }
    let label = format!("wing-browser-{}", id);
    let is_popup = supplied.is_some();
    let tab = Tab {
        id: id.into(),
        session_id: session.into(),
        label: label.clone(),
        url: url.to_string(),
        title: String::new(),
        zoom: 1.0,
        loading: true,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64,
        opener_label: None,
    };
    // Windows/Linux use per-conversation directories; macOS 14+ uses a named WK store.
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-profiles")
        .join(session);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let nav_app = app.clone();
    let nav_id = id.to_string();
    let title_app = app.clone();
    let title_id = id.to_string();
    let load_app = app.clone();
    let load_id = id.to_string();
    #[cfg(not(target_os = "windows"))]
    let popup_app = app.clone();
    #[cfg(not(target_os = "windows"))]
    let popup_session = session.to_string();
    let dl_app = app.clone();
    let dl_session = session.to_string();
    let builder = supplied.unwrap_or_else(||
        WebviewBuilder::new(label.clone(), WebviewUrl::External(url))).data_directory(data);
    #[cfg(target_os = "macos")]
    let builder = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(format!("{}:wing-browser:{session}", app.config().identifier));
        let mut id = [0u8; 16];
        id.copy_from_slice(&digest[..16]);
        builder.data_store_identifier(id)
    };
    let builder = builder
        .disable_drag_drop_handler()
        .initialization_script(include_str!("browser-page.js"))
        .zoom_hotkeys_enabled(true)
        .on_navigation(move |url| {
            if !allowed_url(url) {
                return false;
            }
            if let Some(tab) = nav_app
                .state::<BrowserState>()
                .tabs
                .lock()
                .unwrap()
                .get_mut(&nav_id)
            {
                tab.url = url.to_string();
                tab.loading = true;
            }
            true
        })
        .on_document_title_changed(move |_, title| {
            if let Some(tab) = title_app
                .state::<BrowserState>()
                .tabs
                .lock()
                .unwrap()
                .get_mut(&title_id)
            {
                tab.title = title;
            }
        })
        .on_page_load(move |_, payload| {
            if let Some(tab) = load_app
                .state::<BrowserState>()
                .tabs
                .lock()
                .unwrap()
                .get_mut(&load_id)
            {
                tab.url = payload.url().to_string();
                tab.loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            }
        });
    #[cfg(not(target_os = "windows"))]
    let builder = builder.on_new_window(move |url, _| {
            if allowed_url(&url) {
                let app = popup_app.clone();
                let session = popup_session.clone();
                // A popup stays in Wing rather than opening an external browser.
                let id = format!(
                    "popup-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                );
                std::thread::spawn(move || {
                    tauri::async_runtime::block_on(async move {
                        if let Err(error) = create_tab(&app, &session, &id, url).await {
                            app.state::<BrowserState>().errors.lock().unwrap().insert(
                                session, format!("无法打开新标签页：{}", error),
                            );
                        }
                    });
                });
            }
            NewWindowResponse::Deny
        });
    #[cfg(not(target_os = "windows"))]
    let builder = builder.on_download(move |_, event| {
            let state = dl_app.state::<BrowserState>();
            match event {
                DownloadEvent::Requested { destination, url } => {
                    let name = destination
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let folder = match dl_app.path().download_dir() {
                        Ok(p) => p,
                        Err(_) => return false,
                    };
                    let mut path = folder.join(&name);
                    let mut n = 1;
                    while path.exists() {
                        path = folder.join(format!("{}-{}", n, name));
                        n += 1;
                    }
                    *destination = path.clone();
                    state.downloads.lock().unwrap().push(Download {
                        id: format!(
                            "download-{}",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_nanos()
                        ),
                        session_id: dl_session.clone(),
                        name,
                        path: path.to_string_lossy().into(),
                        status: "pending".into(),
                        url: url.to_string(),
                        created_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                        bytes: None,
                        total_bytes: None,
                        error: None,
                    });
                }
                DownloadEvent::Finished { path, success, url } => {
                    let mut list = state.downloads.lock().unwrap();
                    if let Some(item) = list.iter_mut().find(|d| {
                        d.session_id == dl_session
                            && d.status == "pending"
                            && d.url == url.as_str()
                            && (path.is_none()
                                || path
                                    .as_ref()
                                    .map(|p| p.to_string_lossy() == d.path)
                                    .unwrap_or(false))
                    }) {
                        item.status = if success { "ready" } else { "failed" }.into();
                        if success {
                            item.bytes = std::fs::metadata(&item.path).ok().map(|m| m.len());
                        }
                    }
                }
                _ => {}
            }
            if let Err(error) = save_download_history(&dl_app, &dl_session) {
                log::warn!("Browser download history could not be saved: {}", error);
            }
            true
        });
    state.tabs.lock().unwrap().insert(id.into(), tab.clone());
    let window = app.get_window("main").ok_or("主窗口未打开")?;
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| {
            state.tabs.lock().unwrap().remove(id);
            e.to_string()
        })?;
    view.hide().map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(1280.0, 800.0))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    attach_popup_handler(&view, app.clone(), session.to_string())?;
    #[cfg(target_os = "windows")]
    windows_downloads::attach(&view, dl_app, dl_session)?;
    if !is_popup { state
        .active
        .lock()
        .unwrap()
        .insert(session.into(), id.into()); }
    Ok(tab)
}

// Keep COM event arguments on the UI thread. Returning Deny and independently
// navigating another view loses the opener's window handle, delayed navigation,
// POST body and referrer. Hand WebView2 the actual related child view instead.
#[cfg(target_os = "windows")]
struct PendingPopup {
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NewWindowRequestedEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    environment: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
}
#[cfg(target_os = "windows")]
thread_local! {
    static PENDING_POPUPS: std::cell::RefCell<HashMap<String, PendingPopup>> = std::cell::RefCell::new(HashMap::new());
}
#[cfg(target_os = "windows")]
fn attach_popup_handler(view: &Webview, app: tauri::AppHandle, session: String) -> Result<(), String> {
    let source_label = view.label().to_string();
    view.with_webview(move |platform| {
        let environment = platform.environment();
        let handler_app = app.clone();
        let handler_session = session.clone();
        let handler_label = source_label.clone();
        let handler = webview2_com::NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            log::info!("Browser popup event: source={}", handler_label);
            let Some(args) = args else { return Ok(()) };
            let mut raw = windows::core::PWSTR::null();
            unsafe { args.Uri(&mut raw)?; args.SetHandled(true)?; }
            let text = webview2_com::take_pwstr(raw);
            let Ok(url) = text.parse::<tauri::Url>() else { log::warn!("Browser popup URL could not be parsed"); return Ok(()) };
            if !allowed_url(&url) { log::warn!("Browser popup protocol rejected: {}", url.scheme()); return Ok(()) }
            let id = format!("popup-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
            let pending = PendingPopup { args: args.clone(), deferral: unsafe { args.GetDeferral()? }, environment: environment.clone() };
            PENDING_POPUPS.with(|items| items.borrow_mut().insert(id.clone(), pending));
            let app = handler_app.clone();let session = handler_session.clone();let pending_id = id.clone();
            let opener_label = handler_label.clone();
            let queued = handler_app.run_on_main_thread(move || {
                log::info!("Browser popup queued: {}", id);
                let environment = PENDING_POPUPS.with(|items| items.borrow().get(&id).map(|p| p.environment.clone()));
                let Some(environment) = environment else { log::error!("Browser popup pending context missing: {}", id); return };
                let builder = WebviewBuilder::new(format!("wing-browser-{}", id), WebviewUrl::External("about:blank".parse().unwrap())).with_environment(environment);
                // add_child waits for a main-thread dispatch; never block that
                // thread while constructing the child.
                std::thread::spawn(move || {
                let result = tauri::async_runtime::block_on(create_tab_with_builder(&app, &session, &id, url, Some(builder)));
                match result.and_then(|tab| app.get_webview(&tab.label).ok_or("新标签页未创建".into())) {
                    Ok(child) => {
                        log::info!("Browser popup child created: {}", id);
                        let callback_id = id.clone();let callback_app = app.clone();let callback_session = session.clone();
                        let result = child.with_webview(move |child| {
                            if let Some(pending) = PENDING_POPUPS.with(|items| items.borrow_mut().remove(&callback_id)) {
                                let result = unsafe { child.controller().CoreWebView2().and_then(|core| pending.args.SetNewWindow(&core)) };
                                log::info!("Browser popup attached: {} success={}", callback_id, result.is_ok());
                                let completed = unsafe { pending.deferral.Complete() };
                                let result = result.and(completed);
                                match result {
                                    Ok(()) => {
                                        let state = callback_app.state::<BrowserState>();
                                        if let Some(tab) = state.tabs.lock().unwrap().get_mut(&callback_id) {
                                            tab.opener_label = Some(opener_label);
                                        }
                                        // Keep the source visible until the popup is actually attached.
                                        state.active.lock().unwrap().insert(callback_session, callback_id);
                                    }
                                    Err(error) => fail_popup(&callback_app, &callback_session, &callback_id, error.to_string()),
                                }
                            }
                        });
                        if let Err(error) = result { queue_popup_failure(&app, session, id, error.to_string()); }
                    }
                    Err(error) => queue_popup_failure(&app, session, id, error),
                }
                });
            });
            if let Err(error) = queued { fail_popup(&handler_app, &handler_session, &pending_id, error.to_string()); }
            Ok(())
        }));
        let mut token = 0;
        let result = unsafe { platform.controller().CoreWebView2().and_then(|core| core.add_NewWindowRequested(&handler, &mut token)) };
        log::info!("Browser popup handler registered: source={} success={}", source_label, result.is_ok());
        if let Err(error) = result { app.state::<BrowserState>().errors.lock().unwrap().insert(session, format!("新标签页处理不可用：{}", error)); }
    }).map_err(|e| e.to_string())
}
#[cfg(target_os = "windows")]
fn queue_popup_failure(app: &tauri::AppHandle, session: String, id: String, error: String) {
    let target = app.clone();
    let _ = app.run_on_main_thread(move || fail_popup(&target, &session, &id, error));
}
#[cfg(target_os = "windows")]
fn fail_popup(app: &tauri::AppHandle, session: &str, id: &str, error: String) {
    if let Some(pending) = PENDING_POPUPS.with(|items| items.borrow_mut().remove(id)) {
        let _ = unsafe { pending.deferral.Complete() };
    }
    if let Some(view) = app.get_webview(&format!("wing-browser-{}", id)) { let _ = view.close(); }
    app.state::<BrowserState>().tabs.lock().unwrap().remove(id);
    app.state::<BrowserState>().errors.lock().unwrap().insert(session.into(), format!("无法打开新标签页：{}", error));
}

#[tauri::command]
pub async fn native_browser_command(
    app: tauri::AppHandle,
    webview: Webview,
    command: Command,
) -> Result<Value, String> {
    trusted(&webview)?;
    let session = &command.session_id;
    if !valid_id(session) {
        return Err("无效的浏览器会话".into());
    }
    load_download_history(&app, session);
    let state = app.state::<BrowserState>();
    let args = &command.args;
    if command.op == "focus-shell" {
        webview.set_focus().map_err(|e| e.to_string())?;
        return Ok(json!({}));
    }
    if command.op == "state" {
        #[cfg(target_os = "windows")]
        windows_downloads::poll(&app, session).await?;
        let mut tabs: Vec<_> = state
            .tabs
            .lock()
            .unwrap()
            .values()
            .filter(|t| &t.session_id == session)
            .cloned()
            .collect();
        tabs.sort_by_key(|t| t.created_at);
        let downloads: Vec<_> = state
            .downloads
            .lock()
            .unwrap()
            .iter()
            .filter(|d| &d.session_id == session)
            .cloned()
            .collect();
        let active_id = state.active.lock().unwrap().get(session).cloned();
        let error = state.errors.lock().unwrap().remove(session);
        let mut value = json!({"tabs":tabs,"downloads":downloads,"activePageId":active_id,"error":error});
        if args["inspect"] == true {
            if let Ok(tab) = active(&app, session, None) {
                if !tab.loading {
                    if let Some(view) = app.get_webview(&tab.label) {
                        #[cfg(target_os = "windows")]
                        if let Ok(zoom) = native_zoom(&view).await {
                            if let Some(current) = state.tabs.lock().unwrap().get_mut(&tab.id) {
                                current.zoom = zoom;
                            }
                            if let Some(tabs) = value["tabs"].as_array_mut() {
                                for item in tabs.iter_mut().filter(|t| t["id"] == tab.id) {
                                    item["zoom"] = json!(zoom);
                                }
                            }
                        }
                        if let Ok(Ok(meta)) = tokio::time::timeout(
                            Duration::from_millis(200),
                            evaluate(&view, "metadata", &json!({})),
                        )
                        .await
                        {
                            value["metadata"] = meta;
                        }
                    }
                }
            }
        }
        return Ok(value);
    }
    if command.op == "download" {
        let downloads = state.downloads.lock().unwrap();
        let item = downloads
            .iter()
            .find(|d| {
                d.session_id == *session
                    && Some(d.id.as_str()) == args["id"].as_str()
                    && d.status == "ready"
            })
            .ok_or("下载文件不可用")?;
        return Ok(json!({"path":item.path,"name":item.name}));
    }
    if command.op == "remove-download" {
        let id = args["id"].as_str().ok_or("需要下载记录标识")?;
        let mut downloads = state.downloads.lock().unwrap();
        let index = downloads.iter().position(|d| d.session_id == *session && d.id == id)
            .ok_or("下载记录不存在")?;
        if downloads[index].status == "pending" {
            return Err("下载正在进行，完成后可以移除记录".into());
        }
        // Removing history must never delete the downloaded file.
        downloads.remove(index);
        drop(downloads);
        save_download_history(&app, session)?;
        return Ok(json!({}));
    }
    if command.op == "clear-downloads" {
        state.downloads.lock().unwrap().retain(|d| d.session_id != *session || d.status == "pending");
        save_download_history(&app, session)?;
        return Ok(json!({}));
    }
    if command.op == "navigate" {
        let url: tauri::Url = args["url"]
            .as_str()
            .ok_or("需要网址")?
            .parse()
            .map_err(|_| "无效的网址")?;
        if !allowed_url(&url) {
            return Err("不支持的网址协议".into());
        }
        let page_id = args["pageId"].as_str();
        let tab = match active(&app, session, page_id) {
            Ok(tab) => {
                if let Some(current) = state.tabs.lock().unwrap().get_mut(&tab.id) {
                    current.loading = true;
                    current.url = url.to_string();
                }
                app.get_webview(&tab.label)
                    .ok_or("页面已关闭")?
                    .navigate(url)
                    .map_err(|e| e.to_string())?;
                tab
            }
            Err(_) => {
                let id = page_id.map(str::to_string).unwrap_or_else(|| {
                    format!(
                        "tab-{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_nanos()
                    )
                });
                create_tab(&app, session, &id, url).await?
            }
        };
        state
            .active
            .lock()
            .unwrap()
            .insert(session.into(), tab.id.clone());
        return Ok(json!({"pageId":tab.id}));
    }
    if command.op == "close" && args["all"] == true {
        let tabs: Vec<_> = state
            .tabs
            .lock()
            .unwrap()
            .values()
            .filter(|t| &t.session_id == session)
            .cloned()
            .collect();
        for tab in tabs {
            if let Some(view) = app.get_webview(&tab.label) {
                let _ = view.close();
            }
            state.tabs.lock().unwrap().remove(&tab.id);
        }
        state.active.lock().unwrap().remove(session);
        return Ok(json!({"closed":true}));
    }
    let tab = active(&app, session, args["pageId"].as_str())?;
    if args["requireActive"] == true
        && state.active.lock().unwrap().get(session) != Some(&tab.id) {
        return Err("目标标签页不是当前活动页，请先 activate 并重新观察；未发送输入".into());
    }
    let view = app.get_webview(&tab.label).ok_or("页面已关闭")?;
    match command.op.as_str() {
        #[cfg(target_os = "windows")]
        "download-dialog" => {
            use windows::core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_9;
            let (send, receive) = tokio::sync::oneshot::channel();
            view.with_webview(move |platform| {
                let result = unsafe { platform.controller().CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_9>())
                    .and_then(|core| { core.OpenDefaultDownloadDialog()?; let mut opened = Default::default(); core.IsDefaultDownloadDialogOpen(&mut opened)?; Ok(opened.as_bool()) }) };
                let _ = send.send(result.map_err(|e| e.to_string()));
            }).map_err(|e| e.to_string())?;
            let opened = receive.await.map_err(|e| e.to_string())??;
            Ok(json!({"opened":opened}))
        }
        "activate" => {
            state
                .active
                .lock()
                .unwrap()
                .insert(session.into(), tab.id.clone());
            Ok(json!({"pageId":tab.id}))
        }
        "close" => {
            view.close().map_err(|e| e.to_string())?;
            state.tabs.lock().unwrap().remove(&tab.id);
            let next = state
                .tabs
                .lock()
                .unwrap()
                .values()
                .find(|t| &t.session_id == session)
                .map(|t| t.id.clone());
            let mut active = state.active.lock().unwrap();
            active.remove(session);
            if let Some(next) = next {
                active.insert(session.into(), next);
            }
            Ok(json!({"closed":true}))
        }
        "zoom" => {
            let scale = args["scale"]
                .as_f64()
                .filter(|s| s.is_finite() && *s >= 0.25 && *s <= 5.0)
                .ok_or("缩放范围为 25%–500%")?;
            view.set_zoom(scale).map_err(|e| e.to_string())?;
            if let Some(t) = state.tabs.lock().unwrap().get_mut(&tab.id) {
                t.zoom = scale;
            }
            Ok(json!({"zoom":scale}))
        }
        "snapshot" => {
            // Wait for a navigated document, without blocking user input or painting.
            for _ in 0..30 {
                if args["waitForLoad"] == false { break; }
                if !state
                    .tabs
                    .lock()
                    .unwrap()
                    .get(&tab.id)
                    .map(|t| t.loading)
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let mut value = evaluate(&view, "snapshot", args).await?;
            // Dynamic sites may paint results just after the load event. Wait briefly
            // for actual content instead of returning a misleading empty observation.
            for _ in 0..20 {
                if args["waitForLoad"] == false { break; }
                if value["url"] == "about:blank"
                    || !value["elements"]
                        .as_array()
                        .map(|e| e.is_empty())
                        .unwrap_or(true)
                    || !value["pageText"].as_str().unwrap_or("").trim().is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                value = evaluate(&view, "snapshot", args).await?;
            }
            value["pageId"] = json!(tab.id);
            #[cfg(target_os = "windows")]
            if args["screenshot"] != false {
                match cdp(
                    &view,
                    "Page.captureScreenshot",
                    json!({"format":"jpeg","quality":85,"captureBeyondViewport":false}),
                )
                .await
                {
                    Ok(capture) => value["screenshot"] = capture["data"].clone(),
                    Err(error) => value["screenshotError"] = json!(error),
                }
            }
            Ok(value)
        }
        "annotate" | "element" | "metadata" | "click" | "fill" | "type" | "key" | "select"
        | "hover" | "scroll" | "upload" | "back" | "forward" | "reload" => {
            let started_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_micros() as u64;
            #[cfg(target_os = "windows")]
            let result = if matches!(
                command.op.as_str(),
                "click" | "fill" | "type" | "key" | "hover" | "scroll"
            ) {
                native_input(&view, &command.op, args).await
            } else {
                evaluate(&view, &command.op, args).await
            };
            #[cfg(not(target_os = "windows"))]
            let result = evaluate(&view, &command.op, args).await;
            if matches!(
                command.op.as_str(),
                "click" | "key" | "back" | "forward" | "reload"
            ) {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let popup = state.tabs.lock().unwrap().values()
                .filter(|t| t.session_id == *session && t.created_at >= started_at
                    && t.opener_label.as_deref() == Some(tab.label.as_str()))
                .max_by_key(|t| t.created_at).map(|t| t.id.clone());
            match (result, popup) {
                (Ok(_), Some(page_id)) => Ok(json!({"pageId":page_id})),
                // WebView2 may stop acknowledging the source's input when a popup
                // hides it. Only an actually attached child from this action proves success.
                (Err(error), Some(page_id)) if error == "网页操作超时" => Ok(json!({"pageId":page_id})),
                (result, _) => result,
            }
        }
        _ => Err("不支持的内置浏览器命令".into()),
    }
}

#[tauri::command]
pub async fn native_browser_bounds(
    app: tauri::AppHandle,
    webview: Webview,
    bounds: Bounds,
) -> Result<(), String> {
    trusted(&webview)?;
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite())
    {
        return Err("无效的浏览器尺寸".into());
    }
    let tabs: Vec<_> = app
        .state::<BrowserState>()
        .tabs
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    for tab in tabs {
        if let Some(view) = app.get_webview(&tab.label) {
            if bounds.visible
                && bounds.page_id.as_deref() == Some(&tab.id)
                && bounds.width >= 1.0
                && bounds.height >= 1.0
            {
                view.set_position(LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)))
                    .map_err(|e| e.to_string())?;
                view.set_size(LogicalSize::new(
                    bounds.width.max(1.0),
                    bounds.height.max(1.0),
                ))
                .map_err(|e| e.to_string())?;
                view.show().map_err(|e| e.to_string())?;
            } else {
                view.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
