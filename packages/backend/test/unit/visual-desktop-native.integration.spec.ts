import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { VISUAL_DESKTOP_NATIVE_SOURCE } from '../../src/modules/automation/visual-desktop-native';
const nativeTest = process.platform === 'win32' && process.env['WING_NATIVE_FIXTURE'] === '1' ? it : it.skip;
nativeTest('uses real OS input contracts and rejects stale, virtual or stopped requests', () => {
  const dir=mkdtempSync(join(tmpdir(),'wing-physical-fixture-'));
  const source=join(dir,'driver.cs'),fixture=join(dir,'fixture.cs'),exe=join(dir,'fixture.exe');
  let native=VISUAL_DESKTOP_NATIVE_SOURCE;
  const guards=[
    ['[DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);','public static Point Pointer; static bool SetCursorPos(int x,int y){Pointer=new Point(x,y);return true;}'],
    ['[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);','public static List<INPUT> Inputs=new List<INPUT>();static uint SendInput(uint count,INPUT[] inputs,int size){Inputs.AddRange(inputs);foreach(var i in inputs)if(i.type==1&&i.u.ki.wVk==0x56&&i.u.ki.dwFlags==0){FixtureClipboard.Pasted=Convert.ToString(FixtureClipboard.GetDataObject().GetData(DataFormats.UnicodeText));if(FixtureClipboard.ConcurrentCopy){var data=new DataObject();data.SetData(DataFormats.UnicodeText,"concurrent copy");FixtureClipboard.SetDataObject(data,true,3,20);}}return count;}'],
    ['[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();','public static IntPtr FixtureForeground;static IntPtr GetForegroundWindow(){return FixtureForeground;}'],
    ['[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);','static bool SetForegroundWindow(IntPtr hwnd){throw new Exception("Unexpected real focus");}'],
    ['[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);','public static IntPtr FixtureHit;static IntPtr WindowFromPoint(POINT point){return IsWindowVisible(FixtureHit)?FixtureHit:FixtureForeground;}'],
    ['[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);','static bool GetCursorPos(out POINT point){point=new POINT{X=Pointer.X,Y=Pointer.Y};return true;}'],
    ['[DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO cursor);','static bool GetCursorInfo(ref CURSORINFO cursor){cursor.flags=0;return true;}'],
    ['[DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();','static uint GetClipboardSequenceNumber(){return FixtureClipboard.Sequence;}'],
  ];
  for(const [from,to] of guards){expect(native).toContain(from);native=native.replace(from!,to!);}
  native = native.replace(/\bClipboard\./g, "FixtureClipboard.");
  writeFileSync(source,native);writeFileSync(fixture,readFileSync(join(__dirname,'../fixtures/visual-desktop-physical.cs')));
  const framework=join(process.env['SystemRoot']||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319');
  execFileSync(join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/main:NativeFixture','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(f=>'/reference:'+join(framework,'WPF',f)),'/out:'+exe,source,fixture],{windowsHide:true,timeout:30000});
  const stage=resolve(__dirname,'../../../../.source-check/desktop-input-20261103');mkdirSync(stage,{recursive:true});
  try {expect(execFileSync(exe,[],{windowsHide:true,timeout:15000,encoding:'utf8',env:{...process.env,WING_PANEL_PREVIEW:join(stage,'native-panel.png')}})).toContain('PASS: real pointer');}
  catch(error){throw new Error(String((error as {stdout?:Buffer}).stdout||error));}
},45000);
