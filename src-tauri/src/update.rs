use std::path::{Path, PathBuf};
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use serde_json::json;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::oneshot;

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static HEALTHY: AtomicBool = AtomicBool::new(false);
type Reply = oneshot::Sender<Result<(), String>>;
static PENDING: Mutex<Option<(String, Reply)>> = Mutex::new(None);

pub fn notice(app: &tauri::AppHandle, phase: &str, message: &str, id: Option<&str>, version: Option<&str>, percent: Option<u64>) {
    if let Some(view) = app.get_webview("main") {
        let payload = json!({"phase":phase,"message":message,"id":id,"version":version,"percent":percent});
        let _ = view.eval(format!("window.dispatchEvent(new CustomEvent('wing-update',{{detail:{}}}))", payload));
    }
}
fn cancelled() -> Result<(), String> { if CANCELLED.load(Ordering::SeqCst) { Err("已取消更新".into()) } else { Ok(()) } }
pub async fn check(app: &tauri::AppHandle, silent: bool) -> Result<Option<String>, String> {
    if BUSY.load(Ordering::SeqCst) { return Err("已有更新正在进行".into()); }
    let result = app.updater_builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?.check().await;
    match result {
        Ok(Some(update)) => {
            notice(app,"available","有新版本可用。更新前会等待任务结束并保存文档。",None,Some(&update.version),None);
            Ok(Some(update.version))
        },
        Ok(None) => { if !silent { notice(app,"current","当前没有可用的新版本",None,None,None); } Ok(None) },
        Err(error) => { if !silent { notice(app,"error","暂时无法检查更新，请稍后重试",None,None,None); } Err(error.to_string()) }
    }
}
#[tauri::command]
pub fn cancel_update() {
    CANCELLED.store(true, Ordering::SeqCst);
    if let Some((_, reply)) = PENDING.lock().unwrap_or_else(|e|e.into_inner()).take() { let _ = reply.send(Err("已取消更新".into())); }
}
#[tauri::command]
pub fn update_prepared(id: String, error: Option<String>) -> Result<(), String> {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if pending.as_ref().map(|(key,_)|key.as_str()) != Some(id.as_str()) { return Err("更新请求已失效".into()); }
    if let Some((_, reply)) = pending.take() { let _ = reply.send(error.map_or(Ok(()), Err)); }
    Ok(())
}
async fn frontend(app: &tauri::AppHandle, id: &str, phase: &str) -> Result<(), String> {
    let (send, recv) = oneshot::channel();
    *PENDING.lock().unwrap_or_else(|e|e.into_inner()) = Some((id.to_owned(),send));
    notice(app,phase,if phase=="prepare" {"正在检查任务和未保存文档…"} else {"正在安全关闭后台…"},Some(id),None,None);
    let timeout = if phase == "prepare" { 1800 } else { 30 };
    let result = tokio::time::timeout(Duration::from_secs(timeout),recv).await
        .map_err(|_|"没有收到工作台的安全更新确认，已停止更新".to_string())
        .and_then(|r| r.map_err(|_|"工作台更新确认已中断".to_string())).and_then(|r|r);
    PENDING.lock().unwrap_or_else(|e|e.into_inner()).take();
    result
}
fn paths(app: &tauri::AppHandle) -> Result<(PathBuf,PathBuf,PathBuf,PathBuf),String> {
    let exe = std::env::current_exe().map_err(|e|e.to_string())?;
    let resource = app.path().resource_dir().map_err(|e|e.to_string())?;
    let helper = [resource.join("_up_/packages/backend/deploy/update-recovery.cjs"), resource.join("update-recovery.cjs")]
        .into_iter().find(|p|p.is_file()).ok_or("缺少更新恢复组件，请使用经过验证的安装包")?;
    let node_name = if cfg!(windows) {"node.exe"} else {"node"};
    let node = [exe.parent().unwrap().join(node_name),resource.join(node_name)]
        .into_iter().find(|p|p.is_file()).ok_or("缺少内置运行环境，已停止更新")?;
    let install = if cfg!(windows) { exe.parent().unwrap().to_path_buf() }
        else if cfg!(target_os="macos") { exe.ancestors().find(|p|p.extension().is_some_and(|x|x=="app")).ok_or("无法识别应用目录")?.to_path_buf() }
        else { PathBuf::from(std::env::var("APPIMAGE").map_err(|_|"此安装方式请通过系统包管理器更新；已停止自动替换系统文件")?) };
    let executable = if cfg!(target_os="linux") { install.clone() } else { exe };
    Ok((node,helper,install,executable))
}
async fn helper(node: &Path, script: &Path, args: &[String]) -> Result<(),String> {
    let mut command = tokio::process::Command::new(node);
    command.arg(script).args(args);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let output = command.output().await.map_err(|e|e.to_string())?;
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).chars().take(1200).collect()) }
}
fn pending_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let pointer = app.path().app_local_data_dir().ok()?.join("updates/pending.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&pointer).ok()?).ok()?;
    let dir = PathBuf::from(value.get("transactionDir")?.as_str()?);
    if dir.parent()? != pointer.parent()? { return None; }
    Some(dir)
}
#[tauri::command]
pub async fn update_healthy(app: tauri::AppHandle) -> Result<(),String> {
    if let Some(dir) = pending_dir(&app) {
        let node = dir.join(if cfg!(windows){"recovery-node.exe"}else{"recovery-node"});
        helper(&node,&dir.join("recovery.cjs"), &["healthy".into(),dir.to_string_lossy().into(),env!("CARGO_PKG_VERSION").into(),std::process::id().to_string()]).await?;
    }
    HEALTHY.store(true,Ordering::SeqCst);
    Ok(())
}
pub fn resume_recovery(app: &tauri::AppHandle) -> bool {
    if let Some(dir) = pending_dir(app) {
        let journal: serde_json::Value = std::fs::read(dir.join("journal.json")).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
        let status=journal["status"].as_str().unwrap_or("");
        if ["cancelled","committed","rolled-back"].contains(&status) { return false; }
        let node = dir.join(if cfg!(windows){"recovery-node.exe"}else{"recovery-node"});
        if ["failed","restoring","recovery-required"].contains(&status) {
            // Let recovery replace files before this process opens any app data.
            let mut command=std::process::Command::new(&node);
            command.arg(dir.join("recovery.cjs")).arg("start-watch").arg(&dir);
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            return command.status().map(|s|s.success()).unwrap_or(false);
        }
        let handle=app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = helper(&node,&dir.join("recovery.cjs"), &["start-watch".into(),dir.to_string_lossy().into()]).await;
            tokio::time::sleep(Duration::from_secs(120)).await;
            if !HEALTHY.load(Ordering::SeqCst) {
                let _ = helper(&node,&dir.join("recovery.cjs"), &["phase".into(),dir.to_string_lossy().into(),"failed".into()]).await;
                crate::sidecar::stop_node_server();
                handle.exit(1);
            }
        });
    }
    false
}
pub async fn install(app: &tauri::AppHandle) -> Result<(),String> {
    if BUSY.swap(true,Ordering::SeqCst) { return Err("已有更新正在进行".into()); }
    CANCELLED.store(false,Ordering::SeqCst);
    let id = format!("{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let result = perform(app,&id).await;
    if let Err(error) = &result {
        notice(app,if CANCELLED.load(Ordering::SeqCst){"cancelled"}else{"error"},error,Some(&id),None,None);
    }
    BUSY.store(false,Ordering::SeqCst);
    result
}
async fn perform(app: &tauri::AppHandle,id: &str) -> Result<(),String> {
    let (node,script,install_root,executable) = paths(app)?;
    let dir = app.path().app_local_data_dir().map_err(|e|e.to_string())?.join("updates").join(id);
    std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let mut builder = app.updater_builder().timeout(Duration::from_secs(120));
    #[cfg(windows)] { builder = builder.installer_arg(format!("/WINGRECOVERY=\"{}\"",dir.to_string_lossy())); }
    let update = builder.build().map_err(|e|e.to_string())?.check().await.map_err(|e|e.to_string())?.ok_or("当前没有可用的新版本")?;
    notice(app,"downloading","正在下载并验证更新…",Some(id),Some(&update.version),Some(0));
    let mut received = 0u64;
    let download = update.download(|chunk,total| { received += chunk as u64; notice(app,"downloading","正在下载并验证更新…",Some(id),Some(&update.version),total.filter(|n|*n>0).map(|n|(received*100/n).min(100))); },||{});
    let bytes = tokio::select! {
        result=download => result.map_err(|e|e.to_string())?,
        _=async { while !CANCELLED.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(100)).await; } } => return Err("已取消更新".into()),
    };
    cancelled()?;
    frontend(app,id,"prepare").await?;
    cancelled()?;
    crate::sidecar::set_intentional_exit(true);
    let prepared = async {
        frontend(app,id,"shutdown").await?;
        let mut closed = false;
        for _ in 0..120 {
            if std::net::TcpListener::bind(("127.0.0.1",crate::sidecar::get_server_port())).is_ok() { closed=true; break; }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !closed { return Err("后台尚未安全退出，已停止更新".to_string()); }
        crate::sidecar::stop_node_server();
        notice(app,"installing","正在创建并校验更新备份…",Some(id),None,None);
        let request=dir.join("request.json");
        std::fs::write(&request,serde_json::to_vec(&json!({"edition":crate::edition::NAME,"transactionDir":dir,"installRoot":install_root,"executable":executable,"version":update.version,"previousVersion":env!("CARGO_PKG_VERSION"),"parentPid":std::process::id(),"systemIntegration":true})).unwrap()).map_err(|e|e.to_string())?;
        helper(&node,&script,&["prepare".into(),request.to_string_lossy().into()]).await?;
        cancelled()?;
        helper(&node,&script,&["start-watch".into(),dir.to_string_lossy().into()]).await
    }.await;
    if let Err(error)=prepared {
        if dir.join("journal.json").exists() { let _ = helper(&node,&script,&["phase".into(),dir.to_string_lossy().into(),"cancelled".into()]).await; }
        // If graceful shutdown timed out, leave the still-running backend alone.
        if std::net::TcpListener::bind(("127.0.0.1",crate::sidecar::get_server_port())).is_ok() {
            crate::sidecar::stop_node_server();
            let _ = crate::sidecar::start_node_server_on_port(app,crate::sidecar::get_server_port()).await;
        } else { crate::sidecar::set_intentional_exit(false); }
        return Err(error);
    }
    notice(app,"installing","备份已验证，正在安装更新…",Some(id),Some(&update.version),None);
    // On Windows the updater launches NSIS and exits; NSIS records completion/failure.
    // Other platforms return here, so mark completion using the independent copied runtime.
    let installed = update.install(bytes);
    let recovery_node = dir.join(if cfg!(windows){"recovery-node.exe"}else{"recovery-node"});
    let phase = if installed.is_ok(){"installed"}else{"failed"};
    helper(&recovery_node,&dir.join("recovery.cjs"),&["phase".into(),dir.to_string_lossy().into(),phase.into()]).await?;
    if installed.is_ok() { app.restart(); } else { app.exit(1); }
    installed.map_err(|e|e.to_string())
}
