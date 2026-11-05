using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Only this offscreen fixture is restored. The test adapter blocks global input,
// foreground changes and process creation; production handle/PID checks still run.
public class TrayFixture:Form {
  static Rectangle PopupBounds;
  public static void CopyOwnedFixture(Graphics graphics,int x,int y,int width,int height){
    // Synthetic compositor: no real desktop pixels or global input are accessed.
    graphics.Clear(Color.Green);graphics.FillRectangle(Brushes.Red,new Rectangle(PopupBounds.X-x,PopupBounds.Y-y,PopupBounds.Width,PopupBounds.Height));
  }
  protected override bool ShowWithoutActivation {get{return true;}}
  protected override CreateParams CreateParams {get{var p=base.CreateParams;p.Style&=~0x80000;return p;}} // Custom chrome without WS_SYSMENU.
  static Dictionary<string,object> D(params object[] pairs){var d=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1];return d;}
  static object Call(string method,params object[] args){try{return typeof(WingVisualDesktop).GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
  static void Reject(Action action,string text){try{action();}catch(Exception e){if(e.Message.Contains(text))return;throw;}throw new Exception("Expected rejection: "+text);}
  [STAThread] public static int Main(){try{return Test();}catch(Exception e){Console.WriteLine(e.ToString());return 1;}}
  static int Test(){
    // Invented application names exercise generic launcher relationships, not an app allowlist.
    var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase){@"D:\Suite\Nimbus\app-9.2\Nimbus.exe"};
    if(!(bool)Call("AppIsRunning",@"d:/Suite/Nimbus/Nimbus.exe",paths))throw new Exception("Packaged launcher association failed");
    if((bool)Call("AppIsRunning",@"D:\Other\Nimbus.exe",paths)||(bool)Call("AppIsRunning",@"D:\Suite\Nimbu\Nimbus.exe",paths)||(bool)Call("AppIsRunning",@"D:\Nimbus.exe",paths)||(bool)Call("AppIsRunning",@"D:\Suite\Nimbus\Other.exe",paths))throw new Exception("Unrelated executable became an alias");
    using(var main=new TrayFixture())using(var sink=new TrayFixture()){
      main.Text="Tray fixture main";main.StartPosition=FormStartPosition.Manual;main.Location=new Point(-30000,-30000);main.Size=new Size(320,240);main.ShowInTaskbar=true;
      IntPtr hwnd=main.Handle;main.Hide();
      sink.Text="Tray message sink";sink.FormBorderStyle=FormBorderStyle.None;sink.ControlBox=false;sink.ShowInTaskbar=false;IntPtr sinkHandle=sink.Handle;
      if(!(bool)Call("RestorableAppWindow",hwnd)||(bool)Call("RestorableAppWindow",sinkHandle))throw new Exception("Hidden main/helper classification failed");
      var roots=(List<object>)Call("Run",D("command","list","inputMode","physical"));Dictionary<string,object> root=null;
      foreach(Dictionary<string,object> item in roots)if(Convert.ToInt64(item["windowId"])==hwnd.ToInt64())root=item;
      if(root==null||(bool)root["visible"]||!(bool)root["restorable"])throw new Exception("Hidden main window missing from inventory");
      Reject(()=>Call("Root",D("root",root),false,false,false),"hidden");
      var wrong=new Dictionary<string,object>(root);wrong["pid"]=1;
      Reject(()=>Call("Run",D("command","focus","root",wrong,"inputMode","physical")),"reused");
      var result=(Dictionary<string,object>)Call("Run",D("command","focus","root",root,"inputMode","physical"));
      if(!(bool)result["focused"]||!main.Visible)throw new Exception("Existing hidden main window was not restored");
      if(WingVisualDesktop.FixtureRestoreCount!=1)throw new Exception("Unexpected restore count");
      string executable=System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
      Reject(()=>Call("SkyNative","launch_app",D("app",executable)),"already running");
      using(var popup=new TrayFixture())using(var unrelated=new TrayFixture()){
        popup.Text="Fixture search results";popup.Owner=main;popup.StartPosition=FormStartPosition.Manual;popup.Bounds=new Rectangle(main.Right-30,main.Top-40,240,180);popup.ShowInTaskbar=false;popup.Show();
        unrelated.Text="Unrelated fixture";unrelated.StartPosition=FormStartPosition.Manual;unrelated.Bounds=new Rectangle(main.Left-800,main.Top-700,200,200);unrelated.ShowInTaskbar=false;unrelated.Show();
        PopupBounds=popup.Bounds;
        WingVisualDesktop.FixtureForeground=popup.Handle;int focusCount=WingVisualDesktop.FixtureFocusCount;
        Call("Run",D("command","focus","root",root,"inputMode","physical"));
        if(WingVisualDesktop.FixtureFocusCount!=focusCount||WingVisualDesktop.FixtureForeground!=popup.Handle)throw new Exception("Parent activation stole popup focus");
        var viewport=(WingVisualDesktop.RECT)Call("CaptureRectFor",hwnd);
        if(viewport.Left!=main.Left||viewport.Top!=popup.Top||viewport.Right!=popup.Right||viewport.Bottom!=main.Bottom)throw new Exception("Owned popup missing, or unrelated window included");
        WingVisualDesktop.FixtureHit=popup.Handle;
        Call("PointInside",hwnd,popup.Right-5,popup.Top+5,true);
        WingVisualDesktop.FixtureHit=unrelated.Handle;
        Reject(()=>Call("PointInside",hwnd,popup.Right-5,popup.Top+5,true),"covered");
        typeof(WingVisualDesktop).GetField("Ui",BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,main);
        var capture=(Dictionary<string,object>)Call("Run",D("command","capture","root",root,"inputMode","physical"));
        if(Convert.ToInt32(capture["originX"])!=viewport.Left||Convert.ToInt32(capture["originY"])!=viewport.Top||Convert.ToInt32(capture["width"])!=viewport.Right-viewport.Left||Convert.ToInt64(capture["foregroundWindowId"])!=popup.Handle.ToInt64())throw new Exception("Popup capture lost its origin or focus");
        var bounds=(Dictionary<string,object>)capture["bounds"];
        if(Convert.ToInt32(bounds["x"])!=main.Left||Convert.ToInt32(bounds["y"])!=main.Top)throw new Exception("Capture viewport replaced target geometry");
        using(var stream=new MemoryStream(Convert.FromBase64String((string)capture["base64"])))using(var bitmap=new Bitmap(stream)){
          if(bitmap.GetPixel(popup.Right-viewport.Left-5,5).ToArgb()!=Color.Red.ToArgb())throw new Exception("Popup pixels cropped out of composition");
        }
        popup.Hide();var without=(WingVisualDesktop.RECT)Call("CaptureRectFor",hwnd);
        if(without.Left!=main.Left||without.Right!=main.Right||without.Top!=main.Top)throw new Exception("Hidden popup expanded the screenshot");
        unrelated.Hide();
      }
      main.Hide();sink.Hide();
    }
    Console.WriteLine("PASS: hidden main restored, popup composed without focus theft, unrelated window excluded, reused PID rejected, running app not relaunched.");return 0;
  }
}
