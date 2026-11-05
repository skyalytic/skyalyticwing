using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
public static class FixtureClipboard {
  public static uint Sequence=0;public static IDataObject Current;public static string Pasted;public static bool ConcurrentCopy;
  public static IDataObject GetDataObject(){return Current;}
  public static void SetDataObject(object data,bool copy,int retries,int delay){Current=(IDataObject)data;Sequence++;}
  public static void Clear(){Current=null;Sequence++;}
}
public class NativeFixture:Form {
  protected override bool ShowWithoutActivation{get{return true;}}
  static Dictionary<string,object> D(params object[] p){var d=new Dictionary<string,object>();for(int i=0;i<p.Length;i+=2)d[(string)p[i]]=p[i+1];return d;}
  static object Call(string name,params object[] args){try{return typeof(WingVisualDesktop).GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
  static void Reject(Action action,string text){try{action();}catch(Exception e){if(e.Message.Contains(text))return;throw;}throw new Exception("Expected: "+text);}
  static void Field(string n,object v){typeof(WingVisualDesktop).GetField(n,BindingFlags.Static|BindingFlags.NonPublic).SetValue(null,v);}
  [STAThread] public static int Main(){try {Test();return 0;}catch(Exception e){Console.WriteLine(e);return 1;}}
  static void Test(){using(var f=new NativeFixture()){
    f.Text="Physical driver fixture";f.ShowInTaskbar=false;f.StartPosition=FormStartPosition.Manual;f.Bounds=new Rectangle(-30000,-30000,400,250);f.Show();
    uint pid=(uint)System.Diagnostics.Process.GetCurrentProcess().Id;WingVisualDesktop.FixtureForeground=f.Handle;WingVisualDesktop.FixtureHit=f.Handle;
    var root=D("windowId",f.Handle.ToInt64(),"pid",pid,"rootRef","visual:"+f.Handle+":"+pid,"bounds",D("x",f.Left,"y",f.Top,"width",f.Width,"height",f.Height),"foregroundWindowId",f.Handle.ToInt64());
    Field("Ui",f);Field("OverlayWanted",true);
    var fresh=(Dictionary<string,object>)Call("Run",D("command","inspect_window","root",root));
    if(Convert.ToInt64(fresh["windowId"])!=f.Handle.ToInt64())throw new Exception("Identity mismatch");
    Call("Run",D("command","input","root",root,"action",D("kind","click","x",f.Left+100,"y",f.Top+90)));
    if(WingVisualDesktop.Pointer.X!=f.Left+100||WingVisualDesktop.Pointer.Y!=f.Top+90||WingVisualDesktop.Inputs.Count!=2||WingVisualDesktop.Inputs[0].u.mi.dwFlags!=2||WingVisualDesktop.Inputs[1].u.mi.dwFlags!=4)throw new Exception("Physical pointer/click contract failed");
    var oldClipboard=new DataObject();oldClipboard.SetData(DataFormats.UnicodeText,false,"previous clipboard");oldClipboard.SetData("Fixture.Binary",false,new System.IO.MemoryStream(new byte[]{7,8,9}));FixtureClipboard.SetDataObject(oldClipboard,true,3,20);
    WingVisualDesktop.Inputs.Clear();Call("Run",D("command","input","root",root,"action",D("kind","typeText","params",D("text","文宇🧪"))));
    if(WingVisualDesktop.Inputs.Count!=4||WingVisualDesktop.Inputs[0].u.ki.wVk!=0x11||WingVisualDesktop.Inputs[1].u.ki.wVk!=0x56||WingVisualDesktop.Inputs[3].u.ki.dwFlags!=2||FixtureClipboard.Pasted!="文宇🧪")throw new Exception("Unicode paste contract failed");
    if(Convert.ToString(FixtureClipboard.Current.GetData(DataFormats.UnicodeText))!="previous clipboard"||((System.IO.MemoryStream)FixtureClipboard.Current.GetData("Fixture.Binary",false)).ToArray()[2]!=9)throw new Exception("Clipboard restoration failed");
    FixtureClipboard.ConcurrentCopy=true;Call("Run",D("command","input","root",root,"action",D("kind","typeText","params",D("text","另一个字段"))));FixtureClipboard.ConcurrentCopy=false;
    if(Convert.ToString(FixtureClipboard.Current.GetData(DataFormats.UnicodeText))!="concurrent copy")throw new Exception("A concurrent copy was overwritten");
    WingVisualDesktop.Inputs.Clear();Call("Run",D("command","input","root",root,"action",D("kind","typeText","params",D("text","AB"))));
    if(WingVisualDesktop.Inputs.Count!=4||WingVisualDesktop.Inputs[0].u.ki.wScan!='A'||WingVisualDesktop.Inputs[2].u.ki.wScan!='B')throw new Exception("Literal ASCII contract failed");
    WingVisualDesktop.Inputs.Clear();var wrong=new Dictionary<string,object>(root);wrong["pid"]=1;
    Reject(()=>Call("Run",D("command","inspect_window","root",wrong)),"reused");
    Reject(()=>Call("Run",D("command","input","inputMode","virtual","root",root)),"Only physical");
    Field("Stopped",true);Reject(()=>Call("Run",D("command","input","root",root,"action",D("kind","click","x",f.Left+100,"y",f.Top+90))),"stopped");
    if(WingVisualDesktop.Inputs.Count!=0)throw new Exception("Stopped/reused request injected input");Field("Stopped",false);
    // Render the actual control class offscreen for visual QA; no real desktop pixels.
    var type=typeof(WingVisualDesktop).GetNestedType("StopBar",BindingFlags.NonPublic);
    using(var panel=(Form)Activator.CreateInstance(type,true))using(var image=new Bitmap(panel.Width,panel.Height)){panel.Location=new Point(-30000,-30000);panel.Show();Application.DoEvents();panel.DrawToBitmap(image,new Rectangle(Point.Empty,panel.Size));image.Save(Environment.GetEnvironmentVariable("WING_PANEL_PREVIEW"));panel.Hide();}
    // The OS cursor is hidden in this fixture; the real-position accent must remain visible.
    var accentType=typeof(WingVisualDesktop).GetNestedType("PointerAccent",BindingFlags.NonPublic);
    using(var accent=(Form)Activator.CreateInstance(accentType,true)){
      Field("Accent",accent);WingVisualDesktop.Pointer=new Point(f.Left+100,f.Top+90);
      accentType.GetMethod("Follow").Invoke(accent,null);Application.DoEvents();
      if(!accent.Visible||accent.Location!=WingVisualDesktop.Pointer)throw new Exception("Hidden system cursor lost its accent");
      WingVisualDesktop.FixtureHit=accent.Handle;
      Call("PointInside",f.Handle,f.Left+100,f.Top+90,true);
      if(!accent.Visible)throw new Exception("Pointer accent was not restored after hit-testing");
      using(var preview=new Bitmap(accent.Width,accent.Height)){accent.DrawToBitmap(preview,new Rectangle(Point.Empty,accent.Size));preview.Save(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Environment.GetEnvironmentVariable("WING_PANEL_PREVIEW")),"pointer.png"));}
      accent.Hide();Field("Accent",null);WingVisualDesktop.FixtureHit=f.Handle;
    }
    // Capture only fixture-owned pixels, including a layered child surface.
    using(var background=new NativeFixture())using(var layer=new NativeFixture()){
      background.TopMost=true;background.FormBorderStyle=FormBorderStyle.None;background.StartPosition=FormStartPosition.Manual;background.ShowInTaskbar=false;
      var area=Screen.PrimaryScreen.WorkingArea;background.Bounds=new Rectangle(area.Left+40,area.Top+80,300,160);background.BackColor=Color.Lime;background.Show();
      layer.TopMost=true;layer.FormBorderStyle=FormBorderStyle.None;layer.StartPosition=FormStartPosition.Manual;layer.ShowInTaskbar=false;layer.Bounds=new Rectangle(background.Left+70,background.Top+50,100,60);layer.BackColor=Color.Red;layer.Opacity=.9;layer.Show(background);
      Application.DoEvents();System.Threading.Thread.Sleep(80);Call("DwmFlush");
      using(var captured=new Bitmap(100,60)){Call("CaptureVisiblePixels",captured,layer.Left,layer.Top);var pixel=captured.GetPixel(50,30);if(pixel.R<150||pixel.G>100)throw new Exception("Layered pixels missing from native capture: "+pixel);captured.Save(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Environment.GetEnvironmentVariable("WING_PANEL_PREVIEW")),"layered-capture.png"));}
      layer.Hide();background.Hide();
    }
    Field("OverlayWanted",false);f.Hide();
    Console.WriteLine("PASS: real pointer, click, Unicode, PID validation, stop; no live application input.");
  }}
}
