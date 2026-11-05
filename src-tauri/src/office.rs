use serde::Deserialize;
use tauri::{webview::WebviewBuilder, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};
#[derive(Deserialize)]
pub struct OfficeBounds { x:f64,y:f64,width:f64,height:f64,visible:bool }
#[tauri::command]
pub async fn native_office_view(app:tauri::AppHandle,webview:Webview,id:String,action:String,url:Option<String>,bounds:Option<OfficeBounds>)->Result<(),String>{
 let caller=webview.url().map_err(|e|e.to_string())?;
 if webview.label()!="main"||caller.scheme()!="http"||caller.host_str()!=Some("127.0.0.1")||caller.port()!=Some(crate::sidecar::get_server_port()){return Err("仅 Wing 主界面可以打开 Office".into());}
 if id.len()!=40||!id.bytes().all(|c|c.is_ascii_hexdigit()){return Err("Office 会话无效".into());}
 let label=format!("wing-office-{}",id);
 match action.as_str(){
  "open"=>{
   if app.get_webview(&label).is_some(){return Ok(());}
   let target=tauri::Url::parse(&url.ok_or("缺少 Office 地址")?).map_err(|e|e.to_string())?;
   if target.scheme()!="http"||target.host_str()!=Some("127.0.0.1")||target.port().unwrap_or(0)<1024||target.path()!=format!("/edit/{}",id)||!target.username().is_empty()||target.password().is_some()||target.query().is_some(){return Err("Office 地址无效".into());}
   let origin=target.origin();
   let builder=WebviewBuilder::new(label,WebviewUrl::External(target)).on_navigation(move |next|next.origin()==origin).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny);
   let window=app.get_window("main").ok_or("主窗口未打开")?;
   let view=window.add_child(builder,LogicalPosition::new(0.0,0.0),LogicalSize::new(1.0,1.0)).map_err(|e|e.to_string())?;
   view.hide().map_err(|e|e.to_string())?;
  },
  "bounds"=>{if let Some(view)=app.get_webview(&label){let b=bounds.ok_or("缺少区域尺寸")?;if ![b.x,b.y,b.width,b.height].iter().all(|n|n.is_finite()){return Err("无效尺寸".into());}if b.visible&&b.width>1.0&&b.height>1.0{view.set_position(LogicalPosition::new(b.x.max(0.0),b.y.max(0.0))).map_err(|e|e.to_string())?;view.set_size(LogicalSize::new(b.width,b.height)).map_err(|e|e.to_string())?;view.show().map_err(|e|e.to_string())?;}else{view.hide().map_err(|e|e.to_string())?;}}},
  "close"=>{if let Some(view)=app.get_webview(&label){view.close().map_err(|e|e.to_string())?;}},
  _=>return Err("不支持的 Office 操作".into())
 }
 Ok(())
}
