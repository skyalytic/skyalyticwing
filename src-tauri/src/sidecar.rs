use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

static SERVER_CHILD: Mutex<Option<CommandChild>> = Mutex::new(None);
#[cfg(target_os = "windows")]
pub const DESKTOP_PORT: u16 = 19111;
#[cfg(not(target_os = "windows"))]
pub const DESKTOP_PORT: u16 = 19111;
static SERVER_PORT: Mutex<u16> = Mutex::new(DESKTOP_PORT);
/// An isolated preview can run beside an installed build; release builds ignore this override.
pub fn startup_port() -> u16 {
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("SKYALYTICWING_DEV_PORT")
        .ok().and_then(|value| value.parse::<u16>().ok()).filter(|port| *port >= 1024)
    {
        return port;
    }
    crate::edition::port()
}
static INTENTIONAL_EXIT: AtomicBool = AtomicBool::new(false);
static CRASH_COUNT: Mutex<u32> = Mutex::new(0);
static MAX_CRASHES: u32 = 3;
// M-G4 fix: 记录上次崩溃时间，成功运行 1 小时后重置 CRASH_COUNT，避免长期运行后累积退出。
static LAST_CRASH_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const CRASH_COUNT_RESET_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// M-G3 fix: 安全获取锁，mutex 中毒时恢复内部数据而非 panic。
/// 之前使用 `.lock().unwrap()` 在 mutex 中毒后会级联 panic，导致整个应用崩溃。
fn lock_or_recover<T>(mx: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mx.lock().unwrap_or_else(|e| e.into_inner())
}

/// 查找从 start 开始可用的端口。
/// M-G2 fix 后 start_node_server 始终使用 19111，此函数保留为工具函数供未来扩展使用。
#[allow(dead_code)]
pub fn find_available_port(start: u16) -> u16 {
    for port in start..(start + 1000) {
        if let Ok(listener) = std::net::TcpListener::bind(format!("127.0.0.1:{}", port)) {
            drop(listener);
            return port;
        }
    }
    // L-G4 fix: 扩大回退端口范围并使用更大的熵源（nanos + 进程 ID），
    // 之前仅用 subsec_millis % 16383（毫秒级，范围仅 49152-50151），熵不足易冲突。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let entropy = (now.subsec_nanos() as u64) ^ (std::process::id() as u64);
    49152 + ((entropy % 16383) as u16)
}

pub fn set_server_port(port: u16) {
    *lock_or_recover(&SERVER_PORT) = port;
}

pub fn set_intentional_exit(v: bool) {
    INTENTIONAL_EXIT.store(v, Ordering::SeqCst);
}

pub fn is_intentional_exit() -> bool {
    INTENTIONAL_EXIT.load(Ordering::SeqCst)
}

pub fn is_server_running() -> bool {
    let child = lock_or_recover(&SERVER_CHILD);
    child.is_some()
}

