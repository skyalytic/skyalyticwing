/** Wing-owned accessibility and application inventory, used only by the installed desktop extension. */
export const SKY_NATIVE_SOURCE = String.raw`
  static readonly Dictionary<int,System.Windows.Automation.AutomationElement> Elements = new Dictionary<int,System.Windows.Automation.AutomationElement>();
  static string ElementSnapshot;
  static IntPtr ElementWindow;
  static string ProcessPath(uint pid) {
    IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return "";
    try{uint size=32768;var image=new StringBuilder((int)size);return QueryFullProcessImageName(process,0,image,ref size)?image.ToString():"";}finally{CloseHandle(process);}
  }
  static HashSet<string> RunningAppPaths() {
    var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    int session=System.Diagnostics.Process.GetCurrentProcess().SessionId;
    foreach(var process in System.Diagnostics.Process.GetProcesses()) {
      try { if(process.SessionId!=session)continue;string path=ProcessPath((uint)process.Id);if(path.Length>0)paths.Add(path); }
      catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){}finally{process.Dispose();}
    }
    return paths;
  }
  static bool AppProcessMatches(string app,string processPath) {
    if(!Path.IsPathRooted(app))return String.Equals(Path.GetFileName(processPath),app,StringComparison.OrdinalIgnoreCase);
    string executable=Path.GetFullPath(app),running=Path.GetFullPath(processPath);
    if(String.Equals(executable,running,StringComparison.OrdinalIgnoreCase))return true;
    // A packaged launcher can live above an app/version subdirectory. This is a
    // candidate relationship, never proof of a main window or a logged-in user.
    // Require both the executable filename and a bounded installation directory;
    // same-title apps elsewhere and drive-root launchers do not become aliases.
    string folder=Path.GetDirectoryName(executable),root=Path.GetPathRoot(executable);
    if(String.Equals(folder.TrimEnd('\\','/'),root.TrimEnd('\\','/'),StringComparison.OrdinalIgnoreCase))return false;
    return String.Equals(Path.GetFileName(executable),Path.GetFileName(running),StringComparison.OrdinalIgnoreCase)
      &&running.StartsWith(folder+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
  }
  static bool AppIsRunning(string app,HashSet<string> paths) {
    return paths.Any(path=>AppProcessMatches(app,path));
  }
  static bool RestorableAppWindow(IntPtr hwnd) {
    if(!IsWindow(hwnd)||GetWindow(hwnd,4)!=IntPtr.Zero)return false;
    long style=GetWindowLongPtr(hwnd,-16).ToInt64(),extended=GetWindowLongPtr(hwnd,-20).ToInt64();
    if((extended&0x80)!=0)return false; // WS_EX_TOOLWINDOW, including hidden tray message sinks.
    var title=new StringBuilder(2048);GetWindowText(hwnd,title,title.Capacity);
    // Custom chrome (including Qt main windows) can omit WS_SYSMENU while
    // retaining sizing/minimize/maximize styles. Caption alone also matches
    // hidden tray message sinks, so it is deliberately insufficient.
    return title.Length>0&&(IsIconic(hwnd)||(style&0xF0000)!=0||(extended&0x40000)!=0);
  }
  static List<object> InstalledApps() {
    var result=new List<object>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var shellType=Type.GetTypeFromProgID("WScript.Shell");object shell=shellType==null?null:Activator.CreateInstance(shellType);
    try {
    foreach(var folder in new[]{Environment.SpecialFolder.Programs,Environment.SpecialFolder.CommonPrograms}) {
      string root=Environment.GetFolderPath(folder);if(!Directory.Exists(root))continue;
      var dirs=new Stack<string>();dirs.Push(root);
      while(dirs.Count>0){string dir=dirs.Pop();try{
        foreach(string child in Directory.GetDirectories(dir))if((File.GetAttributes(child)&FileAttributes.ReparsePoint)==0)dirs.Push(child);
        foreach(string file in Directory.GetFiles(dir,"*.lnk")){
          string id=file;object shortcut=null;
          try{if(shell!=null){shortcut=shellType.InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{file});string target=Convert.ToString(shortcut.GetType().InvokeMember("TargetPath",System.Reflection.BindingFlags.GetProperty,null,shortcut,null));if(target.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))id=target;}}catch(System.Reflection.TargetInvocationException){}catch(COMException){}finally{if(shortcut!=null&&Marshal.IsComObject(shortcut))Marshal.FinalReleaseComObject(shortcut);}
          if(seen.Add(id))result.Add(D("id",id,"displayName",Path.GetFileNameWithoutExtension(file)));
        }
      }catch(UnauthorizedAccessException){}catch(IOException){}}
    }
    return result;
    }finally{if(shell!=null&&Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);}
  }
  static object SkyNative(string command,Dictionary<string,object> req) {
    CheckDesktop();
    if(command=="inspect_window") {
      IntPtr inspected=Root(req,false,false,true);var original=(Dictionary<string,object>)req["root"];
      var live=new Dictionary<string,object>(original);live["bounds"]=Bounds(RectFor(inspected));
      live["foregroundWindowId"]=GetForegroundWindow().ToInt64();
      live["visible"]=IsDesktop(inspected)||IsWindowVisible(inspected);live["minimized"]=!IsDesktop(inspected)&&IsIconic(inspected);
      return live;
    }
    if(command=="list_apps") {
      var apps=InstalledApps();var running=RunningAppPaths();
      foreach(Dictionary<string,object> app in apps) {
        var matches=running.Where(path=>AppProcessMatches(S(app,"id",""),path)).OrderBy(path=>path,StringComparer.OrdinalIgnoreCase).ToArray();
        app["isRunning"]=matches.Length>0;app["runningAppIds"]=matches;
      }
      return apps;
    }
    if(command=="launch_app") {
      string app=S(req,"app","");bool listed=false;
      foreach(Dictionary<string,object> item in InstalledApps())if(String.Equals(S(item,"id",""),app,StringComparison.OrdinalIgnoreCase)){listed=true;break;}
      if(!listed&&!app.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new Exception("App identifier is not in the installed inventory.");
      if(app.IndexOfAny(new[]{'\r','\n','\"','<','>','|'})>=0)throw new Exception("Invalid application identifier.");
      // Recheck immediately before Process.Start, including processes with no HWND.
      if(AppIsRunning(app,RunningAppPaths()))throw new Exception("Application is already running. Refresh its windows and restore the existing instance; no new process was started.");
      System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(app){UseShellExecute=true});return D("launched",true);
    }
    IntPtr hwnd=Root(req,false,true);
    if(command=="window_info")return D("bounds",Bounds(RectFor(hwnd)),"foregroundWindowId",GetForegroundWindow().ToInt64(),"foregroundBelongsToTarget",!IsDesktop(hwnd)&&BelongsToRoot(GetAncestor(GetForegroundWindow(),GA_ROOT),hwnd));
    if(command=="accessibility") {
      Elements.Clear();ElementSnapshot=Guid.NewGuid().ToString();ElementWindow=hwnd;
      var lines=new List<string>();var selected=new List<string>();var result=D("snapshotId",ElementSnapshot);var walker=System.Windows.Automation.TreeWalker.ControlViewWalker;
      var pending=new Stack<KeyValuePair<System.Windows.Automation.AutomationElement,int>>();
      pending.Push(new KeyValuePair<System.Windows.Automation.AutomationElement,int>(System.Windows.Automation.AutomationElement.FromHandle(hwnd),0));
      while(pending.Count>0){CheckDesktop();var pair=pending.Pop();var element=pair.Key;try{
        var c=element.Current;if(c.IsOffscreen)continue;if(c.IsPassword)throw new Exception("Password UI cannot be observed by Computer Use.");
        int index=Elements.Count;Elements[index]=element;object pattern;var actions=new List<string>();
        if(c.IsKeyboardFocusable)actions.Add("Raise");
        if(element.TryGetCurrentPattern(System.Windows.Automation.ExpandCollapsePattern.Pattern,out pattern)){actions.Add("Expand");actions.Add("Collapse");}
        if(element.TryGetCurrentPattern(System.Windows.Automation.ScrollPattern.Pattern,out pattern)){var scroll=(System.Windows.Automation.ScrollPattern)pattern;if(scroll.Current.VerticallyScrollable){actions.Add("Scroll Up");actions.Add("Scroll Down");}if(scroll.Current.HorizontallyScrollable){actions.Add("Scroll Left");actions.Add("Scroll Right");}}
        string line=index+": "+c.ControlType.ProgrammaticName.Replace("ControlType.","")+" "+c.Name;
        if(element.TryGetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern,out pattern))line+=" value="+((System.Windows.Automation.ValuePattern)pattern).Current.Value;
        if(actions.Count>0)line+=" ["+String.Join(", ",actions.ToArray())+"]";
        lines.Add(new string('\t',pair.Value)+line);if(c.HasKeyboardFocus)result["focused_element"]=line;
        if(element.TryGetCurrentPattern(System.Windows.Automation.SelectionItemPattern.Pattern,out pattern)&&((System.Windows.Automation.SelectionItemPattern)pattern).Current.IsSelected)selected.Add(line);
        if(element.TryGetCurrentPattern(System.Windows.Automation.TextPattern.Pattern,out pattern)){
          var text=(System.Windows.Automation.TextPattern)pattern;
          if(c.HasKeyboardFocus||!result.ContainsKey("document_text"))result["document_text"]=text.DocumentRange.GetText(-1);
          if(c.HasKeyboardFocus){var ranges=text.GetSelection();var values=new List<string>();foreach(var range in ranges)values.Add(range.GetText(-1));result["selected_text"]=String.Join("\n",values.ToArray());}
        }
        var children=new List<System.Windows.Automation.AutomationElement>();var child=walker.GetFirstChild(element);while(child!=null){children.Add(child);child=walker.GetNextSibling(child);}
        for(int i=children.Count-1;i>=0;i--)pending.Push(new KeyValuePair<System.Windows.Automation.AutomationElement,int>(children[i],pair.Value+1));
      }catch(System.Windows.Automation.ElementNotAvailableException){}}
      result["tree"]=String.Join("\n",lines.ToArray());result["selected_elements"]=selected;return result;
    }
    if(command=="accessibility_input") {
      Check(hwnd,Convert.ToUInt32(((Dictionary<string,object>)req["root"])["pid"]));
      if(!OverlayWanted)throw new Exception("Desktop control overlay is not active.");
      if(ElementWindow!=hwnd||ElementSnapshot!=S(req,"snapshotId",""))throw new Exception("Accessibility observation expired.");
      System.Windows.Automation.AutomationElement element;if(!Elements.TryGetValue(N(req,"index",-1),out element))throw new Exception("Unknown element index.");
      Elements.Clear();ElementSnapshot=null;var c=element.Current;if(c.IsPassword||!c.IsEnabled||c.IsOffscreen)throw new Exception("Element is not targetable.");
      string action=S(req,"action","").ToLowerInvariant();object pattern;
      if(action=="set_value"&&element.TryGetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern,out pattern))((System.Windows.Automation.ValuePattern)pattern).SetValue(S(req,"value",""));
      else if(action=="click") {
        if(S(req,"button","left")!="left"||N(req,"clickCount",1)!=1){var point=element.GetClickablePoint();return Run(D("command","input","inputMode","physical","root",Get(req,"root",null),"action",D("kind","click","x",(int)point.X,"y",(int)point.Y,"params",D("button",S(req,"button","left"),"clickCount",N(req,"clickCount",1)))));}
        else if(element.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern,out pattern))((System.Windows.Automation.InvokePattern)pattern).Invoke();
        else if(element.TryGetCurrentPattern(System.Windows.Automation.SelectionItemPattern.Pattern,out pattern))((System.Windows.Automation.SelectionItemPattern)pattern).Select();
        else if(element.TryGetCurrentPattern(System.Windows.Automation.TogglePattern.Pattern,out pattern))((System.Windows.Automation.TogglePattern)pattern).Toggle();
        else {var point=element.GetClickablePoint();var box=RectFor(hwnd);return Run(D("command","input","inputMode","physical","root",Get(req,"root",null),"action",D("kind","click","x",(int)point.X,"y",(int)point.Y,"params",D("button",S(req,"button","left"),"clickCount",N(req,"clickCount",1)))));}
      }
      else if(action=="raise")element.SetFocus();
      else if((action=="expand"||action=="collapse")&&element.TryGetCurrentPattern(System.Windows.Automation.ExpandCollapsePattern.Pattern,out pattern)){var p=(System.Windows.Automation.ExpandCollapsePattern)pattern;if(action=="expand")p.Expand();else p.Collapse();}
      else if(action.StartsWith("scroll ")&&element.TryGetCurrentPattern(System.Windows.Automation.ScrollPattern.Pattern,out pattern)){
        var p=(System.Windows.Automation.ScrollPattern)pattern;var no=System.Windows.Automation.ScrollAmount.NoAmount;var up=System.Windows.Automation.ScrollAmount.LargeDecrement;var down=System.Windows.Automation.ScrollAmount.LargeIncrement;
        if(action=="scroll up")p.Scroll(no,up);else if(action=="scroll down")p.Scroll(no,down);else if(action=="scroll left")p.Scroll(up,no);else if(action=="scroll right")p.Scroll(down,no);else throw new Exception("Unknown scroll action.");
      }else throw new Exception("This element does not support that action; refresh before retrying.");
      return D("performed",true);
    }
    throw new Exception("Unknown window operation.");
  }
`;
