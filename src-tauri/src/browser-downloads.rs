//! Track the native operation by ID, not URL/path (redirects and path normalization
//! can change both). WebView2 supplies authoritative progress and terminal states.
use super::{save_download_history, BrowserState, Download};
use std::{cell::RefCell, collections::HashMap, path::PathBuf};
use tauri::{Manager, Webview};
use webview2_com::{BytesReceivedChangedEventHandler, DownloadStartingEventHandler, StateChangedEventHandler, take_pwstr};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{HSTRING, Interface, IUnknown, PWSTR};

thread_local! {
    // Keep operations alive even when the page navigates away.
    static ACTIVE: RefCell<HashMap<String, (String, ICoreWebView2DownloadOperation)>> = RefCell::new(HashMap::new());
    static RETIRED: RefCell<HashMap<String, Vec<ICoreWebView2DownloadOperation>>> = RefCell::new(HashMap::new());
}

// Some WebView2 retry paths miss StateChanged. Reconcile the actual operation
// state on the UI thread as well, so event loss cannot leave stale history rows.
pub(super) async fn poll(app: &tauri::AppHandle, session: &str) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let target = app.clone(); let session = session.to_string();
    app.run_on_main_thread(move || {
        let operations: Vec<_> = ACTIVE.with(|items| items.borrow().iter()
            .filter(|(_, (owner, _))| owner == &session).map(|(id, (_, op))| (id.clone(), op.clone())).collect());
        for (id, op) in operations {
            if let Err(error) = refresh(&target, &session, &id, &op) {
                if let Some(item) = target.state::<BrowserState>().downloads.lock().unwrap().iter_mut().find(|d| d.id == id) {
                    item.status = "failed".into(); item.error = Some(format!("下载连接已失效：{}", error));
                }
                ACTIVE.with(|items| items.borrow_mut().remove(&id));
                RETIRED.with(|items| items.borrow_mut().remove(&id));
                let _ = save_download_history(&target, &session);
            }
        }
        let _ = send.send(());
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())
}

fn refresh(app: &tauri::AppHandle, session: &str, id: &str, op: &ICoreWebView2DownloadOperation) -> windows::core::Result<()> {
    let mut received = 0;
    let mut total = 0;
    let mut status = COREWEBVIEW2_DOWNLOAD_STATE::default();
    unsafe { op.BytesReceived(&mut received)?; op.TotalBytesToReceive(&mut total)?; op.State(&mut status)?; }
    let terminal = status != COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
    {
        let state = app.state::<BrowserState>();
        let mut list = state.downloads.lock().unwrap();
        if let Some(item) = list.iter_mut().find(|d| d.id == id && d.session_id == session) {
            item.bytes = Some(received.max(0) as u64);
            item.total_bytes = (total > 0).then_some(total as u64);
            if status == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                let mut path = PWSTR::null();
                unsafe { op.ResultFilePath(&mut path)?; }
                item.path = take_pwstr(path);
                item.status = "ready".into();
                item.error = None;
            } else if status == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                unsafe { op.InterruptReason(&mut reason)?; }
                item.status = "failed".into();
                item.error = Some(format!("下载中断（浏览器错误 {}）", reason.0));
            }
        }
    }
    if terminal {
        ACTIVE.with(|items| items.borrow_mut().remove(id));
        RETIRED.with(|items| items.borrow_mut().remove(id));
        if let Err(error) = save_download_history(app, session) { log::warn!("Saving download status: {}", error); }
    }
    Ok(())
}

fn retry_matches(op: &ICoreWebView2DownloadOperation, source: &std::path::Path, url: &str) -> windows::core::Result<bool> {
    let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
    unsafe { op.InterruptReason(&mut reason)?; }
    if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE { return Ok(false); }
    let mut raw_path = PWSTR::null(); let mut raw_url = PWSTR::null();
    unsafe { op.ResultFilePath(&mut raw_path)?; }
    let path = PathBuf::from(take_pwstr(raw_path));
    unsafe { op.Uri(&mut raw_url)?; }
    Ok(path == source && take_pwstr(raw_url) == url)
}

