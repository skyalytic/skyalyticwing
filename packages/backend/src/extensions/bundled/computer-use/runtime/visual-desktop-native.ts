import { DESKTOP_TEXT_SOURCE } from './desktop-text-native.js';
import { DESKTOP_OVERLAY_SOURCE } from "./desktop-overlay-native.js";
import { SKY_NATIVE_SOURCE } from "./sky-native.js";
/** Wing-owned Windows visual and accessibility control helper. */
export const VISUAL_DESKTOP_NATIVE_SOURCE = String.raw`
using System;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class WingVisualDesktop {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64000000 };
  static readonly object OutputLock = new object();
  static Control Ui;
  static StopBar Bar;

  static volatile bool Stopped;
  static bool OverlayWanted;
  static string OverlayTitle = "Wing 正在操作电脑";
  const int GA_ROOT = 2, SW_RESTORE = 9, SW_SHOWNOACTIVATE = 4;
  const uint KEYUP = 2, UNICODE = 4;
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr state);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder image,ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls,string title);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string cls,string title);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd,IntPtr dc);
  [DllImport("gdi32.dll",SetLastError=true)] static extern bool BitBlt(IntPtr dest,int x,int y,int width,int height,IntPtr source,int sourceX,int sourceY,uint operation);
  static void CaptureVisiblePixels(Bitmap bitmap,int x,int y){
    IntPtr screen=GetDC(IntPtr.Zero);if(screen==IntPtr.Zero)throw new Exception("Screen capture DC unavailable.");
    try{using(var graphics=Graphics.FromImage(bitmap)){IntPtr dest=graphics.GetHdc();try{
      // SRCCOPY | CAPTUREBLT includes custom-rendered layered input fields/popups.
      if(!BitBlt(dest,0,0,bitmap.Width,bitmap.Height,screen,x,y,0x40CC0020))throw new Exception("Screen copy failed: "+Marshal.GetLastWin32Error());
    }finally{graphics.ReleaseHdc(dest);}}}finally{ReleaseDC(IntPtr.Zero,screen);}
  }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int action);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO cursor);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint key);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder info,int length,out int needed);
  static Dictionary<string,object> D(params object[] pairs) { var d = new Dictionary<string,object>(); for (int i=0;i<pairs.Length;i+=2) d[(string)pairs[i]]=pairs[i+1]; return d; }
  static object Get(Dictionary<string,object> d, string key, object fallback) { object v; return d != null && d.TryGetValue(key,out v) && v != null ? v : fallback; }
  static int N(Dictionary<string,object> d, string key, int fallback) { return Convert.ToInt32(Get(d,key,fallback)); }
  static string S(Dictionary<string,object> d, string key, string fallback) { return Convert.ToString(Get(d,key,fallback)); }
  static void Emit(object value) { lock(OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
  static void OnUi(Action action) { if (Ui.InvokeRequired) Ui.Invoke(action); else action(); }
  // Process.ProcessName on .NET Framework repeatedly enumerates the entire process table.
  // Query only this window's executable; the name is descriptive, never an input-authority check.
  ${SKY_NATIVE_SOURCE}
  static string ProcessName(uint pid) {
    IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return "";
    try{uint size=32768;var image=new StringBuilder((int)size);return QueryFullProcessImageName(process,0,image,ref size)?Path.GetFileNameWithoutExtension(image.ToString()):"";}
    finally{CloseHandle(process);}
  }
  static object Bounds(RECT r) { return D("x",r.Left,"y",r.Top,"width",r.Right-r.Left,"height",r.Bottom-r.Top); }
  // A zero HWND represents the visible desktop, including taskbar, tray and popup windows.
  static Screen[] Displays() { var screens=new List<Screen>(Screen.AllScreens);screens.Sort(delegate(Screen a,Screen b){if(a.Primary!=b.Primary)return a.Primary?-1:1;return String.CompareOrdinal(a.DeviceName,b.DeviceName);});return screens.ToArray(); }
  static bool IsDesktop(IntPtr h) { return h.ToInt64()<=0; }
  static RECT DesktopRect(IntPtr h) { var screens=Displays();long i=-h.ToInt64();if(i<0||i>=screens.Length)throw new Exception("Display disappeared. Observe again.");var b=screens[(int)i].Bounds;return new RECT{Left=b.Left,Top=b.Top,Right=b.Right,Bottom=b.Bottom}; }
  static RECT RectFor(IntPtr h) { if(IsDesktop(h))return DesktopRect(h);RECT r;GetWindowRect(h,out r);return r; }
  static object ScreenRegions(RECT display) {
    var regions=new Dictionary<string,object>();IntPtr taskbar=FindWindow("Shell_TrayWnd",null);
    foreach(var pair in new[]{new KeyValuePair<string,IntPtr>("taskbar",taskbar),new KeyValuePair<string,IntPtr>("notificationArea",FindWindowEx(taskbar,IntPtr.Zero,"TrayNotifyWnd",null))}) {
      RECT r;if(pair.Value==IntPtr.Zero||!IsWindowVisible(pair.Value)||!GetWindowRect(pair.Value,out r))continue;
      if(r.Left>=display.Left&&r.Top>=display.Top&&r.Right<=display.Right&&r.Bottom<=display.Bottom&&r.Right>r.Left&&r.Bottom>r.Top)regions[pair.Key]=Bounds(r);
    }
    return regions;
  }
  static bool BelongsToRoot(IntPtr candidate,IntPtr root) {
    uint candidatePid,rootPid;GetWindowThreadProcessId(candidate,out candidatePid);GetWindowThreadProcessId(root,out rootPid);if(candidatePid!=rootPid)return false;
    // Search results, combo boxes and menus are often top-level owned windows.
    for(int i=0;i<32&&candidate!=IntPtr.Zero;i++){if(candidate==root)return true;candidate=GetWindow(candidate,4);}
    return false;
  }
  static bool SameRect(RECT a,RECT b){return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom;}
  static RECT CaptureRectFor(IntPtr root) {
    RECT frame=RectFor(root);if(IsDesktop(root))return frame;
    // Include owned top-level search results, menus and dialogs, even beyond the
    // parent rectangle. Unrelated windows never expand the capture/input target.
    EnumWindows(delegate(IntPtr h,IntPtr ignored){
      if(h==root||!IsWindowVisible(h)||IsIconic(h)||IsWingSurface(h)||!BelongsToRoot(h,root))return true;
      RECT r=RectFor(h);if(r.Right>r.Left&&r.Bottom>r.Top){frame.Left=Math.Min(frame.Left,r.Left);frame.Top=Math.Min(frame.Top,r.Top);frame.Right=Math.Max(frame.Right,r.Right);frame.Bottom=Math.Max(frame.Bottom,r.Bottom);}return true;
    },IntPtr.Zero);
    return frame;
  }
  static void CheckDesktop() {
    if(Stopped)throw new Exception("Desktop control stopped by user.");
    IntPtr input=OpenInputDesktop(0,false,1);
    if(input==IntPtr.Zero)throw new Exception("Interactive desktop unavailable. Unlock or reconnect the desktop before continuing.");
    try {var name=new StringBuilder(256);int needed;if(!GetUserObjectInformation(input,2,name,name.Capacity*2,out needed)||!String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))throw new Exception("The desktop is locked or a secure prompt is active. User action is required.");}
    finally{CloseDesktop(input);}
    if(GetForegroundWindow()==IntPtr.Zero)throw new Exception("No interactive foreground desktop. Unlock the desktop before continuing.");
  }
  static IntPtr Root(Dictionary<string,object> req, bool foreground, bool checkBounds, bool allowRestore=false) {
    var root = (Dictionary<string,object>)req["root"];
    IntPtr hwnd = new IntPtr(Convert.ToInt64(root["windowId"])); uint pid;
    if(IsDesktop(hwnd)) {
      CheckDesktop();
      if(S(root,"rootRef","")!="desktop:"+(-hwnd.ToInt64())||N(root,"pid",-1)!=0)throw new Exception("Invalid desktop root.");
      if(checkBounds){var b=(Dictionary<string,object>)root["bounds"];RECT r=DesktopRect(hwnd);if(r.Left!=N(b,"x",0)||r.Top!=N(b,"y",0)||r.Right-r.Left!=N(b,"width",0)||r.Bottom-r.Top!=N(b,"height",0))throw new Exception("Display layout changed. Observe again before input.");}
      return hwnd;
    }
    if(IsWingSurface(hwnd))throw new Exception("Wing control and approval surfaces are for the user, not an automation target.");
    if (!IsWindow(hwnd) || (!IsWindowVisible(hwnd) && !(allowRestore && RestorableAppWindow(hwnd)))) throw new Exception("Target window no longer exists or is hidden. Restore it before observing.");
    GetWindowThreadProcessId(hwnd,out pid);
    if (pid != Convert.ToUInt32(root["pid"])) throw new Exception("Target HWND was reused by another process. Observe again.");
    if (foreground && !BelongsToRoot(GetAncestor(GetForegroundWindow(),GA_ROOT),hwnd)) throw new Exception("Target is not the foreground window. Focus and observe it first; no input was sent.");
    if (foreground && IsIconic(hwnd)) throw new Exception("Target window is minimized.");
    if (checkBounds && root.ContainsKey("bounds")) {
      RECT r; GetWindowRect(hwnd,out r); var b=(Dictionary<string,object>)root["bounds"];
      if(r.Left!=N(b,"x",0)||r.Top!=N(b,"y",0)||r.Right-r.Left!=N(b,"width",0)||r.Bottom-r.Top!=N(b,"height",0)) throw new Exception("Target window moved or resized. Observe again before input.");
    }
    return hwnd;
  }
  static void Check(IntPtr hwnd,uint expectedPid=0) { if(IsDesktop(hwnd)){CheckDesktop();return;} if(Stopped) throw new Exception("Desktop control stopped by user."); uint pid;GetWindowThreadProcessId(hwnd,out pid);if(!IsWindow(hwnd)||!IsWindowVisible(hwnd)||IsIconic(hwnd)||(expectedPid!=0&&pid!=expectedPid))throw new Exception("Target window changed during the operation. Observe before retrying.");if(!BelongsToRoot(GetAncestor(GetForegroundWindow(),GA_ROOT),hwnd)) throw new Exception("Foreground window changed during input. Input may be partial; observe before retrying."); }
  static void CheckKeyboard(IntPtr hwnd,uint pid){Check(hwnd,pid);if(GetAncestor(GetForegroundWindow(),GA_ROOT)!=hwnd)throw new Exception("Keyboard focus changed during input. Observe again before retrying.");}
  static bool ClipLine(double p,double q,ref double low,ref double high){if(p==0)return q>=0;double t=q/p;if(p<0){if(t>high)return false;if(t>low)low=t;}else{if(t<low)return false;if(t<high)high=t;}return true;}
  static bool OverlayBlocks(Rectangle bounds,Point start,Point end,bool drag){
    bounds.Inflate(10,10);if(bounds.Contains(start)||bounds.Contains(end))return true;if(!drag)return false;
    double low=0,high=1,dx=end.X-start.X,dy=end.Y-start.Y;
    return ClipLine(-dx,start.X-bounds.Left,ref low,ref high)&&ClipLine(dx,bounds.Right-start.X,ref low,ref high)&&ClipLine(-dy,start.Y-bounds.Top,ref low,ref high)&&ClipLine(dy,bounds.Bottom-start.Y,ref low,ref high);
  }
  /** Pure geometry, also exercised without starting the helper or touching the desktop. */
  public static Point ChooseOverlayPosition(Rectangle area,Size size,Point start,Point end,bool drag){
    int left=area.Left+8,right=Math.Max(area.Left,area.Right-size.Width-8),top=area.Top+8,bottom=Math.Max(area.Top,area.Bottom-size.Height-8),cx=area.Left+(area.Width-size.Width)/2,cy=area.Top+(area.Height-size.Height)/2;
    var candidates=new Point[]{new Point(left,bottom),new Point(right,bottom),new Point(left,top),new Point(right,top),new Point(cx,bottom),new Point(cx,top),new Point(left,cy),new Point(right,cy)};
    foreach(Point candidate in candidates){var p=new Point(Math.Max(area.Left,Math.Min(candidate.X,area.Right-size.Width)),Math.Max(area.Top,Math.Min(candidate.Y,area.Bottom-size.Height)));if(!OverlayBlocks(new Rectangle(p,size),start,end,drag))return p;}
    throw new Exception("The stop control cannot be placed clear of this input path. Choose a different input point or path.");
  }
  static void KeepOverlayClear(Point start,Point end,bool drag){OnUi(delegate{if(Bar!=null&&Bar.Visible&&OverlayBlocks(Bar.Bounds,start,end,drag))Bar.Location=ChooseOverlayPosition(Screen.FromPoint(start).WorkingArea,Bar.Size,start,end,drag);});}
  static void PointInside(IntPtr hwnd,int x,int y,bool occlusion) {
    RECT r=occlusion?CaptureRectFor(hwnd):RectFor(hwnd);
    if(x<r.Left||x>=r.Right||y<r.Top||y>=r.Bottom) throw new Exception("Input point is outside the target window.");
    if(occlusion) {
      IntPtr hit=GetAncestor(InputHit(new POINT {X=x,Y=y}),GA_ROOT);
      if(IsWingSurface(hit))throw new Exception("Wing control and approval surfaces are for the user, not an automation target.");
      if(!IsDesktop(hwnd)&&!BelongsToRoot(hit,hwnd))throw new Exception("Input point is covered by another window. Observe again; no input was sent.");
    }
  }
  static bool IsWingSurface(IntPtr hwnd){if(Bar!=null&&Bar.IsHandleCreated&&hwnd==Bar.Handle)return true;var title=new StringBuilder(256);GetWindowText(hwnd,title,title.Capacity);return title.ToString().StartsWith("Wing · ");}
  static INPUT Key(ushort vk,uint flags,ushort scan) { return new INPUT {type=1,u=new INPUTUNION {ki=new KEYBDINPUT {wVk=vk,wScan=scan,dwFlags=flags}}}; }
  static INPUT Mouse(uint flags,int delta) { return new INPUT {type=0,u=new INPUTUNION {mi=new MOUSEINPUT {dwFlags=flags,mouseData=unchecked((uint)delta)}}}; }
  static void Send(params INPUT[] inputs) { uint sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT))); if(sent!=inputs.Length) throw new Exception("Windows rejected input injection (sent "+sent+"/"+inputs.Length+", error "+Marshal.GetLastWin32Error()+"). Input may be partial."); }
  static ushort VirtualKey(string name) {
    string k=name.Trim().ToUpperInvariant();
    if(k.Length==1 && ((k[0]>='A'&&k[0]<='Z')||(k[0]>='0'&&k[0]<='9'))) return (ushort)k[0];
    if(k.StartsWith("NUMPAD")&&k.Length==7&&k[6]>='0'&&k[6]<='9')return (ushort)(0x60+k[6]-'0');
    if(k=="DECIMAL")return 0x6E;
    int f; if(k.StartsWith("F")&&Int32.TryParse(k.Substring(1),out f)&&f>=1&&f<=24) return (ushort)(111+f);
    switch(k) { case "CTRL":case "CONTROL":return 0x11; case "ALT":return 0x12; case "SHIFT":return 0x10; case "WIN":case "META":case "SUPER":return 0x5B; case "ENTER":case "RETURN":return 0x0D; case "TAB":return 9; case "ESC":case "ESCAPE":return 0x1B; case "SPACE":return 0x20; case "BACKSPACE":return 8; case "DELETE":case "DEL":return 0x2E; case "INSERT":return 0x2D; case "LEFT":return 0x25; case "UP":return 0x26; case "RIGHT":return 0x27; case "DOWN":return 0x28; case "HOME":return 0x24; case "END":return 0x23; case "PAGEUP":return 0x21; case "PAGEDOWN":return 0x22; case "CAPSLOCK":return 0x14; case "NUMLOCK":return 0x90; case "PRINTSCREEN":return 0x2C; case "MENU":return 0x5D; case "PAUSE":return 0x13; case "ADD":case "PLUS":return 0x6B; case "SUBTRACT":return 0x6D; case "MULTIPLY":return 0x6A; case "DIVIDE":return 0x6F; case "-":return 0xBD; case "=":return 0xBB; case "[":return 0xDB; case "]":return 0xDD; case "\\":return 0xDC; case ";":return 0xBA; case "'":return 0xDE; case "BACKTICK":return 0xC0; case ",":return 0xBC; case ".":return 0xBE; case "/":return 0xBF; }
    throw new Exception("Unsupported key: "+name);
  }
  ${DESKTOP_TEXT_SOURCE}
  static object Run(Dictionary<string,object> req) {
    if(S(req,"inputMode","physical")!="physical")throw new Exception("Only physical desktop input is supported.");
    string cmd=S(req,"command","");
    if(cmd=="ping") return D("protocolVersion",1,"platform","win32");
    if(cmd=="overlay_start" || cmd=="overlay_update") {
      if(cmd=="overlay_update"&&Stopped)return D("visible",false,"stopped",true);
      if(cmd=="overlay_start") Stopped=false;
      OverlayTitle=S(req,"title",OverlayTitle); OverlayWanted=true;
      OnUi(delegate { if(cmd=="overlay_start"&&SetThreadExecutionState(0x80000003)==0)throw new Exception("Could not keep the interactive display awake."); ShowControl(); });
      return D("visible",true);
    }
    if(cmd=="overlay_stop") { OverlayWanted=false; OnUi(delegate { SetThreadExecutionState(0x80000000); HideControl(); }); return D("visible",false); }
    if(new[]{"list_apps","launch_app","window_info","inspect_window","accessibility","accessibility_input"}.Contains(cmd))return SkyNative(cmd,req);
    if(cmd=="list") {
      var roots=new List<object>(); uint own=(uint)System.Diagnostics.Process.GetCurrentProcess().Id;
      for(int i=0;i<Displays().Length;i++)roots.Add(D("rootRef","desktop:"+i,"windowId",-i,"pid",0,"title",i==0?"Primary display":"Display "+(i+1),"isForeground",Displays()[i].DeviceName==Screen.FromHandle(GetForegroundWindow()).DeviceName,"bounds",Bounds(DesktopRect(new IntPtr(-i)))));
      EnumWindows(delegate(IntPtr h,IntPtr state) { bool visible=IsWindowVisible(h);uint pid; GetWindowThreadProcessId(h,out pid); if(pid==own||IsWingSurface(h))return true; RECT r; GetWindowRect(h,out r); if(r.Right<=r.Left||r.Bottom<=r.Top)return true; var title=new StringBuilder(2048); GetWindowText(h,title,title.Capacity); if(!visible&&(title.Length==0||GetWindow(h,4)!=IntPtr.Zero||(GetWindowLongPtr(h,-20).ToInt64()&0x80)!=0))return true;if(title.Length==0)title.Append("[无标题窗口]"); roots.Add(D("rootRef","visual:"+h.ToInt64()+":"+pid,"windowId",h.ToInt64(),"pid",pid,"processName",ProcessName(pid),"processPath",ProcessPath(pid),"visible",visible,"restorable",RestorableAppWindow(h),"enabled",IsWindowEnabled(h),"ownerWindowId",GetWindow(h,4).ToInt64(),"isForeground",GetAncestor(GetForegroundWindow(),GA_ROOT)==h,"title",title.ToString(),"bounds",Bounds(r),"minimized",IsIconic(h)));return true; },IntPtr.Zero);
      return roots;
    }
    if(cmd=="focus") {
      if(Stopped)throw new Exception("Desktop control stopped by user.");
      IntPtr h=Root(req,false,false,true);
      if(IsDesktop(h))return D("focused",false,"bounds",Bounds(DesktopRect(h)));
      bool restored=IsIconic(h)||!IsWindowVisible(h);
      // Restore and focus only the selected, PID-validated existing window.
      if(restored) {
        ShowWindow(h,SW_RESTORE);
        for(int i=0;i<20&&(IsIconic(h)||!IsWindowVisible(h));i++) {
          if(Stopped)throw new Exception("Desktop control stopped by user.");
          Thread.Sleep(25);Root(req,false,false,true);
        }
      }
      Root(req,false,false);
      if(IsIconic(h))throw new Exception("Application did not restore its window. Observe its current state before retrying; do not launch another instance.");
      if(Stopped)throw new Exception("Desktop control stopped by user.");
      if(!BelongsToRoot(GetAncestor(GetForegroundWindow(),GA_ROOT),h)){SetForegroundWindow(h);Thread.Sleep(90);}
      Root(req,false,false);if(Stopped)throw new Exception("Desktop control stopped by user.");
      if(!BelongsToRoot(GetAncestor(GetForegroundWindow(),GA_ROOT),h))throw new Exception("Windows did not allow focusing this window. User action may be required.");
      return D("focused",true,"restored",restored,"bounds",Bounds(RectFor(h)));
    }
    if(cmd=="capture") {
      bool composed=true;IntPtr h=Root(req,composed,false); if(IsIconic(h))throw new Exception("目标窗口已最小化，请先还原。"); RECT rect=RectFor(h),viewport=composed?CaptureRectFor(h):rect;IntPtr observedForeground=GetForegroundWindow();
      int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
      int x=!composed?viewport.Left:Math.Max(viewport.Left,vx),y=!composed?viewport.Top:Math.Max(viewport.Top,vy),w=!composed?viewport.Right-viewport.Left:Math.Min(viewport.Right,vx+vw)-x,hh=!composed?viewport.Bottom-viewport.Top:Math.Min(viewport.Bottom,vy+vh)-y;
      if(w<=0||hh<=0||((long)w)*hh>100000000)throw new Exception("Target is outside the visible desktop or its image is too large.");
      OnUi(delegate {HideControl();});
      DwmFlush(); // Flush after hiding our decorations, before reading composition.
      try { using(var bmp=new Bitmap(w,hh)) { CaptureVisiblePixels(bmp,x,y);Root(req,composed,false);if(composed)Check(h);RECT after=RectFor(h);if(!SameRect(rect,after)||(composed&&(!SameRect(viewport,CaptureRectFor(h))||observedForeground!=GetForegroundWindow())))throw new Exception("Target or popup changed while capturing. Discard this image and observe again.");using(var stream=new MemoryStream()) {bmp.Save(stream,ImageFormat.Png);var c=new CURSORINFO {cbSize=Marshal.SizeOf(typeof(CURSORINFO))};GetCursorInfo(ref c);return D("base64",Convert.ToBase64String(stream.ToArray()),"mimeType","image/png","width",w,"height",hh,"originX",x,"originY",y,"bounds",Bounds(rect),"foregroundWindowId",observedForeground.ToInt64(),"regions",ScreenRegions(rect),"coordinateSpace","physical-screen-pixels","cursor",D("x",c.ptScreenPos.X,"y",c.ptScreenPos.Y,"visible",(c.flags&1)!=0));}} }
      finally {OnUi(delegate {if(OverlayWanted&&!Stopped)ShowControl();});}
    }
    if(cmd!="input")throw new Exception("Unsupported command.");
    IntPtr hwnd=Root(req,true,true);uint expectedPid=Convert.ToUInt32(((Dictionary<string,object>)req["root"])["pid"]);Check(hwnd,expectedPid);if(!OverlayWanted)throw new Exception("Start the visible desktop control overlay before sending input.");
    var action=(Dictionary<string,object>)req["action"]; var p=Get(action,"params",new Dictionary<string,object>()) as Dictionary<string,object>;
    string kind=S(action,"kind","");
    if(kind=="typeText"||kind=="keypress"){var observed=(Dictionary<string,object>)req["root"];long expected=Convert.ToInt64(Get(observed,"foregroundWindowId",-1));IntPtr active=GetForegroundWindow();if(expected<1||active.ToInt64()!=expected||IsWingSurface(active))throw new Exception("Keyboard focus changed since the screenshot (expected "+expected+", current "+active.ToInt64()+"). Observe again before typing.");hwnd=GetAncestor(active,GA_ROOT);GetWindowThreadProcessId(hwnd,out expectedPid);}
    int px=N(action,"x",0),py=N(action,"y",0); bool hasPoint=action.ContainsKey("x")&&action.ContainsKey("y");
    if(kind=="click"||kind=="moveMouse"||kind=="drag"||kind=="scroll") {
      if(!hasPoint)throw new Exception("Pointer action requires x and y in physical screen pixels.");var endpoint=kind=="drag"?new Point(N(p,"toX",px),N(p,"toY",py)):new Point(px,py);KeepOverlayClear(new Point(px,py),endpoint,kind=="drag");PointInside(hwnd,px,py,true);Root(req,true,true);Check(hwnd,expectedPid);if(!SetCursorPos(px,py))throw new Exception("Windows rejected moving the cursor (error "+Marshal.GetLastWin32Error()+").");Check(hwnd,expectedPid);
    }
    if(kind=="click") {
      string button=S(p,"button","left");uint down,up;if(button=="left"){down=2;up=4;}else if(button=="right"){down=8;up=16;}else if(button=="middle"){down=32;up=64;}else throw new Exception("Unsupported mouse button.");
      int clicks=N(p,"clickCount",Convert.ToBoolean(Get(p,"doubleClick",false))?2:1);if(clicks<1||clicks>3)throw new Exception("clickCount must be 1, 2 or 3.");
      for(int i=0;i<clicks;i++){Check(hwnd,expectedPid);PointInside(hwnd,px,py,true);Root(req,true,true);Check(hwnd,expectedPid);try{Send(Mouse(down,0));Thread.Sleep(35);}finally{Send(Mouse(up,0));}if(i+1<clicks)Thread.Sleep(65);}
    } else if(kind=="moveMouse") {
    } else if(kind=="scroll") {
      int dy=N(p,"deltaY",-120),dx=N(p,"deltaX",0);if(dy!=0){Root(req,true,true);Check(hwnd,expectedPid);Send(Mouse(0x800,dy));}if(dx!=0){Root(req,true,true);Check(hwnd,expectedPid);Send(Mouse(0x1000,dx));}
    } else if(kind=="drag") {
      int tx=N(p,"toX",px),ty=N(p,"toY",py);PointInside(hwnd,tx,ty,true);int duration=Math.Min(5000,Math.Max(50,N(p,"durationMs",350))),steps=Math.Max(2,duration/16);
      Root(req,true,true);Check(hwnd,expectedPid);try{Send(Mouse(2,0));for(int i=1;i<=steps;i++){Check(hwnd,expectedPid);if(!SetCursorPos(px+(tx-px)*i/steps,py+(ty-py)*i/steps))throw new Exception("Cursor movement failed.");Thread.Sleep(duration/steps);}}finally{Send(Mouse(4,0));}
    } else if(kind=="typeText") {
      string text=S(p,"text","");if(text.Any(c=>c>127))PasteLiteralText(req,hwnd,expectedPid,text);else foreach(char c in text){Root(req,true,true);CheckKeyboard(hwnd,expectedPid);Send(Key(0,UNICODE,c),Key(0,UNICODE|KEYUP,c));}
    } else if(kind=="keypress") {
      string chord=S(p,"key","");var held=new List<ushort>();var parts=chord.Split('+');if(parts.Length==0||chord.Trim().Length==0)throw new Exception("keypress requires key.");
      var keys=new List<ushort>();object mods; if(p.TryGetValue("modifiers",out mods)&&mods is System.Collections.IEnumerable && !(mods is string))foreach(object mod in (System.Collections.IEnumerable)mods)keys.Add(VirtualKey(Convert.ToString(mod)));foreach(string part in parts)keys.Add(VirtualKey(part));
      try{foreach(ushort key in keys){CheckKeyboard(hwnd,expectedPid);Send(Key(key,0,0));held.Add(key);}}finally{Exception releaseError=null;for(int i=held.Count-1;i>=0;i--){try{Send(Key(held[i],KEYUP,0));}catch(Exception e){releaseError=e;}}if(releaseError!=null)throw releaseError;}
    } else throw new Exception("Unsupported input kind: "+kind);
    return D("performed",true,"kind",kind,"verification","Input delivered; inspect a new screenshot to verify the result.");
  }
  static void Stop() {if(Stopped||!OverlayWanted)return;Stopped=true;OverlayWanted=false;SetThreadExecutionState(0x80000000);HideControl();Emit(D("event","stop","reason","user"));}
  class HotkeyControl:Control {protected override void WndProc(ref Message m){if(m.Msg==0x0312&&m.WParam.ToInt32()==773)Stop();base.WndProc(ref m);}}
  ${DESKTOP_OVERLAY_SOURCE}
  [STAThread] public static void Main(){
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{try{SetProcessDPIAware();}catch{}}
    Application.EnableVisualStyles();Ui=new HotkeyControl();IntPtr handle=Ui.Handle;RegisterHotKey(handle,773,0x0002|0x0001,0x1B);
    var commands=new BlockingCollection<Dictionary<string,object>>();
    var worker=new Thread(delegate(){foreach(var req in commands.GetConsumingEnumerable()){object id=Get(req,"id",null);try{var result=Run(req);Emit(D("id",id,"ok",true,"result",result));}catch(Exception e){Emit(D("id",id,"ok",false,"error",e.Message));}}OnUi(delegate{Application.ExitThread();});});worker.IsBackground=true;worker.Start();
    var reader=new Thread(delegate(){string line;while((line=Console.ReadLine())!=null){object id=null;try{var req=new JavaScriptSerializer {MaxJsonLength=64000000}.Deserialize<Dictionary<string,object>>(line);id=Get(req,"id",null);if(S(req,"command","")=="cancel"){Stopped=true;OverlayWanted=false;OnUi(delegate{SetThreadExecutionState(0x80000000);HideControl();});Emit(D("id",id,"ok",true,"result",D("stopped",true)));}else commands.Add(req);}catch(Exception e){Emit(D("id",id,"ok",false,"error",e.Message));}}Stopped=true;commands.CompleteAdding();});reader.IsBackground=true;reader.Start();Application.Run();HideControl();SetThreadExecutionState(0x80000000);UnregisterHotKey(handle,773);
  }
}
`;
