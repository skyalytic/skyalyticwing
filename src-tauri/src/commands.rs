use serde::Serialize;

#[derive(Serialize)]
pub struct ServerStatus {
    running: bool,
    port: u16,
}

// M-G10 fix: 改为 async 命令，避免同步 IPC 命令阻塞 Tauri 主线程最多 500ms。
// 之前 `pub fn get_server_status()` 是同步命令，connect_timeout(500ms) 期间主线程阻塞。
#[tauri::command]
pub async fn get_server_status() -> ServerStatus {
    let port = crate::sidecar::get_server_port();
    // M17: 使用 connect_timeout 避免长时间阻塞 IPC
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    // 在阻塞线程池中执行 TCP 连接检查，避免阻塞 Tauri 主线程。
    let running = tokio::task::spawn_blocking(move || {
        std::net::TcpStream::connect_timeout(
            &addr,
            std::time::Duration::from_millis(500),
        ).is_ok()
    }).await.unwrap_or(false);
    ServerStatus { running, port }
}

#[tauri::command]
pub async fn start_server(app: tauri::AppHandle) -> Result<String, String> {
    // H2: 检查是否已有服务器进程在运行，避免重复 spawn 导致孤儿进程
    if crate::sidecar::is_server_running() {
        return Ok("Server already running".to_string());
    }
    // M-G1 fix: start_node_server 现在返回 Result，spawn 失败时返回错误让 IPC 调用方感知。
    // M-G2 fix: start_node_server 始终使用端口 910（与 webview URL 一致），端口被占用时返回错误。
    crate::sidecar::start_node_server(&app).await.map_err(|e| {
        log::error!("[start_server] Failed to start server: {}", e);
        e
    })?;
    Ok("Server starting...".to_string())
}

#[tauri::command]
pub fn stop_server() -> Result<String, String> {
    crate::sidecar::stop_node_server();
    Ok("Server stopped".to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<String>, String> {
    crate::update::check(&app, false).await
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    crate::update::install(&app).await
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
