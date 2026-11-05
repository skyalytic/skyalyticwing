// Windows-only integration fixture: real input is directed only at this test's own form.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
if(process.platform!=='win32'){console.log('SKIP: Windows native fixture');process.exit(0)}
const {VISUAL_DESKTOP_NATIVE_SOURCE}=require('../packages/backend/dist/modules/automation/visual-desktop-native.js');
const fixture=String.raw`
    if(cmd=="input_fixture") {
      Form fixture=null;Form popup=null;Form foreign=null;Button button=null;TextBox textbox=null;int clicked=0,down=0,up=0;Point bp=new Point(),tp=new Point();IntPtr h=IntPtr.Zero;
      OnUi(delegate {fixture=new Form{Text="Wing input regression fixture",Size=new Size(420,250),StartPosition=FormStartPosition.CenterScreen,TopMost=true};button=new Button{Text="Input check",Location=new Point(30,40),Size=new Size(180,50)};textbox=new TextBox{Location=new Point(30,120),Size=new Size(300,30)};button.Click+=delegate{clicked++;};button.MouseDown+=delegate{down++;};button.MouseUp+=delegate{up++;};fixture.Controls.Add(button);fixture.Controls.Add(textbox);if(Screen.AllScreens.Length>1){fixture.StartPosition=FormStartPosition.Manual;var area=Screen.AllScreens[1].WorkingArea;fixture.Location=new Point(area.Left+200,area.Top+200);}fixture.Show();h=fixture.Handle;ShowWindow(h,1);SetForegroundWindow(h);fixture.Activate();bp=button.PointToScreen(new Point(50,25));tp=textbox.PointToScreen(new Point(30,10));});
      Thread.Sleep(300);
      try {
        Run(D("command","overlay_start","inputMode","physical","shellManaged",false));
        Emit(D("phase","fixture-before-input","hwnd",h.ToInt64(),"exists",IsWindow(h),"visible",IsWindowVisible(h),"foreground",GetForegroundWindow().ToInt64()));int display=Array.FindIndex(Displays(),screen=>screen.DeviceName==Screen.FromHandle(h).DeviceName);var root=D("rootRef","desktop:"+display,"windowId",-display,"pid",0,"bounds",Bounds(DesktopRect(new IntPtr(-display))),"foregroundWindowId",GetForegroundWindow().ToInt64());
        PointInside(h,bp.X,bp.Y,true);Run(D("command","input","inputMode","physical","root",root,"action",D("kind","click","x",bp.X,"y",bp.Y)));Thread.Sleep(150);
        PointInside(h,tp.X,tp.Y,true);Run(D("command","input","inputMode","physical","root",root,"action",D("kind","click","x",tp.X,"y",tp.Y)));Thread.Sleep(100);
        if(GetAncestor(GetForegroundWindow(),GA_ROOT)!=h)throw new Exception("Fixture did not gain keyboard focus; no text sent.");root["foregroundWindowId"]=GetForegroundWindow().ToInt64();Run(D("command","input","inputMode","physical","root",root,"action",D("kind","typeText","params",D("text","Wing 中文 123"))));Thread.Sleep(150);
        string actual="";int popupClicked=0;bool blockedForeign=false;Point pp=new Point();
        OnUi(delegate{actual=textbox.Text;popup=new Form{Text="Owned search results fixture",FormBorderStyle=FormBorderStyle.None,StartPosition=FormStartPosition.Manual,Location=new Point(fixture.Left+150,fixture.Top+50),Size=new Size(200,80),TopMost=true};var pick=new Button{Text="Select result",Location=new Point(10,10),Size=new Size(150,40)};pick.Click+=delegate{popupClicked++;};popup.Controls.Add(pick);popup.Show(fixture);ShowWindow(popup.Handle,1);pp=pick.PointToScreen(new Point(30,20));});
        Thread.Sleep(150);uint fixturePid;GetWindowThreadProcessId(h,out fixturePid);var mainRoot=D("rootRef","visual:"+h.ToInt64()+":"+fixturePid,"windowId",h.ToInt64(),"pid",fixturePid,"bounds",Bounds(RectFor(h)),"foregroundWindowId",GetForegroundWindow().ToInt64());
        Run(D("command","input","inputMode","physical","root",mainRoot,"action",D("kind","click","x",pp.X,"y",pp.Y)));Thread.Sleep(100);
        OnUi(delegate{popup.Close();foreign=new Form{Text="Unrelated overlap fixture",StartPosition=FormStartPosition.Manual,Location=new Point(fixture.Left+20,fixture.Top+20),Size=new Size(260,150),TopMost=true};foreign.Show();ShowWindow(foreign.Handle,1);});Thread.Sleep(150);
        try{Run(D("command","input","inputMode","physical","root",mainRoot,"action",D("kind","click","x",bp.X,"y",bp.Y)));}catch{blockedForeign=true;}

        string ownProcessName=ProcessName(fixturePid);
        return D("clicked",clicked,"down",down,"up",up,"text",actual,"inputSize",Marshal.SizeOf(typeof(INPUT)),"ownedPopupClicks",popupClicked,"unrelatedWindowBlocked",blockedForeign,"processName",ownProcessName,"passed",clicked==1&&actual=="Wing 中文 123"&&popupClicked==1&&blockedForeign&&ownProcessName=="fixture");
      }finally{OnUi(delegate{if(foreign!=null)foreign.Close();if(popup!=null)popup.Close();fixture.Close();});Run(D("command","overlay_stop"));}
    }
`;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wing-native-input-fixture-'));
const source=path.join(directory,'fixture.cs'),exe=path.join(directory,'fixture.exe');
fs.writeFileSync(source,VISUAL_DESKTOP_NATIVE_SOURCE.replace('    if(cmd=="ping")',fixture+'    if(cmd=="ping")'));
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
cp.execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll','/out:'+exe,source],{windowsHide:true});
const child=cp.spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';
const timer=setTimeout(()=>{child.kill();console.error('Native fixture timed out');process.exitCode=1},20000);
child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{output+=s;let i;while((i=output.indexOf('\n'))>=0){const line=output.slice(0,i);output=output.slice(i+1);const r=JSON.parse(line);if(r.phase)console.log(JSON.stringify(r));if(r.id==='fixture'){console.log(JSON.stringify(r));if(!r.ok||!r.result.passed)process.exitCode=1;child.stdin.end();}}});
child.on('close',()=>{clearTimeout(timer);(()=>{const base=fs.realpathSync(os.tmpdir()),target=fs.realpathSync(directory),rel=path.relative(base,target);if(path.isAbsolute(rel)||rel.startsWith('..')||!path.basename(target).startsWith('wing-native-input-fixture-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(target,{recursive:true,force:true})})()});
child.stdin.write(JSON.stringify({id:'fixture',command:'input_fixture',inputMode:'physical'})+'\n');