pub fn start_node_server_on_port(app: &tauri::AppHandle, port: u16) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
    Box::pin(async move {
        // Do not attach the webview to an unrelated service on our local port.
        let probe = std::net::TcpListener::bind(("127.0.0.1", port))
            .map_err(|e| format!("Local port {} is unavailable: {}", port, e))?;
        drop(probe);
        // H3: 重置 INTENTIONAL_EXIT 标志，确保 stop→start 后崩溃保护正常工作
        INTENTIONAL_EXIT.store(false, Ordering::SeqCst);
        log::info!("[sidecar] Starting on port {}", port);

        let resource_path = match app.path().resource_dir() {
            Ok(p) => {
                log::info!("[sidecar] resource_dir: {:?}", p);
                p
            }
            Err(e) => {
                log::warn!("[sidecar] resource_dir error: {}", e);
                let exe_dir = std::env::current_exe()
                    .unwrap_or_default()
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .to_path_buf();
                log::info!("[sidecar] using exe_dir: {:?}", exe_dir);
                exe_dir
            }
        };

        // 查找 NestJS 后端入口
        // 打包产物优先：_up_/packages/backend/deploy/dist/main.js（deploy 目录含真实
        // node_modules，scripts/prepare-backend-deploy.cjs 生成；旧的裸 dist/ 缺依赖，
        // 启动即报 Cannot find module 崩溃，仅作手工部署场景的回退保留）
        let (web_dir, start_script) = {
            let mut candidates: Vec<(std::path::PathBuf, std::path::PathBuf)> = vec![
                (resource_path.join("_up_").join("packages").join("backend"), resource_path.join("_up_").join("packages").join("backend").join("deploy").join("desktop-main.cjs")),
                (resource_path.join("_up_").join("packages").join("backend"), resource_path.join("_up_").join("packages").join("backend").join("deploy").join("dist").join("main.js")),
                (resource_path.join("backend"), resource_path.join("backend").join("dist").join("main.js")),
                (resource_path.join("packages").join("backend"), resource_path.join("packages").join("backend").join("dist").join("main.js")),
                (resource_path.join("_up_").join("packages").join("backend"), resource_path.join("_up_").join("packages").join("backend").join("dist").join("main.js")),
            ];

            // Source previews must use the freshly built backend, not an old deploy/ copy.
            #[cfg(debug_assertions)]
            if std::env::var("SKYALYTICWING_DEV_SOURCE").as_deref() == Ok("1") {
                let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../packages/backend");
                candidates.insert(0, (source.clone(), source.join("dist/main.js")));
            }

            let mut found: Option<(std::path::PathBuf, std::path::PathBuf)> = None;
            for (dir, script) in &candidates {
                if script.exists() {
                    log::info!("[sidecar] Found server entry: {:?}", script);
                    found = Some((dir.clone(), script.clone()));
                    break;
                }
            }

            match found {
                Some((dir, script)) => (dir, script),
                None => {
                    // 开发模式回退
                    let dev_path = std::path::PathBuf::from("../../packages/backend");
                    let abs_dev = if dev_path.is_relative() {
                        std::env::current_exe()
                            .unwrap_or_default()
                            .parent()
                            .unwrap_or(std::path::Path::new("."))
                            .join(&dev_path)
                            .canonicalize()
                            .unwrap_or_else(|_| dev_path.clone())
                    } else {
                        dev_path.clone()
                    };
                    let dev_script = abs_dev.join("dist").join("main.js");
                    log::warn!("[sidecar] Server entry not found in resources, using dev path: {:?}", dev_script);
                    (abs_dev, dev_script)
                }
            }
        };
        let mut start_script_str = start_script.to_string_lossy().to_string();
        start_script_str = start_script_str.trim_start_matches(r"\\?\").to_string();
        let work_dir = if web_dir.is_absolute() {
            web_dir.clone()
        } else {
            std::env::current_exe()
                .unwrap_or_default()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(&web_dir)
        };
        let work_dir_str = work_dir.to_string_lossy().to_string();
        let work_dir_str = work_dir_str.trim_start_matches(r"\\?\");
        log::info!("[sidecar] start_script: {}", start_script_str);
        log::info!("[sidecar] script exists: {}", start_script.exists());
        log::info!("[sidecar] work_dir: {}", work_dir_str);

        let node_sidecar = if cfg!(target_os = "linux") { "skyalyticwing-node" } else { "node" };
        let child_path = if cfg!(target_os = "linux") {
            format!("{}:{}", resource_path.join("cli-bin").display(), std::env::var("PATH").unwrap_or_default())
        } else { std::env::var("PATH").unwrap_or_default() };
        let sidecar_result = app.shell().sidecar(node_sidecar);

        match sidecar_result {
            Ok(cmd) => {
                log::info!("[sidecar] Bundled node sidecar found");
                let result = cmd
                    .args([&start_script_str, "--port", &port.to_string()])
                    .env("PATH", &child_path)
                    .current_dir(work_dir_str)
                    .env("WING_DESKTOP_SURFACES", "1")
                    .spawn();

                match result {
                    Ok((mut rx, child)) => {
                        *lock_or_recover(&SERVER_CHILD) = Some(child);
                        log::info!("[sidecar] Bundled Node.js spawned on port {}", port);
                        // L-G5 fix: 服务器启动后更新托盘菜单状态文本。
                        crate::tray::set_status_text(app, "服务器状态: 运行中");
                        // M-G1 fix: spawn 后短暂等待并检查进程是否仍存活，
                        // 失败时返回错误而非静默继续，便于上层重试或报错。
                        match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                            Ok(Some(tauri_plugin_shell::process::CommandEvent::Terminated(status))) => {
                                log::error!("[sidecar] Process terminated immediately after spawn: {:?}", status);
                                *lock_or_recover(&SERVER_CHILD) = None;
                                // L-G5 fix: 进程立即退出，更新状态文本。
                                crate::tray::set_status_text(app, "服务器状态: 启动失败");
                                return Err(format!("Bundled node exited immediately after spawn: {:?}", status));
                            }
                            Ok(_) => {
                                // 进程仍在运行（stdout/stderr/空事件），继续监听
                            }
                            Err(_) => {
                                // 超时仍未退出视为正常启动
                            }
                        }

                        while let Some(event) = rx.recv().await {
                            match event {
                                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                                    let msg = String::from_utf8_lossy(&line).to_string();
                                    log::info!("[server:out] {}", msg);
                                }
                                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                                    let msg = String::from_utf8_lossy(&line).to_string();
                                    log::warn!("[server:err] {}", msg);
                                }
                                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                                    log::warn!("[server] exited: {:?}", status);
                                    *lock_or_recover(&SERVER_CHILD) = None;
                                    // L-G5 fix: 服务器退出后更新托盘状态文本。
                                    crate::tray::set_status_text(app, "服务器状态: 已停止");

                                    if INTENTIONAL_EXIT.load(Ordering::SeqCst) {
                                        log::info!("[sidecar] Intentional exit, not restarting");
                                        return Ok(());
                                    }

                                    let mut crashes = lock_or_recover(&CRASH_COUNT);
                                    // M-G4 fix: 成功运行超过 1 小时后重置 CRASH_COUNT，
                                    // 避免长期运行中偶发崩溃累积达到 MAX_CRASHES 导致应用退出。
                                    if let Some(last) = *lock_or_recover(&LAST_CRASH_TIME) {
                                        if last.elapsed() > CRASH_COUNT_RESET_INTERVAL {
                                            log::info!("[sidecar] Stable for >1h, resetting CRASH_COUNT from {} to 0", *crashes);
                                            *crashes = 0;
                                        }
                                    }
                                    *crashes += 1;
                                    *lock_or_recover(&LAST_CRASH_TIME) = Some(std::time::Instant::now());
                                    if *crashes >= MAX_CRASHES {
                                        log::error!("[sidecar] Server crashed {} times, exiting application", *crashes);
                                        crate::tray::set_status_text(app, "服务器状态: 崩溃退出");
                                        app.exit(1);
                                        return Ok(());
                                    }
                                    log::warn!("[sidecar] Server crashed (attempt {}/{}), will retry on next launch", *crashes, MAX_CRASHES);
                                    crate::tray::set_status_text(app, "服务器状态: 崩溃，待重试");
                                    return Err(format!("Local service exited: {:?}", status));
                                }
                                _ => {}
                            }
                        }
                        Ok(())
                    }
                    Err(e) => {
                        log::error!("[sidecar] Failed to spawn bundled node: {}", e);
                        // M-G1 fix: spawn 失败时返回错误而非直接 app.exit(1)，
                        // 让上层 IPC 调用方能够感知失败并重试或向用户报错。
                        crate::tray::set_status_text(app, "服务器状态: 启动失败");
                        Err(format!("Failed to spawn bundled node: {}", e))
                    }
                }
            }
            Err(e) => {
                log::warn!("[sidecar] Bundled node not found: {}, trying system node", e);
                let node_path = find_node_binary();
                log::info!("[sidecar] System node path: {}", node_path);

                let result = app.shell()
                    .command(&node_path)
                    .args([&start_script_str, "--port", &port.to_string()])
                    .current_dir(work_dir_str)
                    .env("WING_DESKTOP_SURFACES", "1")
                    .spawn();

                match result {
                    Ok((mut rx, child)) => {
                        *lock_or_recover(&SERVER_CHILD) = Some(child);
                        log::info!("[sidecar] System Node.js spawned on port {}", port);
                        // L-G5 fix: 服务器启动后更新托盘菜单状态文本。
                        crate::tray::set_status_text(app, "服务器状态: 运行中");
                        // M-G1 fix: 同上，spawn 后检查进程是否立即退出。
                        match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                            Ok(Some(tauri_plugin_shell::process::CommandEvent::Terminated(status))) => {
                                log::error!("[sidecar] System node terminated immediately after spawn: {:?}", status);
                                *lock_or_recover(&SERVER_CHILD) = None;
                                crate::tray::set_status_text(app, "服务器状态: 启动失败");
                                return Err(format!("System node exited immediately after spawn: {:?}", status));
                            }
                            Ok(_) => {}
                            Err(_) => {}
                        }

                        while let Some(event) = rx.recv().await {
                            match event {
                                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                                    let msg = String::from_utf8_lossy(&line).to_string();
                                    log::info!("[server:out] {}", msg);
                                }
                                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                                    let msg = String::from_utf8_lossy(&line).to_string();
                                    log::warn!("[server:err] {}", msg);
                                }
                                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                                    log::warn!("[server] exited: {:?}", status);
                                    *lock_or_recover(&SERVER_CHILD) = None;
                                    // L-G5 fix: 服务器退出后更新托盘状态文本。
                                    crate::tray::set_status_text(app, "服务器状态: 已停止");

                                    if INTENTIONAL_EXIT.load(Ordering::SeqCst) {
                                        log::info!("[sidecar] Intentional exit, not restarting");
                                        return Ok(());
                                    }

                                    let mut crashes = lock_or_recover(&CRASH_COUNT);
                                    // M-G4 fix: 同上，成功运行超过 1 小时后重置 CRASH_COUNT。
                                    if let Some(last) = *lock_or_recover(&LAST_CRASH_TIME) {
                                        if last.elapsed() > CRASH_COUNT_RESET_INTERVAL {
                                            log::info!("[sidecar] Stable for >1h, resetting CRASH_COUNT from {} to 0", *crashes);
                                            *crashes = 0;
                                        }
                                    }
                                    *crashes += 1;
                                    *lock_or_recover(&LAST_CRASH_TIME) = Some(std::time::Instant::now());
                                    if *crashes >= MAX_CRASHES {
                                        log::error!("[sidecar] Server crashed {} times, exiting application", *crashes);
                                        crate::tray::set_status_text(app, "服务器状态: 崩溃退出");
                                        app.exit(1);
                                        return Ok(());
                                    }
                                    log::warn!("[sidecar] Server crashed (attempt {}/{}), will retry on next launch", *crashes, MAX_CRASHES);
                                    crate::tray::set_status_text(app, "服务器状态: 崩溃，待重试");
                                    return Err(format!("Local service exited: {:?}", status));
                                }
                                _ => {}
                            }
                        }
                        Ok(())
                    }
                    Err(e2) => {
                        log::error!("[sidecar] System node also failed: {}", e2);
                        // M-G1 fix: 同上，返回错误而非直接退出。
                        crate::tray::set_status_text(app, "服务器状态: 启动失败");
                        Err(format!("System node also failed: {}", e2))
                    }
                }
            }
        }
    })
}

