import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { VISUAL_DESKTOP_NATIVE_SOURCE } from '../../src/extensions/bundled/computer-use/runtime/visual-desktop-native';

let ownedFixture: string | undefined;
afterEach(() => {
  if (
    ownedFixture &&
    resolve(ownedFixture, '..') === resolve(tmpdir()) &&
    ownedFixture.includes('wing-tray-fixture-')
  )
    rmSync(ownedFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  ownedFixture = undefined;
});
const nativeTest =
  process.platform === 'win32' && process.env['WING_NATIVE_FIXTURE'] === '1' ? it : it.skip;
nativeTest(
  'restores an existing tray window and preserves owned popup geometry and focus',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wing-tray-fixture-'));
    ownedFixture = dir;
    const source = join(dir, 'driver.cs'),
      fixture = join(dir, 'fixture.cs'),
      exe = join(dir, 'fixture.exe');
    let native = VISUAL_DESKTOP_NATIVE_SOURCE;
    const guards = [
      [
        '[DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);',
        'static bool SetCursorPos(int x,int y){throw new Exception("Unexpected global cursor call");}',
      ],
      [
        '[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);',
        'static uint SendInput(uint count,INPUT[] inputs,int size){throw new Exception("Unexpected global input call");}',
      ],
      [
        '[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);',
        'public static IntPtr FixtureForeground; public static int FixtureFocusCount; static bool SetForegroundWindow(IntPtr hwnd){FixtureFocusCount++;FixtureForeground=hwnd;return true;}',
      ],
      [
        '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
        'static IntPtr GetForegroundWindow(){return FixtureForeground;}',
      ],
      [
        '[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);',
        'public static IntPtr FixtureHit; static IntPtr WindowFromPoint(POINT point){return FixtureHit;}',
      ],
      [
        '[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);',
        'static int GetSystemMetrics(int index){return index==76||index==77?-32000:64000;}',
      ],
      [
        'CaptureVisiblePixels(bmp,x,y);',
        'using(var graphics=Graphics.FromImage(bmp)){TrayFixture.CopyOwnedFixture(graphics,x,y,w,hh);}',
      ],
      [
        '[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int action);',
        '[DllImport("user32.dll",EntryPoint="ShowWindow")] static extern bool FixtureShowWindow(IntPtr hwnd,int action); public static int FixtureRestoreCount; static bool ShowWindow(IntPtr hwnd,int action){uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid!=System.Diagnostics.Process.GetCurrentProcess().Id||(action!=9&&action!=4))throw new Exception("Non-fixture restore");FixtureRestoreCount++;return FixtureShowWindow(hwnd,4);}',
      ],
      ['if(pid==own||IsWingSurface(h))return true;', 'if(pid!=own||IsWingSurface(h))return true;'],
      [
        'System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(app){UseShellExecute=true});return D("launched",true);',
        'throw new Exception("Unexpected process launch");',
      ],
    ];
    for (const [declaration, guard] of guards) {
      expect(native).toContain(declaration);
      native = native.replace(declaration!, guard!);
    }
    native = native.replace(
      'PasteLiteralText(req,hwnd,expectedPid,text)',
      'throw new Exception("Unexpected clipboard paste")',
    );
    writeFileSync(source, native);
    writeFileSync(fixture, readFileSync(join(__dirname, '../fixtures/visual-desktop-tray.cs')));
    const framework = join(
      process.env['SystemRoot'] || 'C:\\Windows',
      'Microsoft.NET/Framework64/v4.0.30319',
    );
    execFileSync(
      join(framework, 'csc.exe'),
      [
        '/nologo',
        '/target:exe',
        '/platform:x64',
        '/main:TrayFixture',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Web.Extensions.dll',
        ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(
          (f) => '/reference:' + join(framework, 'WPF', f),
        ),
        '/out:' + exe,
        source,
        fixture,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    try {
      expect(
        execFileSync(exe, [], { windowsHide: true, timeout: 20_000, encoding: 'utf8' }),
      ).toContain('PASS: hidden main restored');
    } catch (error) {
      throw new Error(String((error as { stdout?: Buffer }).stdout || error));
    }
  },
  60_000,
);
