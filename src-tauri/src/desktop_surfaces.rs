use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicU64, Ordering};

static SURFACES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static EFFECTS_EPOCH: AtomicU64 = AtomicU64::new(0);

fn passive(app: &tauri::AppHandle, label: &str, route: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) { return Ok(w); }
    let url = format!("http://127.0.0.1:{}{}", crate::sidecar::get_server_port(), route)
        .parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let allowed = url.clone();
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Wing · 桌面提示").inner_size(32., 36.).decorations(false)
        .transparent(true).shadow(false).always_on_top(true).visible_on_all_workspaces(true)
        .skip_taskbar(true).focusable(false).focused(false).visible(false)
        .on_navigation(move |next| next == &allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    w.remove_menu().map_err(|e| e.to_string())?;
    w.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(w)
}

// Decorative surfaces track the OS pointer; they have no input injection capability.
async fn effects(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let epoch = EFFECTS_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    for (label, w) in app.webview_windows() {
        if label.starts_with("wing-screen-edge-") || label == "wing-pointer-accent" { let _ = w.hide(); }
    }
    if !visible { return Ok(()); }
    for (index, monitor) in app.available_monitors().map_err(|e| e.to_string())?.iter().enumerate() {
        let p=monitor.position(); let s=monitor.size(); let d=(8. * monitor.scale_factor()) as u32;
        let frames=[(p.x,p.y,s.width,d,180), (p.x,p.y+s.height as i32-d as i32,s.width,d,0),
            (p.x,p.y,d,s.height,90), (p.x+s.width as i32-d as i32,p.y,d,s.height,270)];
        for (edge,(x,y,width,height,angle)) in frames.iter().enumerate() {
            let w=passive(app,&format!("wing-screen-edge-{index}-{edge}"),&format!("/?wingSurface=edge&angle={angle}"))?;
            w.set_position(tauri::PhysicalPosition::new(*x,*y)).map_err(|e| e.to_string())?;
            w.set_size(tauri::PhysicalSize::new(*width,*height)).map_err(|e| e.to_string())?;
            w.show().map_err(|e| e.to_string())?;
        }
    }
    let pointer=passive(app,"wing-pointer-accent","/?wingSurface=pointer")?;
    let app=app.clone();
    tauri::async_runtime::spawn(async move {
        while EFFECTS_EPOCH.load(Ordering::SeqCst)==epoch {
            if let Ok(point)=app.cursor_position() {
                let _=pointer.set_position(tauri::PhysicalPosition::new(point.x as i32,point.y as i32));
                let _=pointer.show();
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    });
    Ok(())
}

/// Only the authenticated local main view can show these fixed routes.
#[tauri::command]
pub async fn desktop_surface(app: tauri::AppHandle, webview: Webview, surface: String, visible: bool) -> Result<(), String> {
    let _guard = SURFACES.lock().await;
    let caller=webview.url().map_err(|e|e.to_string())?;
    if webview.label()!="main" || caller.scheme()!="http" || caller.host_str()!=Some("127.0.0.1")
        || caller.port()!=Some(crate::sidecar::get_server_port()) { return Err("仅 Wing 主界面可管理桌面提示".into()); }
    if surface=="effects" { return effects(&app,visible).await; }
    let (label,route,title,width,height)=match surface.as_str() {
        "approval" => ("wing-approval","/?wingSurface=approval","Wing · 待审批",560.,540.),
        "control" => ("wing-desktop-control","/?wingSurface=control","Wing · 桌面控制",450.,70.),
        _ => return Err("未知提示窗口".into()),
    };
    if !visible { if let Some(w)=app.get_webview_window(label) { w.hide().map_err(|e|e.to_string())?; } return Ok(()); }
    let window=if let Some(w)=app.get_webview_window(label) {w} else {
        let url=format!("http://127.0.0.1:{}{}",crate::sidecar::get_server_port(),route).parse::<tauri::Url>().map_err(|e|e.to_string())?;
        let allowed=url.clone();
        let w=WebviewWindowBuilder::new(&app,label,WebviewUrl::External(url))
            .title(title).inner_size(width,height).min_inner_size(width,height).resizable(surface=="approval")
            .decorations(false).transparent(surface=="control").shadow(surface=="approval")
            .always_on_top(true).visible_on_all_workspaces(true).skip_taskbar(surface!="approval")
            .focusable(true).focused(false).visible(false).center()
            .on_navigation(move |next|next==&allowed)
            .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
            .build().map_err(|e|e.to_string())?;
        #[cfg(not(target_os="macos"))]
        w.remove_menu().map_err(|e|e.to_string())?;
        if surface=="control" { if let Some(monitor)=w.primary_monitor().map_err(|e|e.to_string())? {
            let area=monitor.work_area(); let size=w.outer_size().map_err(|e|e.to_string())?;
            w.set_position(tauri::PhysicalPosition::new(area.position.x+(area.size.width as i32-size.width as i32).max(0)/2,area.position.y+12)).map_err(|e|e.to_string())?;
        }}
        w
    };
    window.show().map_err(|e|e.to_string())?;
    if surface=="approval" { let _=window.request_user_attention(Some(tauri::UserAttentionType::Critical)); }
    Ok(())
}