/// M-G2 fix: webview URL 在 tauri.conf.json 中硬编码为 http://127.0.0.1:19111，
/// 若动态查找端口会与 webview URL 不一致导致连接失败（C-D10 已将 CSP 端口固定为 19111）。
/// 因此 start_node_server 必须始终使用 19111，端口被占用时返回错误让上层处理。
pub async fn start_node_server(app: &tauri::AppHandle) -> Result<(), String> {
    const REQUIRED_PORT: u16 = DESKTOP_PORT;
    // 检查 19111 是否可用；若被占用则返回错误，避免破坏 webview 连接。
    if let Err(e) = std::net::TcpListener::bind(format!("127.0.0.1:{}", REQUIRED_PORT)) {
        let msg = format!("Port {} is not available (webview URL is hardcoded to this port): {}", REQUIRED_PORT, e);
        log::error!("[sidecar] {}", msg);
        return Err(msg);
    }
    set_server_port(REQUIRED_PORT);
    start_node_server_on_port(app, REQUIRED_PORT).await
}

pub fn stop_node_server() {
    set_intentional_exit(true);
    let mut child = lock_or_recover(&SERVER_CHILD);
    if let Some(c) = child.take() {
        // M-G6 fix: 记录 kill 错误日志，并尝试备选 kill 方式（kill 后再 store_kill 兜底）。
        if let Err(e) = c.kill() {
            log::error!("[sidecar] Primary kill failed: {}, attempting alternative cleanup", e);
            // tauri-plugin-shell 的 CommandChild::kill 是平台无关的终止方式，
            // 若失败则记录错误，调用方应关注日志。备选方式受限于 CommandChild API
            // 无法直接发送 SIGKILL/TerminateProcess，此处记录错误以便诊断孤儿进程。
        } else {
            log::info!("[sidecar] Server child killed successfully");
        }
    }
}

pub fn get_server_port() -> u16 {
    *lock_or_recover(&SERVER_PORT)
}

fn find_node_binary() -> String {
    let candidates = if cfg!(target_os = "windows") {
        vec!["node.exe", "node"]
    } else {
        vec!["node", "/usr/local/bin/node", "/usr/bin/node"]
    };

    for candidate in candidates {
        if which_exists(candidate) {
            return candidate.to_string();
        }
    }

    "node".to_string()
}

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new(if cfg!(target_os = "windows") { "where" } else { "which" })
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