pub(super) fn attach(view: &Webview, app: tauri::AppHandle, session: String) -> Result<(), String> {
    view.with_webview(move |platform| {
        let handler_app = app.clone();
        let handler_session = session.clone();
        let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let result = (|| -> windows::core::Result<()> {
                let op = unsafe { args.DownloadOperation()? };
                let identity = op.cast::<IUnknown>()?;
                let mut raw_path = PWSTR::null();
                let mut raw_url = PWSTR::null();
                unsafe { args.ResultFilePath(&mut raw_path)?; op.Uri(&mut raw_url)?; }
                let source = PathBuf::from(take_pwstr(raw_path));
                let url = take_pwstr(raw_url);
                // WebView2 may replace an interrupted operation during automatic retry,
                // leaving the old object IN_PROGRESS with an interrupt reason. Match
                // destination, URL and interruption, never merge healthy concurrent jobs.
                let previous = ACTIVE.with(|items| items.borrow().iter()
                    .find(|(_, (owner, existing))| owner == &handler_session &&
                        (existing.cast::<IUnknown>().is_ok_and(|value| value == identity) ||
                         retry_matches(existing, &source, &url).unwrap_or(false)))
                    .map(|(id, _)| id.clone()));
                let folder = handler_app.path().download_dir().map_err(|_| windows::core::Error::from_win32())?;
                let original = source.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let mut path = folder.join(&original);
                let mut n = 1;
                let state = handler_app.state::<BrowserState>();
                let mut list = state.downloads.lock().unwrap();
                if let Some(item) = list.iter().find(|d| Some(&d.id) == previous.as_ref()) { path = PathBuf::from(&item.path); }
                // Reserve destinations across concurrent downloads, before files exist.
                while previous.is_none() && (path.exists() || list.iter().any(|d| d.status == "pending" && d.path == path.to_string_lossy())) {
                    path = folder.join(format!("{}-{}", n, original)); n += 1;
                }
                // Executable downloads can require the browser's Keep/Discard UI.
                // Do not hide that prompt or bypass its security policy.
                let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
                let executable = matches!(extension.as_str(), "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appxbundle" | "com" | "scr" | "bat" | "cmd" | "ps1" | "vbs" | "js" | "jar" | "reg" | "iso");
                unsafe { args.SetResultFilePath(&HSTRING::from(path.as_os_str()))?; args.SetHandled(!executable)?; }
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                let id = previous.clone().unwrap_or_else(|| format!("download-{}", now.as_nanos()));
                if previous.is_none() { list.push(Download { id: id.clone(), session_id: handler_session.clone(),
                    name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(), status: "pending".into(), url,
                    created_at: now.as_millis() as u64, bytes: Some(0), total_bytes: None, error: None }); }
                drop(list);
                let mut token = 0;
                // The event sender may be a fresh COM wrapper. Compare the subscribed
                // operation generation, not the sender's COM identity.
                let generation = op.as_raw() as usize;
                let old = ACTIVE.with(|items| items.borrow_mut().insert(id.clone(), (handler_session.clone(), op.clone())));
                // Retain wrappers from automatic retries until the logical transfer
                // ends: releasing them early can detach the engine's final event.
                if let Some((_, old)) = old { RETIRED.with(|items| items.borrow_mut().entry(id.clone()).or_default().push(old)); }
                refresh(&handler_app, &handler_session, &id, &op)?;
                let progress_app = handler_app.clone(); let progress_session = handler_session.clone(); let progress_id = id.clone();
                unsafe { op.add_BytesReceivedChanged(&BytesReceivedChangedEventHandler::create(Box::new(move |op, _| {
                    let current = ACTIVE.with(|items| items.borrow().get(&progress_id).is_some_and(|(_, active)| active.as_raw() as usize == generation));
                    if current { if let Some(op) = op { refresh(&progress_app, &progress_session, &progress_id, &op)?; } } Ok(())
                })), &mut token)?; }
                let finish_app = handler_app.clone(); let finish_session = handler_session.clone(); let finish_id = id.clone();
                unsafe { op.add_StateChanged(&StateChangedEventHandler::create(Box::new(move |op, _| {
                    let current = ACTIVE.with(|items| items.borrow().get(&finish_id).is_some_and(|(_, active)| active.as_raw() as usize == generation));
                    if current { if let Some(op) = op { refresh(&finish_app, &finish_session, &finish_id, &op)?; } } Ok(())
                })), &mut token)?; }
                if let Err(error) = save_download_history(&handler_app, &handler_session) { log::warn!("Saving download: {}", error); }
                Ok(())
            })();
            if let Err(error) = &result {
                let _ = unsafe { args.SetCancel(true) };
                handler_app.state::<BrowserState>().errors.lock().unwrap().insert(handler_session.clone(), format!("无法开始下载：{}", error));
            }
            result
        }));
        let mut token = 0;
        let result = unsafe { platform.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_4>()).and_then(|core| core.add_DownloadStarting(&handler, &mut token)) };
        if let Err(error) = result { app.state::<BrowserState>().errors.lock().unwrap().insert(session, format!("下载处理不可用：{}", error)); }
    }).map_err(|e| e.to_string())
}
