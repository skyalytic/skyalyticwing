use std::{io::Cursor, sync::mpsc, time::Duration};
use base64::Engine;
use windows::{core::{factory, Interface}, Graphics::{Capture::*, DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat}}, Win32::{Foundation::*, Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*, Dxgi::IDXGIDevice, Dwm::*}, System::WinRT::{*, Direct3D11::*, Graphics::Capture::IGraphicsCaptureItemInterop}, UI::WindowsAndMessaging::*}};

fn capture(id: isize, expected_pid: u32) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hwnd = HWND(id as *mut _);
        let validate = || -> Result<(), Box<dyn std::error::Error>> {
            let mut pid = 0; GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || pid != expected_pid { return Err("Window is not currently targetable".into()); }
            Ok(())
        };
        validate()?;
        if !GraphicsCaptureSession::IsSupported()? { return Err("Windows Graphics Capture is unavailable".into()); }
        let mut bounds = RECT::default(); GetWindowRect(hwnd, &mut bounds)?;
        let mut frame_bounds = bounds;
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame_bounds as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32)?;
        let interop: IGraphicsCaptureItemInterop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
        let mut device = None; let mut context = None;
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?;
        let device = device.ok_or("No capture device")?; let context = context.ok_or("No capture context")?;
        let dxgi: IDXGIDevice = device.cast()?;
        let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, item.Size()?)?;
        let (tx, rx) = mpsc::sync_channel(1);
        let token = pool.FrameArrived(&windows::Foundation::TypedEventHandler::new(move |sender: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
            if let Some(pool) = sender.as_ref() { if let Ok(frame) = pool.TryGetNextFrame() { let _ = tx.try_send(frame); } }
            Ok(())
        }))?;
        let session = pool.CreateCaptureSession(&item)?;
        session.SetIsCursorCaptureEnabled(false)?;
        session.StartCapture()?;
        let frame = rx.recv_timeout(Duration::from_secs(5))?;
        pool.RemoveFrameArrived(token)?;
        let surface = frame.Surface()?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let texture: ID3D11Texture2D = access.GetInterface()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default(); texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.MiscFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None; device.CreateTexture2D(&desc, None, Some(&mut staging))?; let staging = staging.ok_or("No staging texture")?;
        context.CopyResource(&staging, &texture);
        let size = frame.ContentSize()?; let width = size.Width as usize; let height = size.Height as usize;
        if size.Width <= 0 || size.Height <= 0 || width > desc.Width as usize || height > desc.Height as usize { return Err("Capture dimensions changed; observe again".into()); }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default(); context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        if mapped.pData.is_null() || (mapped.RowPitch as usize) < width * 4 { context.Unmap(&staging, 0); return Err("Invalid capture texture".into()); }
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height { let row = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), width * 4); for p in row.chunks_exact(4) { rgba.extend_from_slice(&[p[2], p[1], p[0], p[3]]); } }
        context.Unmap(&staging, 0);
        frame.Close()?; session.Close()?; pool.Close()?;
        validate()?; let mut after = RECT::default(); GetWindowRect(hwnd, &mut after)?;
        if bounds != after { return Err("Window moved while capturing; observe again".into()); }
        let mut png = Cursor::new(Vec::new());
        { let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32); encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight); let mut writer = encoder.write_header()?; writer.write_image_data(&rgba)?; }
        Ok(serde_json::json!({"base64":base64::engine::general_purpose::STANDARD.encode(png.into_inner()),"mimeType":"image/png","width":width,"height":height,"originX":frame_bounds.left,"originY":frame_bounds.top,"bounds":{"x":bounds.left,"y":bounds.top,"width":bounds.right-bounds.left,"height":bounds.bottom-bounds.top},"foregroundWindowId":GetForegroundWindow().0 as isize,"captureMethod":"Windows.Graphics.Capture","coordinateSpace":"physical-screen-pixels","cursor":{"x":0,"y":0,"visible":false}}))
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--self-test") { println!("{{\"protocolVersion\":1,\"captureMethod\":\"Windows.Graphics.Capture\"}}"); return; }
    let result = (|| capture(args.get(1).ok_or("Missing window")?.parse()?, args.get(2).ok_or("Missing pid")?.parse()?))();
    match result { Ok(value) => println!("{}", value), Err(error) => { eprintln!("{}", error); std::process::exit(1); } }
}
