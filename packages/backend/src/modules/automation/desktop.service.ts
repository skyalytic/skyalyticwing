import { Injectable, Optional } from '@nestjs/common';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform, tmpdir, homedir, release, arch, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { LoggerService } from '../core/logger/logger.service.js';
import { PythonEnvService } from '../core/python/python-env.service.js';

/** 平台标识 */
const PLAT = platform();
const IS_WIN = PLAT === 'win32';
const IS_MAC = PLAT === 'darwin';

/** 临时目录 */
const TMP_DIR = join(tmpdir(), 'skyalyticwing-desktop');
try {
  mkdirSync(TMP_DIR, { recursive: true });
} catch {
  // 忽略
}

/** 命令执行结果 */
export interface CmdResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** 窗口信息 */
export interface WindowInfo {
  title: string;
  pid: number;
}

/** 窗口详情（list 返回） */
export interface WindowDetail {
  title: string;
  handle?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  appName?: string;
  position?: string;
  size?: string;
  id?: string;
  desktop?: string;
  host?: string;
}

/** 窗口列表结果 */
export interface WindowListResult {
  success: boolean;
  windows: WindowDetail[];
  count: number;
  error?: string;
}

/** 截图选项 */
export interface ScreenshotOptions {
  path?: string;
  region?: { x: number; y: number; width: number; height: number } | null;
  window?: string | null;
}

/** 截图结果 */
export interface ScreenshotResult {
  success: boolean;
  path?: string;
  width?: number | null;
  height?: number | null;
  window?: string;
  note?: string;
  error?: string;
  stdout?: string;
}

/** 鼠标位置 */
export interface MousePosition {
  x: number;
  y: number;
}

/** 颜色值 */
export interface ColorResult {
  r: number;
  g: number;
  b: number;
  a: number;
  hex: string;
}

/** 屏幕尺寸 */
export interface ScreenSize {
  width: number;
  height: number;
}

/** 活动窗口信息 */
export interface ActiveWindowInfo {
  title?: string;
  pid?: number;
  appName?: string;
  id?: string;
}

/** 进程信息 */
export interface ProcessInfo {
  pid?: number;
  Id?: number;
  ProcessName?: string;
  Path?: string;
  MainWindowTitle?: string;
  cpu?: string;
  mem?: string;
  command?: string;
}

/** 进程列表结果 */
export interface ProcessListResult {
  success: boolean;
  processes: ProcessInfo[];
  count: number;
  error?: string;
}

/** 对话框选项 */
export interface DialogOptions {
  type?: string;
  buttons?: string | string[];
  icon?: string;
  duration?: number;
  sound?: string;
  title?: string;
  filter?: string;
  multiple?: boolean;
}

/** 启动进程选项 */
export interface LaunchOptions {
  admin?: boolean;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  background?: boolean;
}

/** 桌面状态信息 */
export interface DesktopStatus {
  platform: string;
  osVersion: string;
  arch: string;
  hostname: string;
  screen: ScreenSize;
  activeWindow: ActiveWindowInfo | null;
  mousePosition: MousePosition | null;
  user: string;
  home: string;
  desktopPath: string;
  tempPath: string;
  capabilities: Record<string, boolean>;
  timestamp: string;
}

/**
 * DesktopService - 桌面自动化服务
 *
 * 全量移植自 packages/web/desktop-manager.cjs，包含：
 *   - Mouse：鼠标移动/点击/滚动/拖拽
 *   - Keyboard：按键/输入文本（支持中文剪贴板方式）
 *   - Screen：截图/屏幕尺寸/取色
 *   - Window：窗口列表/聚焦/最小化/最大化/关闭/调整/验证/等待
 *   - Clipboard：剪贴板读写
 *   - Dialog：弹窗/输入框/文件选择/通知
 *   - ProcessManager：进程列表/杀进程/启动进程
 *   - getStatus：获取桌面状态
 *
 * 所有 Windows API 调用均添加 IS_WIN 平台守卫。
 * 所有命令执行使用 execFileSync + 数组参数，避免 shell 注入。
 */
@Injectable()
export class DesktopService {
  /** PowerShell 二进制缓存 */
  private psBinCache: string | null = null;
  /** Python 二进制缓存 */
  private pyBinCache: string | null = null;

  constructor(
    private readonly logger: LoggerService,
    /** 捆绑 Python 环境解析（PythonModule 全局；测试未提供时走系统探测） */
    @Optional() private readonly pythonEnv?: PythonEnvService,
  ) {}

  // ============================================================
  // 工具函数
  // ============================================================

  /** 检测 PowerShell 可执行文件（优先 pwsh，回退 powershell.exe） */
  private detectPS(): string {
    if (this.psBinCache) return this.psBinCache;
    if (!IS_WIN) {
      this.psBinCache = process.env['SHELL'] || '/bin/sh';
      return this.psBinCache;
    }
    try {
      execFileSync('pwsh', ['-NoProfile', '-Command', 'echo 1'], {
        timeout: 1500,
        stdio: 'pipe',
        windowsHide: true,
      });
      this.psBinCache = 'pwsh';
    } catch {
      this.psBinCache = 'powershell.exe';
    }
    return this.psBinCache;
  }

  /** 检测 Python 可执行文件（捆绑解释器优先，回退系统 python/python3） */
  private detectPy(): string {
    if (this.pyBinCache) return this.pyBinCache;
    try {
      const env = this.pythonEnv?.resolve();
      if (env?.bin) {
        this.pyBinCache = env.bin;
        return this.pyBinCache;
      }
    } catch {
      /* PythonEnvService 不可用时走系统探测 */
    }
    if (IS_WIN) {
      try {
        execFileSync('python', ['--version'], { timeout: 1500, stdio: 'pipe', windowsHide: true });
        this.pyBinCache = 'python';
      } catch {
        this.pyBinCache = 'python3';
      }
    } else {
      try {
        execFileSync('python3', ['--version'], { timeout: 1500, stdio: 'pipe' });
        this.pyBinCache = 'python3';
      } catch {
        this.pyBinCache = 'python';
      }
    }
    return this.pyBinCache;
  }

  /** Windows arguments are PowerShell literal strings, not cmd.exe strings. */
  private escapeShellArg(arg: string): string {
    if (IS_WIN) {
      return "'" + arg.replace(/'/g, "''") + "'";
    }
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  /** 执行外部命令（同步，数组参数不经 shell 解释，避免命令注入），返回结果对象 */
  private runFile(
    cmd: string,
    args: string[],
    options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
  ): CmdResult {
    const opts = options || {};
    try {
      const result = execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: opts.timeout || 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        windowsHide: true,
      });
      return { success: true, stdout: (result || '').trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        stdout: (e.stdout || '').trim(),
        stderr: (e.stderr || '').trim(),
        ...(e.message ? { error: e.message } : {}),
      };
    }
  }

  /** 执行外部命令并通过 stdin 传入数据（数组参数不经 shell，用于 pbcopy/xclip 等） */
  private runFileInput(cmd: string, args: string[], input: string, timeout?: number): CmdResult {
    try {
      const result = execFileSync(cmd, args, {
        encoding: 'utf8',
        input,
        timeout: timeout || 15000,
        windowsHide: true,
      });
      return { success: true, stdout: (result || '').trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        stdout: (e.stdout || '').trim(),
        stderr: (e.stderr || '').trim(),
        ...(e.message ? { error: e.message } : {}),
      };
    }
  }

  /** UTF-8 BOM files preserve Unicode on Windows PowerShell 5 and avoid stdin's
   * interactive parsing/encoding rules. Errors must return a failing exit code. */
  private runPowerShell(script: string, timeout?: number, executable?: string): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'PowerShell only available on Windows' };
    }
    const scriptFile = join(TMP_DIR, `desktop_${randomUUID()}.ps1`);
    try {
      const normalizedScript = script.replace(/\r?\n/g, '\r\n');
      writeFileSync(scriptFile, '\uFEFF' + [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
        'try {', normalizedScript,
        '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
      ].join('\r\n'), 'utf8');
      const result = execFileSync(
        executable || this.detectPS(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: timeout || 15000,
          windowsHide: true,
        },
      );
      return { success: true, stdout: (result || '').trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        stdout: (e.stdout || '').trim(),
        stderr: (e.stderr || '').trim(),
        ...(e.message ? { error: e.message } : {}),
      };
    } finally {
      try { unlinkSync(scriptFile); } catch { /* Already removed or never created. */ }
    }
  }

  /** 解析 SkyInput.cs / SkyPost.cs 文件路径 */
  private resolveCsFile(name: string): string | null {
    // 候选路径（与 uia.service.ts resolveBridgePath 同一套布局约定）：
    //   - 开发态：__dirname 上溯 4 级到 packages/，命中 packages/web/<name>
    //   - 打包态：__dirname 上溯 5 级到 _up_/packages/，命中 _up_/packages/web/<name>
    //     （tauri.conf.json resources 将 ../packages/web/ 下的 .cs 打入 _up_/packages/web/）
    //   - cwd 相对：sidecar 打包态 cwd=_up_/packages/backend，../web/ 即目标；
    //     开发态 cwd=工程根命中 packages/web/<name>
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'web', name),
      join(__dirname, '..', '..', '..', '..', '..', 'web', name),
      join(process.cwd(), 'packages', 'web', name),
      join(process.cwd(), '..', 'web', name),
      join(process.cwd(), 'web', name),
      join(process.cwd(), name),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** 加载 SkyInput.cs + SkyPost.cs 并执行脚本（仅 Windows） */
  private skyInputRun(scriptBody: string, timeout?: number): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'SkyInput only available on Windows' };
    }
    const skyInputCs = this.resolveCsFile('SkyInput.cs');
    const skyPostCs = this.resolveCsFile('SkyPost.cs');
    if (!skyInputCs || !skyPostCs) {
      return { success: false, stdout: '', stderr: '', error: 'SkyInput.cs or SkyPost.cs not found' };
    }
    const ps =
      "Add-Type -Path '" +
      skyInputCs.replace(/'/g, "''") +
      "'\r\n" +
      "Add-Type -Path '" +
      skyPostCs.replace(/'/g, "''") +
      "'\r\n" +
      scriptBody;
    return this.runPowerShell(ps, timeout || 15000);
  }

  /** 将 C# 代码写入临时文件并通过 Add-Type 编译后执行 */
  private addTypeAndRun(csCode: string, invokeScript: string | null, timeout?: number): CmdResult {
    const csFile = join(TMP_DIR, `addtype_${randomUUID()}.cs`);
    try {
      writeFileSync(csFile, csCode, 'utf8');
      const psLines: string[] = [];
      psLines.push('Add-Type -Path ' + this.escapeShellArg(csFile) + ' -ReferencedAssemblies System.Drawing');
      if (invokeScript) psLines.push(invokeScript);
      // These legacy GDI+ helpers target .NET Framework's System.Drawing.
      // PowerShell 7 forwards those types to different assemblies; use Windows'
      // built-in Framework host rather than whichever pwsh happens to be on PATH.
      const frameworkHost = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return this.runPowerShell(psLines.join('\r\n'), timeout || 15000, existsSync(frameworkHost) ? frameworkHost : 'powershell.exe');
    } finally {
      try {
        unlinkSync(csFile);
      } catch {
        // 忽略
      }
    }
  }

  /** 执行 AppleScript（仅 macOS，数组参数不经 shell，脚本原文作为单一参数传入） */
  private runAppleScript(script: string, timeout?: number): CmdResult {
    if (!IS_MAC) {
      return { success: false, stdout: '', stderr: '', error: 'AppleScript only available on macOS' };
    }
    try {
      const result = execFileSync('osascript', ['-e', script], {
        encoding: 'utf8',
        timeout: timeout || 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, stdout: (result || '').trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        stdout: (e.stdout || '').trim(),
        stderr: (e.stderr || '').trim(),
        ...(e.message ? { error: e.message } : {}),
      };
    }
  }

  // ============================================================
  // Mouse — 鼠标操作
  // ============================================================

  /** 移动鼠标到指定坐标 */
  mouseMove(x: number, y: number, opts?: { speed?: number }): CmdResult {
    const ix = parseInt(String(x), 10);
    const iy = parseInt(String(y), 10);
    if (!isFinite(ix) || !isFinite(iy)) return { success: false, stdout: '', stderr: '', error: 'Invalid coordinates' };
    const sx = String(ix);
    const sy = String(iy);
    const speed = parseInt(String(opts?.speed), 10) || 0;

    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinMouse {',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '  [DllImport("user32.dll")] public static extern bool GetCursorPos(ref POINT p);',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
        '  public static void MoveSmooth(int tx, int ty, int steps) {',
        '    POINT cp = new POINT(); GetCursorPos(ref cp);',
        '    for (int i = 1; i <= steps; i++) {',
        '      SetCursorPos(cp.X + (tx - cp.X) * i / steps, cp.Y + (ty - cp.Y) * i / steps);',
        '      System.Threading.Thread.Sleep(10);',
        '    }',
        '  }',
        '}',
        '"@',
        '',
        'if (' + speed + ' -gt 0) {',
        '  [WinMouse]::MoveSmooth(' + sx + ', ' + sy + ', ' + speed + ')',
        '} else {',
        '  [WinMouse]::SetCursorPos(' + sx + ', ' + sy + ')',
        '}',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runFile(this.detectPy(), ['-c',
        'from Quartz.CoreGraphics import *\n' +
        'CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventMouseMoved, (' + sx + ', ' + sy + '), kCGMouseButtonLeft))',
      ]);
    } else {
      return this.runFile('xdotool', ['mousemove', '--sync', sx, sy], { timeout: 5000 });
    }
  }

  /** 点击鼠标 */
  mouseClick(button?: string, opts?: { double?: boolean; x?: number; y?: number }): CmdResult {
    const btn = button || 'left';
    const doubleClick = opts?.double || false;
    const clickX = opts?.x !== undefined ? parseInt(String(opts.x), 10) : null;
    const clickY = opts?.y !== undefined ? parseInt(String(opts.y), 10) : null;
    if (!['left', 'right', 'middle'].includes(btn) ||
        (clickX === null) !== (clickY === null) ||
        (clickX !== null && (!Number.isFinite(clickX) || !Number.isFinite(clickY)))) {
      return { success: false, stdout: '', stderr: '', error: 'Invalid mouse button or coordinates' };
    }

    if (IS_WIN) {
      // Qt 应用（微信/QQ/企业微信）会 hook 拦截 SendInput，需路由到 PostMessage
      const hasPos = clickX !== null && clickY !== null;
      const siClick = hasPos
        ? '[SkyInput]::Click($x, $y, "' + btn + '")'
        : '[SkyInput]::ClickHere("' + btn + '")';
      const psLines = [
        hasPos
          ? '$x = ' + clickX + '; $y = ' + clickY
          : '$cp = [SkyPost]::CursorPos() -split ","; $x = [int]$cp[0]; $y = [int]$cp[1]',
        '$h = [SkyPost]::WindowAt($x, $y)',
        '$cls = if ($h -ne [IntPtr]::Zero) { [SkyPost]::ClassOf($h) } else { "" }',
        'if ($cls -like "Qt*") {',
        '  [SkyPost]::PostClickTo($h, $x, $y, "' + btn + '")',
        '  Write-Output ("via=postmessage class=" + $cls)',
        '} else {',
        '  ' + siClick,
        '  Write-Output ("via=sendinput class=" + $cls)',
        '}',
      ];
      if (doubleClick) {
        psLines.push('Start-Sleep -Milliseconds 100');
        psLines.push(
          'if ($cls -like "Qt*") { [SkyPost]::PostClickTo($h, $x, $y, "' + btn + '") } else { [SkyInput]::ClickHere("' + btn + '") }',
        );
      }
      return this.skyInputRun(psLines.join('\r\n'));
    } else if (IS_MAC) {
      const kind = btn === 'left' ? 'Left' : btn === 'right' ? 'Right' : 'Other';
      const mouseButton = btn === 'middle' ? 'Center' : kind;
      return this.runFile(this.detectPy(), ['-c', [
        'from Quartz.CoreGraphics import *', 'import time',
        'pos = ' + (clickX !== null ? `(${clickX}, ${clickY})` : 'CGEventGetLocation(CGEventCreate(None))'),
        `for i in range(${doubleClick ? 2 : 1}):`,
        `  for eventType in (kCGEvent${kind}MouseDown, kCGEvent${kind}MouseUp):`,
        `    ev = CGEventCreateMouseEvent(None, eventType, pos, kCGMouseButton${mouseButton})`,
        '    CGEventSetIntegerValueField(ev, kCGMouseEventClickState, i + 1)',
        '    CGEventPost(kCGHIDEventTap, ev)', '    time.sleep(0.05)',
      ].join('\n')]);
    } else {
      const btnMap: Record<string, number> = { left: 1, right: 3, middle: 2 };
      const btnVal = btnMap[btn] || 1;
      if (clickX !== null) {
        const moved = this.mouseMove(clickX, clickY!);
        if (!moved.success) return moved;
      }
      const args = ['click', '--clearmodifiers', ...(doubleClick ? ['--repeat', '2'] : []), String(btnVal)];
      return this.runFile('xdotool', args, { timeout: 5000 });
    }
  }

  /** 滚动鼠标滚轮 */
  mouseScroll(amount: number, direction?: string): CmdResult {
    const dir = direction || 'up';
    const amt = Math.abs(parseInt(String(amount), 10)) || 1;

    if (IS_WIN) {
      const delta = (dir === 'down' ? -1 : 1) * amt * 120;
      return this.skyInputRun('[SkyInput]::Scroll(' + delta + ')');
    } else if (IS_MAC) {
      const delta = (dir === 'down' ? -1 : 1) * amt;
      return this.runFile(this.detectPy(), ['-c',
        'from Quartz.CoreGraphics import *\n' +
        `CGEventPost(kCGHIDEventTap, CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitLine, 1, ${delta}))`,
      ]);
    } else {
      return this.runFile('xdotool', ['click', '--repeat', String(amt), '--delay', '50', dir === 'down' ? '5' : '4'], { timeout: 5000 });
    }
  }

  /** 获取当前鼠标位置 */
  mouseGetPosition(): MousePosition | null {
    if (IS_WIN) {
      const r = this.runPowerShell([
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinGetMouse {',
        '  [DllImport("user32.dll")] public static extern bool GetCursorPos(ref POINT p);',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
        '}',
        '"@',
        '$p = New-Object WinGetMouse+POINT',
        '[WinGetMouse]::GetCursorPos([ref]$p)',
        'Write-Output "$($p.X),$($p.Y)"',
      ].join('\n'));
      if (r.success && r.stdout) {
        const parts = r.stdout.split(',');
        if (parts.length === 2) return { x: parseInt(parts[0]!, 10), y: parseInt(parts[1]!, 10) };
      }
      return null;
    } else if (IS_MAC) {
      const r = this.runAppleScript([
        'do shell script "' + this.detectPy() + " -c '",
        'from Quartz.CoreGraphics import CGEventGetLocation, CGEventCreate',
        'loc = CGEventGetLocation(CGEventCreate(None))',
        'print(int(loc.x), int(loc.y), sep=",")',
        "'\"",
      ].join('\n'));
      if (r.success && r.stdout) {
        const parts = r.stdout.split(',');
        if (parts.length === 2) return { x: parseInt(parts[0]!, 10), y: parseInt(parts[1]!, 10) };
      }
      return null;
    } else {
      // 原 shell 管道（cut/tr）拆解为 JS 解析：getmouselocation 输出形如 "x:123 y:456 screen:0 window:..."
      const r = this.runFile('xdotool', ['getmouselocation'], { timeout: 3000 });
      if (r.success && r.stdout) {
        const m = r.stdout.match(/x:(-?\d+)\s+y:(-?\d+)/);
        if (m) return { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10) };
      }
      return null;
    }
  }

  /** 拖拽鼠标 */
  mouseDrag(fromX: number, fromY: number, toX: number, toY: number, opts?: { duration?: number }): CmdResult {
    const fx = parseInt(String(fromX), 10);
    const fy = parseInt(String(fromY), 10);
    const tx = parseInt(String(toX), 10);
    const ty = parseInt(String(toY), 10);
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(tx) || !isFinite(ty)) {
      return { success: false, stdout: '', stderr: '', error: 'Invalid coordinates' };
    }
    const sFx = String(fx), sFy = String(fy), sTx = String(tx), sTy = String(ty);
    let duration = parseInt(String(opts?.duration), 10);
    if (!isFinite(duration) || duration <= 0) duration = 300;

    if (IS_WIN) {
      return this.skyInputRun('[SkyInput]::Drag(' + sFx + ', ' + sFy + ', ' + sTx + ', ' + sTy + ', ' + duration + ')');
    } else if (IS_MAC) {
      const appleScript = [
        'do shell script "' + this.detectPy() + " -c '",
        'from Quartz.CoreGraphics import *',
        'import time',
        'CGEventSetLocation(CGEventCreate(None), (' + sFx + ', ' + sFy + '))',
        'time.sleep(0.1)',
        'ev = CGEventCreate(None)',
        'CGEventSetType(ev, kCGEventLeftMouseDown)',
        'CGEventPost(kCGHIDEventTap, ev)',
        'steps = max(1, int(' + duration + ' / 10))',
        'for i in range(1, steps+1):',
        '  CGEventSetLocation(CGEventCreate(None), (' + sFx + '+(' + sTx + '-' + sFx + ')*i/steps, ' + sFy + '+(' + sTy + '-' + sFy + ')*i/steps))',
        '  time.sleep(0.01)',
        'CGEventSetType(ev, kCGEventLeftMouseUp)',
        'CGEventPost(kCGHIDEventTap, ev)',
        "'\"",
      ].join('\n');
      return this.runAppleScript(appleScript);
    } else {
      // 原 shell && 链拆解为顺序数组参数调用
      const delay = Math.max(duration / 30, 10);
      let r = this.runFile('xdotool', ['mousemove', sFx, sFy], { timeout: 10000 });
      if (!r.success) return r;
      r = this.runFile('sleep', ['0.1'], { timeout: 2000 });
      if (!r.success) return r;
      r = this.runFile('xdotool', ['mousedown', '1'], { timeout: 10000 });
      if (!r.success) return r;
      r = this.runFile('xdotool', ['mousemove', '--delay', String(Math.round(delay)), sTx, sTy], { timeout: 10000 });
      if (!r.success) return r;
      return this.runFile('xdotool', ['mouseup', '1'], { timeout: 10000 });
    }
  }

  // ============================================================
  // Keyboard — 键盘操作
  // ============================================================

  /** 键名映射表 */
  private readonly keyMap: Record<string, string> = {
    enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape',
    space: 'Space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
    insert: 'Insert', printscreen: 'Print', scrolllock: 'Scroll_Lock',
    pause: 'Pause', break: 'Break', menu: 'Menu',
    f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
    f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
    numlock: 'Num_Lock', capslock: 'Caps_Lock',
    ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift',
    meta: 'Meta', super: 'Super', cmd: 'Meta', win: 'Super',
  };

  /** 通过剪贴板输入文本（支持中文/Unicode） */
  private typeViaClipboard(text: string): { success: boolean; method?: string; chars?: number; stdout?: string; stderr?: string; error?: string } {
    this.logger.debug('Typing via clipboard (non-ASCII text, ' + text.length + ' chars)');
    if (IS_WIN) {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      const psBody = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64 + '"))',
        '[System.Windows.Forms.Clipboard]::SetText($text)',
        'Start-Sleep -Milliseconds 100',
        '[SkyInput]::Paste()',
        'Start-Sleep -Milliseconds 100',
      ].join('\r\n');
      const r = this.skyInputRun(psBody, Math.max(text.length * 10 + 3000, 8000));
      return { success: r.success, method: 'clipboard', chars: text.length, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
    } else if (IS_MAC) {
      // 原 `echo -n | pbcopy` 管道拆解为 stdin 输入（数组参数，无 shell 注入面）
      const cr = this.runFileInput('pbcopy', [], text, 3000);
      if (!cr.success) return { success: false, error: 'Failed to set clipboard: ' + cr.error };
      const r = this.runAppleScript('tell application "System Events"\n  keystroke "v" using command down\nend tell', 5000);
      return { success: r.success, method: 'clipboard', chars: text.length };
    } else {
      // xclip 失败时回退 xsel（原 shell || 链拆解）
      let cr = this.runFileInput('xclip', ['-selection', 'clipboard'], text, 3000);
      if (!cr.success) cr = this.runFileInput('xsel', ['--clipboard', '--input'], text, 3000);
      if (!cr.success) return { success: false, error: 'Failed to set clipboard (install xclip or xsel)' };
      const r = this.runFile('xdotool', ['key', 'ctrl+v'], { timeout: 5000 });
      return { success: r.success, method: 'clipboard', chars: text.length };
    }
  }

  /** 映射键名到 Windows 虚拟键码 */
  private toWinVKCode(key: string): number {
    const k = key.toLowerCase();
    const map: Record<string, number> = {
      enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
      backspace: 0x08, back: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
      up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
      pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
      f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
      f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
      ctrl: 0xa2, control: 0xa2, alt: 0xa4, shift: 0xa0,
      win: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b,
      capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c, pause: 0x13,
    };
    if (map[k] !== undefined) return map[k]!;
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  /** 映射键名到 macOS 键 */
  private toMacKey(key: string): string {
    if (key.length === 1) return key;
    const k = key.toLowerCase();
    const map: Record<string, string> = {
      enter: '', return: '', tab: '\t', space: ' ',
      up: '', down: '', left: '', right: '',
      f1: '', f2: '', f3: '', f4: '', f5: '', f6: '',
      f7: '', f8: '', f9: '', f10: '', f11: '', f12: '',
    };
    return map[k] !== undefined ? map[k]! : key;
  }

  /** 映射键名到 X11 键 */
  private toX11Key(key: string): string {
    if (key.length === 1) return key;
    return this.keyMap[key.toLowerCase()] || key;
  }

  /** 按键（支持组合键） */
  keyPress(key: string, modifiers?: string[]): CmdResult {
    const k = String(key || '');
    const mods = modifiers || [];

    if (IS_WIN) {
      const vkCode = this.toWinVKCode(k);
      if (vkCode === 0) return { success: false, stdout: '', stderr: '', error: 'Unknown key: ' + k };
      const useCtrl = mods.includes('ctrl') || mods.includes('control');
      const useAlt = mods.includes('alt');
      const useShift = mods.includes('shift');
      const pressLines = [
        'Start-Sleep -Milliseconds 50',
        '$fg = [SkyPost]::Foreground()',
        '$cls = if ($fg -ne [IntPtr]::Zero) { [SkyPost]::ClassOf($fg) } else { "" }',
        'if ($cls -like "Qt*") {',
        '  [SkyPost]::PostCombo($fg, ' + vkCode + ', $' + (useCtrl ? 'true' : 'false') + ', $' + (useAlt ? 'true' : 'false') + ', $' + (useShift ? 'true' : 'false') + ')',
        '  Write-Output ("via=postmessage class=" + $cls)',
        '} else {',
        '  [SkyInput]::KeyCombo(' + vkCode + ', $' + (useCtrl ? 'true' : 'false') + ', $' + (useAlt ? 'true' : 'false') + ', $' + (useShift ? 'true' : 'false') + ')',
        '  Write-Output ("via=sendinput class=" + $cls)',
        '}',
      ];
      return this.skyInputRun(pressLines.join('\r\n'), 10000);
    } else if (IS_MAC) {
      const macKey = this.toMacKey(k);
      const modParts: string[] = [];
      if (mods.includes('cmd') || mods.includes('meta')) modParts.push('command down');
      if (mods.includes('shift')) modParts.push('shift down');
      if (mods.includes('alt') || mods.includes('option')) modParts.push('option down');
      if (mods.includes('ctrl') || mods.includes('control')) modParts.push('control down');
      const modDown = modParts.length > 0 ? '{' + modParts.join(', ') + '} ' : '';
      const modUp = modParts.length > 0 ? '{' + modParts.map((m) => m.replace(' down', ' up')).join(', ') + '} ' : '';
      const appleScript = [
        'tell application "System Events"',
        '  keystroke "' + macKey + '" ' + modDown + modUp,
        'end tell',
      ].join('\n');
      return this.runAppleScript(appleScript);
    } else {
      const xKey = this.toX11Key(k);
      if (!/^[a-zA-Z0-9_+]+$/.test(xKey)) return { success: false, stdout: '', stderr: '', error: 'Invalid key: ' + k };
      const xdotoolArgs = ['key', '--clearmodifiers'];
      if (mods.length > 0) {
        const modMap: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super', super: 'super', cmd: 'super' };
        const modStrs: string[] = [];
        for (const m of mods) {
          const mm = modMap[m.toLowerCase()];
          if (mm) modStrs.push(mm);
        }
        if (modStrs.length > 0) xdotoolArgs.push(modStrs.join('+') + '+' + xKey);
        else xdotoolArgs.push(xKey);
      } else {
        xdotoolArgs.push(xKey);
      }
      try {
        const stdout = execFileSync('xdotool', xdotoolArgs, { timeout: 5000, encoding: 'utf8' });
        return { success: true, stdout, stderr: '' };
      } catch (e) {
        return { success: false, stdout: '', stderr: '', error: (e as Error).message };
      }
    }
  }

  /** 输入文本（自动选择最佳方式：SendInput/剪贴板/PostMessage） */
  keyType(text: string, opts?: { delay?: number }): { success: boolean; method?: string; chars?: number; stdout?: string; stderr?: string; error?: string } {
    const txt = String(text || '');
    const delay = opts?.delay || 10;
    if (!txt) return { success: true };

    const hasNonAscii = /[^\x00-\x7f]/.test(txt);

    if (IS_WIN) {
      const b64 = Buffer.from(txt, 'utf8').toString('base64');
      const gbkDelay = Math.max(delay, 30);
      const typeLines = [
        '$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64 + '"))',
        '$fg = [SkyPost]::Foreground()',
        '$cls = if ($fg -ne [IntPtr]::Zero) { [SkyPost]::ClassOf($fg) } else { "" }',
        'if ($cls -like "Qt*") {',
        '  [SkyPost]::PostTextGbk($fg, $t, ' + gbkDelay + ')',
        '  Write-Output ("via=postmessage class=" + $cls)',
        '} elseif (' + (hasNonAscii ? '$true' : '$false') + ') {',
        '  Add-Type -AssemblyName System.Windows.Forms',
        '  [System.Windows.Forms.Clipboard]::SetText($t)',
        '  Start-Sleep -Milliseconds 100',
        '  [SkyInput]::Paste()',
        '  Start-Sleep -Milliseconds 100',
        '  Write-Output ("via=clipboard class=" + $cls)',
        '} else {',
        '  [SkyInput]::TypeUnicode($t, ' + delay + ')',
        '  Write-Output ("via=sendinput class=" + $cls)',
        '}',
      ];
      const r = this.skyInputRun(typeLines.join('\r\n'), Math.max(txt.length * 2 * gbkDelay + 3000, 8000));
      return { success: r.success, method: hasNonAscii ? 'auto(non-ascii)' : 'auto', chars: txt.length, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
    }

    if (hasNonAscii) {
      return this.typeViaClipboard(txt);
    }

    if (IS_MAC) {
      const safeText = txt.replace(/"/g, '\\"').replace(/\\/g, '\\\\\\\\');
      const appleScript = [
        'tell application "System Events"',
        '  keystroke "' + safeText + '"',
        'end tell',
      ].join('\n');
      const r = this.runAppleScript(appleScript, Math.max(txt.length * 20 + 1000, 5000));
      return { success: r.success, chars: txt.length, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
    } else {
      // 数组参数直接传原文，无需 shell 转义（消除注入面）
      const r = this.runFile('xdotool', ['type', '--delay', String(delay), txt], {
        timeout: Math.max(txt.length * delay + 2000, 10000),
      });
      return { success: r.success, chars: txt.length, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
    }
  }

  // ============================================================
  // Background input — 后台输入（仅 Windows）
  // PostMessage 直达目标窗口消息队列：不抢焦点、不占用用户键鼠，
  // AI 可与用户同时使用电脑（Codex background computer use 同类能力）。
  // 目标窗口用标题关键字定位；参数一律 base64 传入（消除引号注入面）。
  // ============================================================

  /** UTF-8 → base64（PS 侧解码，避免标题/文本中的引号与特殊字符注入脚本） */
  private b64(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
  }

  /** 在 PS 中按标题定位窗口：返回窗口句柄表达式失败时输出 error=window_not_found */
  private bgResolveWindowPs(varTitle: string): string[] {
    return [
      '$h = [SkyPost]::FindByTitle(' + varTitle + ')',
      'if ($h -eq [IntPtr]::Zero) { Write-Output "error=window_not_found"; exit 1 }',
      '$cls = [SkyPost]::ClassOf($h)',
    ];
  }

  /**
   * 后台点击：不改变前台焦点。
   * - 给 window（标题关键字）：定位窗口后点击（坐标缺省点窗口中心）
   * - 未给 window 但给 x/y：WindowFromPoint 自动解析该坐标下的真实窗口
   *   （弹窗/下拉面板是独立顶层窗口，同样能命中）
   */
  bgClick(opts: { window?: string; x?: number; y?: number; button?: string; double?: boolean }): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'Background input only available on Windows' };
    }
    const btn = opts.button || 'left';
    const b64Title = opts.window ? this.b64(opts.window) : '';
    const hasTitle = !!opts.window;
    const hasPos = opts.x !== undefined && opts.y !== undefined;
    if (!hasTitle && !hasPos) {
      return { success: false, stdout: '', stderr: '', error: 'bgClick 需要 window（标题关键字）或 x/y 坐标' };
    }
    const psLines: string[] = [];
    if (hasTitle) {
      psLines.push('$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64Title + '"))');
      psLines.push(...this.bgResolveWindowPs('$title'));
      // 坐标：显式给定用之；否则取窗口中心
      psLines.push(
        hasPos
          ? '$cx = ' + parseInt(String(opts.x), 10) + '; $cy = ' + parseInt(String(opts.y), 10)
          : '$ctr = [SkyPost]::CenterOf($h) -split ","; if ($ctr.Count -lt 2) { Write-Output "error=window_rect_unavailable"; exit 1 }; $cx = [int]$ctr[0]; $cy = [int]$ctr[1]',
      );
    } else {
      psLines.push('$cx = ' + parseInt(String(opts.x), 10) + '; $cy = ' + parseInt(String(opts.y), 10));
      psLines.push('$h = [SkyPost]::WindowAt($cx, $cy)');
      psLines.push('if ($h -eq [IntPtr]::Zero) { Write-Output "error=no_window_at_point"; exit 1 }');
      psLines.push('$cls = [SkyPost]::ClassOf($h)');
    }
    const postCall =
      'if ($double -eq 1) { [SkyPost]::PostDoubleClickTo($h, $cx, $cy, "' + btn + '") } else { [SkyPost]::PostClickTo($h, $cx, $cy, "' + btn + '") }';
    psLines.push('$double = ' + (opts.double ? '1' : '0'));
    psLines.push(postCall);
    psLines.push('Write-Output ("via=postmessage target=0x" + $h.ToInt64().ToString("X") + " class=" + $cls)');
    const r = this.skyInputRun(psLines.join('\r\n'), 15000);
    if (r.success && r.stdout.indexOf('error=') === 0) {
      return { ...r, success: false, error: r.stdout };
    }
    return r;
  }

  /** 后台输入文本到指定窗口（标题关键字定位；非 ASCII 走 GBK WM_CHAR 组合路径） */
  bgType(window: string, text: string, opts?: { delay?: number }): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'Background input only available on Windows' };
    }
    if (!text) return { success: true, stdout: 'via=postmessage (empty text)', stderr: '' };
    const delay = Math.max(opts?.delay || 30, 30);
    const hasNonAscii = /[^\x00-\x7f]/.test(text);
    const timeout = Math.max(text.length * delay * 2 + 3000, 10000);
    const psLines = [
      '$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + this.b64(window) + '"))',
      ...this.bgResolveWindowPs('$title'),
      '$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + this.b64(text) + '"))',
      hasNonAscii
        ? '[SkyPost]::PostTextGbk($h, $t, ' + delay + ')'
        : '[SkyPost]::PostTextUnicode($h, $t, ' + Math.min(delay, 30) + ')',
      'Write-Output ("via=postmessage chars=' + text.length + ' method=' + (hasNonAscii ? 'gbk' : 'unicode') + ' target=0x" + $h.ToInt64().ToString("X") + " class=" + $cls)',
    ];
    const r = this.skyInputRun(psLines.join('\r\n'), timeout);
    if (r.success && r.stdout.indexOf('error=') === 0) {
      return { ...r, success: false, error: r.stdout };
    }
    return r;
  }

  /** 后台按键/组合键到指定窗口（标题关键字定位） */
  bgKey(window: string, key: string, modifiers?: string[]): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'Background input only available on Windows' };
    }
    const vkCode = this.toWinVKCode(String(key || ''));
    if (vkCode === 0) return { success: false, stdout: '', stderr: '', error: 'Unknown key: ' + key };
    const mods = modifiers || [];
    const useCtrl = mods.includes('ctrl') || mods.includes('control');
    const useAlt = mods.includes('alt');
    const useShift = mods.includes('shift');
    const psLines = [
      '$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + this.b64(window) + '"))',
      ...this.bgResolveWindowPs('$title'),
      '[SkyPost]::PostCombo($h, ' + vkCode + ', $' + (useCtrl ? 'true' : 'false') + ', $' + (useAlt ? 'true' : 'false') + ', $' + (useShift ? 'true' : 'false') + ')',
      'Write-Output ("via=postmessage key=' + encodeURIComponent(String(key)) + ' target=0x" + $h.ToInt64().ToString("X") + " class=" + $cls)',
    ];
    const r = this.skyInputRun(psLines.join('\r\n'), 10000);
    if (r.success && r.stdout.indexOf('error=') === 0) {
      return { ...r, success: false, error: r.stdout };
    }
    return r;
  }

  /** 后台滚动指定窗口（标题关键字定位；amount 为滚动格数，direction up/down） */
  bgScroll(window: string, amount: number, direction?: string): CmdResult {
    if (!IS_WIN) {
      return { success: false, stdout: '', stderr: '', error: 'Background input only available on Windows' };
    }
    const amt = Math.abs(parseInt(String(amount), 10)) || 1;
    const delta = (direction === 'down' ? -1 : 1) * amt * 120;
    const psLines = [
      '$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + this.b64(window) + '"))',
      ...this.bgResolveWindowPs('$title'),
      '$ctr = [SkyPost]::CenterOf($h) -split ","',
      'if ($ctr.Count -lt 2) { $cx = 0; $cy = 0 } else { $cx = [int]$ctr[0]; $cy = [int]$ctr[1] }',
      '[SkyPost]::PostWheel($h, ' + delta + ', $cx, $cy)',
      'Write-Output ("via=postmessage delta=' + delta + ' target=0x" + $h.ToInt64().ToString("X") + " class=" + $cls)',
    ];
    const r = this.skyInputRun(psLines.join('\r\n'), 10000);
    if (r.success && r.stdout.indexOf('error=') === 0) {
      return { ...r, success: false, error: r.stdout };
    }
    return r;
  }

  // ============================================================
  // Screen — 屏幕操作
  // ============================================================

  /**
   * 截图（危险：捕获屏幕内容）。
   * 支持全屏/区域/指定窗口截图，三平台实现。
   */
  async screenshot(): Promise<{ success: boolean; path?: string; error?: string }> {
    const result = this.screenCapture({});
    return { success: result.success, ...(result.path ? { path: result.path } : {}), ...(result.error ? { error: result.error } : {}) };
  }

  /** 屏幕截图（全屏/区域/窗口） */
  screenCapture(opts: ScreenshotOptions): ScreenshotResult {
    const filePath = opts.path || join(TMP_DIR, 'screenshot_' + Date.now() + '.png');
    const region = opts.region || null;
    const windowTarget = opts.window || null;
    // 强制将 region 值转换为整数，防止 shell 命令注入
    let safeRegion: { x: number; y: number; width: number; height: number } | null = null;
    if (region) {
      safeRegion = {
        x: parseInt(String(region.x), 10) || 0,
        y: parseInt(String(region.y), 10) || 0,
        width: parseInt(String(region.width), 10) || 0,
        height: parseInt(String(region.height), 10) || 0,
      };
      if (safeRegion.width <= 0 || safeRegion.height <= 0) return { success: false, error: 'Screenshot region width and height must be positive' };
    }

    try { mkdirSync(dirname(filePath), { recursive: true }); }
    catch (error) { return { success: false, error: `Cannot create screenshot directory: ${error instanceof Error ? error.message : String(error)}` }; }

    if (IS_WIN) {
      const csCode = [
        'using System;',
        'using System.Runtime.InteropServices;',
        'using System.Drawing;',
        'using System.Drawing.Imaging;',
        'using System.Text;',
        '',
        'public class ScreenCapture {',
        '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);',
        '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);',
        '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
        '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
        '  public static IntPtr FindWindowByTitle(string partialTitle) {',
        '    IntPtr found = IntPtr.Zero; int matches = 0;',
        '    EnumWindows((hWnd, lParam) => {',
        '      if (!IsWindowVisible(hWnd)) return true;',
        '      var sb = new StringBuilder(512);',
        '      GetWindowText(hWnd, sb, 512);',
        '      if (sb.ToString().IndexOf(partialTitle, StringComparison.OrdinalIgnoreCase) >= 0) { found = hWnd; matches++; }',
        '      return true;',
        '    }, IntPtr.Zero);',
        '    if (matches > 1) throw new Exception("Ambiguous window title; use computer_use with an explicit windowId");',
        '    return found;',
        '  }',
        '  public static void CaptureWindow(IntPtr hWnd, string path) {',
        '    try { SetProcessDPIAware(); } catch {}',
        '    RECT rect; GetWindowRect(hWnd, out rect);',
        '    int w = rect.Right - rect.Left; int h = rect.Bottom - rect.Top;',
        '    if (w <= 0 || h <= 0) throw new Exception("Invalid window size: " + w + "x" + h);',
        '    using (var bmp = new Bitmap(w, h)) {',
        '      using (var g = Graphics.FromImage(bmp)) {',
        '        IntPtr hdc = g.GetHdc(); bool captured;',
        '        try { captured = PrintWindow(hWnd, hdc, 0x00000002); } finally { g.ReleaseHdc(hdc); }',
        '        if (!captured) throw new Exception("Window capture unavailable; use computer_use look");',
        '      }',
        '      bmp.Save(path, ImageFormat.Png);',
        '    }',
        '  }',
        '  public static void FullScreenshot(string path) {',
        '    try { SetProcessDPIAware(); } catch {}',
        '    int x = GetSystemMetrics(76); int y = GetSystemMetrics(77);',
        '    int w = GetSystemMetrics(78); int h = GetSystemMetrics(79);',
        '    using (var bmp = new Bitmap(w, h)) {',
        '      using (var g = Graphics.FromImage(bmp)) {',
        '        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));',
        '      }',
        '      bmp.Save(path, ImageFormat.Png);',
        '    }',
        '  }',
        '  public static void RegionScreenshot(int x, int y, int w, int h, string path) {',
        '    try { SetProcessDPIAware(); } catch {}',
        '    using (var bmp = new Bitmap(w, h)) {',
        '      using (var g = Graphics.FromImage(bmp)) {',
        '        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));',
        '      }',
        '      bmp.Save(path, ImageFormat.Png);',
        '    }',
        '  }',
        '}',
      ].join('\n');
      let invokeLine = '';
      if (windowTarget) {
        invokeLine = '$hWnd = [ScreenCapture]::FindWindowByTitle(' + this.escapeShellArg(windowTarget) + ')\r\nif ($hWnd -eq [IntPtr]::Zero) { Write-Error "Window not found"; exit 1 }\r\n[ScreenCapture]::CaptureWindow($hWnd, ' + this.escapeShellArg(filePath) + ')';
      } else if (safeRegion) {
        invokeLine = '[ScreenCapture]::RegionScreenshot(' + safeRegion.x + ', ' + safeRegion.y + ', ' + safeRegion.width + ', ' + safeRegion.height + ', ' + this.escapeShellArg(filePath) + ')';
      } else {
        invokeLine = '[ScreenCapture]::FullScreenshot(' + this.escapeShellArg(filePath) + ')';
      }
      invokeLine += '\r\nWrite-Output ' + this.escapeShellArg(filePath);

      const r = this.addTypeAndRun(csCode, invokeLine, 15000);
      if (r.success && existsSync(filePath)) {
        return { success: true, path: filePath, width: safeRegion ? safeRegion.width : null, height: safeRegion ? safeRegion.height : null };
      }
      const detail = r.stderr || r.error || `Capture did not create the requested file: ${filePath}`;
      return { success: false, error: 'Screenshot failed on Windows: ' + detail.substring(0, 1000), stdout: (r.stdout || '').substring(0, 200) };
    } else if (IS_MAC) {
      if (windowTarget) {
        const activateScript = 'tell application "System Events" to set frontmost of process whose name contains "' + windowTarget.replace(/"/g, '\\"') + '" to true';
        this.runAppleScript(activateScript, 3000);
        let r = this.runFile('screencapture', ['-x', '-w', filePath], { timeout: 10000 });
        if (r.success && existsSync(filePath)) return { success: true, path: filePath, window: windowTarget };
        r = this.runFile('screencapture', ['-x', filePath], { timeout: 10000 });
        if (r.success && existsSync(filePath)) return { success: true, path: filePath, window: windowTarget, note: 'Full screen captured (window capture not available)' };
        return { success: false, error: r.error || 'Screenshot failed on macOS' };
      }
      const regionArg = safeRegion
        ? ['-R', `${safeRegion.x},${safeRegion.y},${safeRegion.x + safeRegion.width},${safeRegion.y + safeRegion.height}`]
        : [];
      const r = this.runFile('screencapture', ['-x', ...regionArg, filePath], { timeout: 10000 });
      if (r.success && existsSync(filePath)) return { success: true, path: filePath, width: safeRegion ? safeRegion.width : null, height: safeRegion ? safeRegion.height : null };
      return { success: false, error: r.error || 'Screenshot failed on macOS' };
    } else {
      // 原 shell || 回退链（import → scrot → gnome-screenshot）拆解为顺序尝试
      const attempts: Array<{ cmd: string; args: string[] }> = [];
      if (windowTarget) {
        attempts.push({ cmd: 'import', args: ['-window', windowTarget, filePath] });
        attempts.push({ cmd: 'scrot', args: ['-u', filePath] });
      } else if (safeRegion) {
        attempts.push({
          cmd: 'import',
          args: ['-window', 'root', '-crop', `${safeRegion.width}x${safeRegion.height}+${safeRegion.x}+${safeRegion.y}`, filePath],
        });
        attempts.push({
          cmd: 'scrot',
          args: ['-a', `${safeRegion.x},${safeRegion.y},${safeRegion.x + safeRegion.width},${safeRegion.y + safeRegion.height}`, filePath],
        });
        attempts.push({ cmd: 'gnome-screenshot', args: ['-a', '-f', filePath] });
      } else {
        attempts.push({ cmd: 'import', args: ['-window', 'root', filePath] });
        attempts.push({ cmd: 'scrot', args: [filePath] });
        attempts.push({ cmd: 'gnome-screenshot', args: ['-f', filePath] });
      }
      let r: CmdResult = { success: false, stdout: '', stderr: '' };
      for (const attempt of attempts) {
        r = this.runFile(attempt.cmd, attempt.args, { timeout: 10000 });
        if (r.success && existsSync(filePath)) {
          return { success: true, path: filePath, width: safeRegion ? safeRegion.width : null, height: safeRegion ? safeRegion.height : null };
        }
      }
      return { success: false, error: r.error || 'Screenshot failed on Linux. Please install: imagemagick (import), scrot, or gnome-screenshot' };
    }
  }

  /** 获取屏幕尺寸 */
  screenGetSize(): ScreenSize {
    if (IS_WIN) {
      const r = this.runPowerShell('@(Get-WmiObject Win32_VideoController).CurrentHorizontalResolution,@(Get-WmiObject Win32_VideoController).CurrentVerticalResolution');
      if (r.success && r.stdout) {
        const parts = r.stdout.split(',');
        if (parts.length >= 2) return { width: parseInt(parts[0]!, 10) || 1920, height: parseInt(parts[1]!, 10) || 1080 };
      }
      return { width: 1920, height: 1080 };
    } else if (IS_MAC) {
      const r = this.runAppleScript('tell application "System Events" to tell (first process whose frontmost is true) to return {position, size} of window 1');
      if (r.success) {
        try {
          const data = JSON.parse(r.stdout.replace(/'/g, '"'));
          return { width: data.size[0], height: data.size[1] };
        } catch {
          // 解析失败，继续回退
        }
      }
      const r2 = this.runFile('system_profiler', ['SPDisplaysDataType'], { timeout: 5000 });
      if (r2.success) {
        // 原 shell 管道 grep Resolution 拆解为 JS 匹配
        const match = r2.stdout.match(/Resolution:?\s*(\d+)\s*x\s*(\d+)/i);
        if (match) return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
      }
      return { width: 1440, height: 900 };
    } else {
      const r = this.runFile('xdpyinfo', [], { timeout: 3000 });
      if (r.success && r.stdout) {
        // 原 shell 管道（grep/awk/cut/tr）拆解为 JS 匹配 dimensions 行
        const match = r.stdout.match(/dimensions:\s+(\d+)x(\d+)/);
        if (match) return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
      }
      return { width: 1366, height: 768 };
    }
  }

  /** 获取指定坐标的像素颜色 */
  screenGetColor(x: number, y: number): ColorResult | null {
    if (IS_WIN) {
      const psScript = [
        'Add-Type -AssemblyName System.Drawing',
        '$bmp = New-Object System.Drawing.Bitmap(1, 1)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen(' + x + ', ' + y + ', 0, 0, (New-Object System.Drawing.Size(1, 1)))',
        '$pixel = $bmp.GetPixel(0, 0)',
        'Write-Output "$($pixel.R),$($pixel.G),$($pixel.B),$($pixel.A)"',
        '$g.Dispose()',
        '$bmp.Dispose()',
      ].join('\n');
      const r = this.runPowerShell(psScript);
      if (r.success && r.stdout) {
        const parts = r.stdout.split(',');
        if (parts.length === 4) {
          const rr = parseInt(parts[0]!, 10);
          const gg = parseInt(parts[1]!, 10);
          const bb = parseInt(parts[2]!, 10);
          const aa = parseInt(parts[3]!, 10);
          return { r: rr, g: gg, b: bb, a: aa, hex: '#' + rr.toString(16).padStart(2, '0') + gg.toString(16).padStart(2, '0') + bb.toString(16).padStart(2, '0') };
        }
      }
    } else if (IS_MAC) {
      const appleScript = [
        'do shell script "' + this.detectPy() + " -c '",
        'from AppKit import NSScreen, NSBitmapImageRep',
        'from Quartz.CoreGraphics import *',
        'img = CGDisplayCreateImage(CGMainDisplayID())',
        'rep = NSBitmapImageRep.alloc().initWithCGImage_(img)',
        'color = rep.colorAtX_y_(' + x + ', ' + y + ')',
        'if color:',
        '  print(color.redComponent(), color.greenComponent(), color.blueComponent(), color.alphaComponent())',
        "'\"",
      ].join('\n');
      const r = this.runAppleScript(appleScript);
      if (r.success && r.stdout) {
        const parts = r.stdout.trim().split(/\s+/);
        if (parts.length >= 3) {
          const rr = Math.round(parseFloat(parts[0]!) * 255);
          const gg = Math.round(parseFloat(parts[1]!) * 255);
          const bb = Math.round(parseFloat(parts[2]!) * 255);
          return { r: rr, g: gg, b: bb, a: 255, hex: '#' + rr.toString(16).padStart(2, '0') + gg.toString(16).padStart(2, '0') + bb.toString(16).padStart(2, '0') };
        }
      }
    } else {
      // 原 shell 管道（grep -oP 提取括号内容）拆解为 JS 匹配
      const r = this.runFile('import', ['-window', 'root', '-crop', `1x1+${x}+${y}`, 'txt:-'], { timeout: 5000 });
      if (r.success && r.stdout) {
        const paren = r.stdout.match(/\(([^)]+)\)/);
        if (paren) {
          const match = paren[1]!.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
          if (match) {
            const rr = parseInt(match[1]!, 10);
            const gg = parseInt(match[2]!, 10);
            const bb = parseInt(match[3]!, 10);
            return { r: rr, g: gg, b: bb, a: 255, hex: '#' + rr.toString(16).padStart(2, '0') + gg.toString(16).padStart(2, '0') + bb.toString(16).padStart(2, '0') };
          }
        }
      }
    }
    return null;
  }

  // ============================================================
  // Window — 窗口管理
  // ============================================================

  /** 列出可见窗口 */
  windowList(opts?: { titleFilter?: string }): WindowListResult {
    const filterTitle = opts?.titleFilter || '';

    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'using System.Text;',
        'using System.Collections.Generic;',
        'public class WinList {',
        '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
        '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
        '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
        '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
        '  public static string Enum() {',
        '    var results = new List<string>();',
        '    EnumWindows((hWnd, lParam) => {',
        '      if (!IsWindowVisible(hWnd)) return true;',
        '      var sb = new StringBuilder(512);',
        '      GetWindowText(hWnd, sb, 512);',
        '      var title = sb.ToString();',
        '      if (string.IsNullOrEmpty(title)) return true;',
        '      uint pid = 0; GetWindowThreadProcessId(hWnd, out pid);',
        '      RECT rect; GetWindowRect(hWnd, out rect);',
        '      results.Add(title + "|" + hWnd.ToString("X") + "|" + pid + "|" + rect.Left + "|" + rect.Top + "|" + (rect.Right - rect.Left) + "|" + (rect.Bottom - rect.Top));',
        '      return true;',
        '    }, IntPtr.Zero);',
        '    return string.Join(Environment.NewLine, results);',
        '  }',
        '}',
        '"@',
        '',
        '$output = [WinList]::Enum()',
      ];
      if (filterTitle) {
        psScript.push('$output | Where-Object { $_ -match "' + filterTitle.replace(/"/g, '""') + '" }');
      } else {
        psScript.push('$output');
      }
      const r = this.runPowerShell(psScript.join('\r\n'), 20000);
      if (r.success && r.stdout) {
        const lines = r.stdout.split('\n').filter((l) => l.trim());
        const windows: WindowDetail[] = [];
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 7) {
            windows.push({
              title: parts[0]!.trim(),
              handle: parts[1]!.trim(),
              pid: parseInt(parts[2]!, 10),
              x: parseInt(parts[3]!, 10),
              y: parseInt(parts[4]!, 10),
              width: parseInt(parts[5]!, 10),
              height: parseInt(parts[6]!, 10),
            });
          }
        }
        return { success: true, windows, count: windows.length };
      }
      return { success: false, windows: [], count: 0, ...(r.error ? { error: r.error } : {}) };
    } else if (IS_MAC) {
      const script = [
        'tell application "System Events"',
        '  set windowList to {}',
        '  repeat with p in processes',
        '    repeat with w in windows of p',
        '      set end of windowList to {(name of p) as text, name of w as text, position of w as text, size of w as text}',
        '    end repeat',
        '  end repeat',
        'end tell',
        'set text item delimiters to linefeed',
        'windowList as text',
      ].join('\n');
      const r = this.runAppleScript(script, 20000);
      if (r.success && r.stdout) {
        const lines = r.stdout.split('\n').filter((l) => l.trim());
        const windows: WindowDetail[] = [];
        for (const line of lines) {
          const parts = line.split(', ');
          if (parts.length >= 4) {
            const title = parts[1]!;
            if (!filterTitle || title.toLowerCase().includes(filterTitle.toLowerCase())) {
              windows.push({ appName: parts[0], title, position: parts[2], size: parts[3] });
            }
          }
        }
        return { success: true, windows, count: windows.length };
      }
      return { success: false, windows: [], count: 0, ...(r.error ? { error: r.error } : {}) };
    } else {
      // 原 shell 管道/回退链拆解：wmctrl -l 输出在 JS 内做标题过滤，失败回退 xdotool（%@ 为 xdotool 命令内占位符，非 shell 语法）
      let r = this.runFile('wmctrl', ['-l'], { timeout: 10000 });
      if (r.success && r.stdout) {
        const needle = filterTitle.toLowerCase();
        const lines = r.stdout.split('\n').filter((l) => {
          const t = l.trim();
          if (!t) return false;
          if (!needle) return true;
          const title = t.split(/\s+/).slice(3).join(' ').toLowerCase();
          return title.includes(needle);
        });
        const windows: WindowDetail[] = [];
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            windows.push({ id: parts[0], desktop: parts[1], host: parts[2], title: parts.slice(3).join(' ') });
          }
        }
        return { success: true, windows, count: windows.length };
      }
      r = this.runFile('xdotool', ['search', '--name', filterTitle || '.', 'getwindowname', '%@'], { timeout: 10000 });
      if (r.success && r.stdout) {
        const lines = r.stdout.split('\n').filter((l) => l.trim());
        const windows: WindowDetail[] = [];
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            windows.push({ id: parts[0], desktop: parts[1], host: parts[2], title: parts.slice(3).join(' ') });
          }
        }
        return { success: true, windows, count: windows.length };
      }
      return { success: false, windows: [], count: 0, error: r.error || 'wmctrl/xdotool not found. Install with: sudo apt install wmctrl xdotool' };
    }
  }

  /** 兼容控制器旧接口：列出窗口（返回简化的 WindowInfo[]） */
  listWindows(): WindowInfo[] {
    const result = this.windowList({});
    if (!result.success) return [];
    return result.windows.map((w) => ({ title: w.title || '', pid: w.pid || 0 }));
  }

  /** 获取当前活动窗口 */
  windowGetActive(): ActiveWindowInfo | null {
    if (IS_WIN) {
      const csCode = [
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinActiveWin {',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
        '  public static string GetInfo() {',
        '    var hwnd = GetForegroundWindow();',
        '    uint pid = 0; GetWindowThreadProcessId(hwnd, out pid);',
        '    return pid.ToString();',
        '  }',
        '}',
      ].join('\n');
      const invokeLine = '$activeWinPid = [WinActiveWin]::GetInfo(); $proc = Get-Process -Id $activeWinPid -ErrorAction SilentlyContinue | Select-Object -First 1; if ($proc) { Write-Output ($proc.MainWindowTitle + "|" + $activeWinPid + "|" + $proc.ProcessName) } else { Write-Output "||" }';
      const r = this.addTypeAndRun(csCode, invokeLine);
      if (r.success && r.stdout) {
        const p = r.stdout.split('|');
        if (p.length >= 3) return { title: p[0], pid: parseInt(p[1]!, 10), appName: p[2] };
      }
      return null;
    } else if (IS_MAC) {
      const r = this.runAppleScript([
        'tell application "System Events"',
        '  set frontApp to name of first application process whose frontmost is true',
        '  set frontWin to name of first window of application process frontApp',
        '  return frontApp & "|" & frontWin',
        'end tell',
      ].join('\n'));
      if (r.success && r.stdout) {
        const p = r.stdout.split('|');
        return { appName: p[0], title: p[1] };
      }
      return null;
    } else {
      const r = this.runFile('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 });
      if (r.success && r.stdout) {
        const parts = r.stdout.trim().split(/\s+/);
        return { id: parts[0], title: parts.slice(1).join(' ') };
      }
      return null;
    }
  }

  /** 聚焦窗口（兼容控制器旧接口，按标题） */
  async focusWindow(title: string): Promise<void> {
    if (!IS_WIN) {
      throw new Error('Window management is only supported on Windows');
    }
    this.windowFocus(title);
  }

  /** 聚焦窗口（按 PID 或标题） */
  windowFocus(identifier: string): CmdResult {
    if (IS_WIN) {
      const byPid = !isNaN(parseInt(identifier, 10));
      if (byPid) {
        const focusPs = [
          '$proc = Get-Process -Id ' + parseInt(identifier, 10) + ' -ErrorAction SilentlyContinue',
          'if ($proc -and $proc.MainWindowHandle -ne 0) {',
          '  [SkyPost]::ForceForeground($proc.MainWindowHandle)',
          '  Write-Output "OK:Focused PID:' + parseInt(identifier, 10) + '"',
          '} else {',
          '  Write-Output "ERROR:Process not found or no window handle"',
          '}',
        ].join('\r\n');
        return this.skyInputRun(focusPs);
      } else {
        const safeId = identifier.replace(/'/g, "''").replace(/"/g, '""');
        const focusPs2 = [
          '$h = [SkyPost]::FindByTitle("' + safeId + '")',
          'if ($h -ne [IntPtr]::Zero) {',
          '  [SkyPost]::ForceForeground($h)',
          '  Write-Output ("OK:Focused hwnd=0x" + $h.ToInt64().ToString("X"))',
          '} else {',
          '  $procs = Get-Process | Where-Object { $_.MainWindowTitle -match "' + safeId + '" -and $_.MainWindowHandle -ne 0 }',
          '  if ($procs) {',
          '    $proc = $procs | Select-Object -First 1',
          '    [SkyPost]::ForceForeground($proc.MainWindowHandle)',
          '    Write-Output ("OK:Focused " + $proc.MainWindowTitle + " PID:" + $proc.Id)',
          '  } else {',
          '    Write-Output "ERROR:No window matching \'' + safeId + '\'"',
          '  }',
          '}',
        ].join('\r\n');
        return this.skyInputRun(focusPs2);
      }
    } else if (IS_MAC) {
      const script = identifier.includes('.app')
        ? 'tell application "' + identifier.replace('.app', '') + '" to activate'
        : [
            'tell application "System Events"',
            '  tell (every process whose name contains "' + identifier + '" or (count of windows > 0 and name of frontmost window contains "' + identifier + '"))',
            '    set frontmost to true',
            '  end tell',
            'end tell',
          ].join('\n');
      return this.runAppleScript(script);
    } else {
      // 原 shell || 回退链拆解为顺序尝试，首个成功即返回
      if (!isNaN(parseInt(identifier, 10))) {
        const id = String(parseInt(identifier, 10));
        const attempts: Array<[string, string[]]> = [
          ['wmctrl', ['-i', '-a', id]],
          ['xdotool', ['windowactivate', '--sync', id]],
          ['xdotool', ['windowfocus', '--sync', id]],
        ];
        for (const [cmd, args] of attempts) {
          const r = this.runFile(cmd, args, { timeout: 8000 });
          if (r.success) return r;
        }
        return { success: false, stdout: '', stderr: '', error: 'Failed to focus window ' + id };
      }
      const attempts: Array<[string, string[]]> = [
        ['wmctrl', ['-a', identifier]],
        ['xdotool', ['search', '--name', identifier, 'windowactivate', '--sync']],
      ];
      for (const [cmd, args] of attempts) {
        const r = this.runFile(cmd, args, { timeout: 8000 });
        if (r.success) return r;
      }
      return { success: false, stdout: '', stderr: '', error: 'Failed to focus window ' + identifier };
    }
  }

  /** 关闭窗口（兼容控制器旧接口，按标题） */
  async closeWindow(title: string): Promise<void> {
    if (!IS_WIN) {
      throw new Error('Window management is only supported on Windows');
    }
    this.windowClose(title);
  }

  /** 最小化窗口 */
  windowMinimize(identifier: string): CmdResult {
    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinMinimize {',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);',
        '  public const int SW_MINIMIZE = 6;',
        '  public static void Min(string title) {',
        '    IntPtr h = FindWindow(null, title);',
        '    if (h != IntPtr.Zero) ShowWindow(h, SW_MINIMIZE);',
        '  }',
        '}',
        '"@',
        '[WinMinimize]::Min(' + this.escapeShellArg(identifier) + ')',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runAppleScript([
        'tell application "System Events"',
        '  tell (first process whose name is "' + identifier + '" or name of frontmost window contains "' + identifier + '")',
        '    set miniaturized of first window to true',
        '  end tell',
        'end tell',
      ].join('\n'));
    } else {
      return this.runFile('xdotool', ['search', '--name', identifier, 'windowminimize'], { timeout: 5000 });
    }
  }

  /** 最大化窗口 */
  windowMaximize(identifier: string): CmdResult {
    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinMaximize {',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);',
        '  public const int SW_MAXIMIZE = 3;',
        '  public static void Max(string title) {',
        '    IntPtr h = FindWindow(null, title);',
        '    if (h != IntPtr.Zero) ShowWindow(h, SW_MAXIMIZE);',
        '  }',
        '}',
        '"@',
        '[WinMaximize]::Max(' + this.escapeShellArg(identifier) + ')',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runAppleScript([
        'tell application "System Events"',
        '  tell (first process whose name is "' + identifier + '" or name of frontmost window contains "' + identifier + '")',
        '    tell first window',
        '      set zoomed to true',
        '      set position to {0, 0}',
        '      set size to {1920, 1080}',
        '    end tell',
        '  end tell',
        'end tell',
      ].join('\n'));
    } else {
      // 原 shell || 回退链拆解：wmctrl 失败时回退 xdotool
      const r = this.runFile('wmctrl', ['-r', identifier, '-b', 'add,maximized_vert,maximized_horz'], { timeout: 5000 });
      if (r.success) return r;
      return this.runFile('xdotool', ['search', '--name', identifier, 'windowsize', '100%', '100%'], { timeout: 5000 });
    }
  }

  /** 调整窗口大小 */
  windowResize(identifier: string, width: number, height: number): CmdResult {
    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinResize {',
        '  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);',
        '  public static void Resize(string title, int w, int h) {',
        '    IntPtr hwnd = FindWindow(null, title);',
        '    if (hwnd != IntPtr.Zero) MoveWindow(hwnd, 0, 0, w, h, true);',
        '  }',
        '}',
        '"@',
        '[WinResize]::Resize(' + this.escapeShellArg(identifier) + ', ' + width + ', ' + height + ')',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runAppleScript([
        'tell application "System Events"',
        '  tell (first process whose name is "' + identifier + '" or name of frontmost window contains "' + identifier + '")',
        '    set size of first window to {' + width + ', ' + height + '}',
        '  end tell',
        'end tell',
      ].join('\n'));
    } else {
      return this.runFile('xdotool', ['search', '--name', identifier, 'windowsize', String(width), String(height)], { timeout: 5000 });
    }
  }

  /** 关闭窗口 */
  windowClose(identifier: string): CmdResult {
    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinClose {',
        '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);',
        '  public const uint WM_CLOSE = 0x0010;',
        '  public static void CloseWin(string title) {',
        '    IntPtr h = FindWindow(null, title);',
        '    if (h != IntPtr.Zero) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);',
        '  }',
        '}',
        '"@',
        '[WinClose]::CloseWin(' + this.escapeShellArg(identifier) + ')',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runAppleScript('tell application "' + identifier + '" to quit');
    } else {
      // 原 shell || 回退链拆解：wmctrl 失败时回退 xdotool
      const r = this.runFile('wmctrl', ['-c', identifier], { timeout: 5000 });
      if (r.success) return r;
      return this.runFile('xdotool', ['search', '--name', identifier, 'windowclose'], { timeout: 5000 });
    }
  }

  /** 设置窗口位置 */
  windowSetPosition(identifier: string, x: number, y: number): CmdResult {
    if (IS_WIN) {
      const psScript = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class WinMove {',
        '  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);',
        '  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT r);',
        '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);',
        '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }',
        '  public static void Move(string title, int nx, int ny) {',
        '    IntPtr h = FindWindow(null, title);',
        '    if (h != IntPtr.Zero) { RECT r; GetWindowRect(h, ref r); MoveWindow(h, nx, ny, r.R-r.L, r.B-r.T, true); }',
        '  }',
        '}',
        '"@',
        '[WinMove]::Move(' + this.escapeShellArg(identifier) + ', ' + x + ', ' + y + ')',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      return this.runAppleScript([
        'tell application "System Events"',
        '  tell (first process whose name is "' + identifier + '" or name of frontmost window contains "' + identifier + '")',
        '    set position of first window to {' + x + ', ' + y + '}',
        '  end tell',
        'end tell',
      ].join('\n'));
    } else {
      return this.runFile('xdotool', ['search', '--name', identifier, 'windowmove', String(x), String(y)], { timeout: 5000 });
    }
  }

  /** 显示桌面（最小化所有窗口） */
  windowShowDesktop(): CmdResult {
    if (IS_WIN) {
      return this.runPowerShell('$shell = New-Object -ComObject Shell.Application\r\n$shell.ToggleDesktop()');
    } else if (IS_MAC) {
      return this.runAppleScript('tell application "System Events"\n  set visible of every process whose visible is true and name is not "Finder" to false\nend tell\ntell application "Finder" to activate');
    } else {
      // 原 `xdotool ... || wmctrl ... || true` 链拆解：全部失败也视为成功（与原 || true 行为一致）
      const r1 = this.runFile('xdotool', ['key', 'super+d'], { timeout: 5000 });
      if (r1.success) return r1;
      const r2 = this.runFile('wmctrl', ['-k', 'on'], { timeout: 5000 });
      if (r2.success) return r2;
      return { success: true, stdout: '', stderr: '' };
    }
  }

  /** 获取当前活动窗口标题（用于快速验证） */
  windowGetActiveTitle(): { success: boolean; title: string; appName: string; full: string; error?: string } {
    const info = this.windowGetActive();
    if (!info) return { success: false, title: '', appName: '', full: '', error: 'Failed to get active window' };
    const title = info.title || '';
    const appName = info.appName || '';
    return { success: true, title, appName, full: title + ' | ' + appName };
  }

  /** 验证当前活动窗口是否包含预期关键词（不区分大小写） */
  windowVerifyActive(expectedKeywords: string | string[]): {
    success: boolean;
    matched: boolean;
    title: string;
    appName: string;
    matchedKeyword: string;
    hint: string;
    error?: string;
  } {
    const info = this.windowGetActive();
    if (!info) {
      return { success: false, matched: false, title: '', appName: '', matchedKeyword: '', hint: '请先截图确认当前界面状态', error: '无法获取活动窗口' };
    }
    const title = (info.title || '').toLowerCase();
    const appName = (info.appName || '').toLowerCase();
    const haystack = title + ' ' + appName;
    const keywords = Array.isArray(expectedKeywords) ? expectedKeywords : [expectedKeywords];
    let matched = false;
    let matchedKeyword = '';
    for (const kw of keywords) {
      const k = String(kw || '').toLowerCase().trim();
      if (k && haystack.includes(k)) {
        matched = true;
        matchedKeyword = String(kw);
        break;
      }
    }
    return {
      success: true,
      matched,
      title: info.title || '',
      appName: info.appName || '',
      matchedKeyword,
      hint: matched
        ? '验证通过：当前活动窗口标题"' + info.title + '"包含关键词"' + matchedKeyword + '"'
        : '验证失败：当前活动窗口标题"' + info.title + '"不包含任何关键词' + JSON.stringify(keywords) + '，请截图确认或重新聚焦目标窗口',
    };
  }

  /** 等待指定标题的窗口出现（轮询检查） */
  windowWaitForTitle(titleKeyword: string, opts?: { timeout?: number; interval?: number }): {
    success: boolean;
    matched: boolean;
    title?: string;
    handle?: string;
    pid?: number;
    waitedMs?: number;
    keyword?: string;
    hint: string;
    error?: string;
  } {
    const timeout = opts?.timeout || 5000;
    const interval = opts?.interval || 300;
    const keyword = String(titleKeyword || '').toLowerCase().trim();
    if (!keyword) return { success: false, matched: false, hint: 'titleKeyword 不能为空', error: 'titleKeyword 不能为空' };
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const list = this.windowList({});
      if (list.success && list.windows) {
        for (const w of list.windows) {
          const wTitle = (w.title || '').toLowerCase();
          if (wTitle.includes(keyword)) {
            return {
              success: true,
              matched: true,
              title: w.title,
              ...(w.handle ? { handle: w.handle } : {}),
              ...(w.pid !== undefined ? { pid: w.pid } : {}),
              waitedMs: Date.now() - start,
              hint: '已找到窗口：' + w.title,
            };
          }
        }
      }
      try {
        if (IS_WIN) {
          execFileSync('timeout', ['/t', String(Math.max(1, Math.floor(interval / 1000))), '/nobreak'], { stdio: 'ignore', windowsHide: true });
        } else {
          execFileSync('sleep', [String(interval / 1000)], { stdio: 'ignore' });
        }
      } catch {
        break;
      }
    }
    return {
      success: false,
      matched: false,
      keyword: titleKeyword,
      waitedMs: timeout,
      hint: '等待超时(' + timeout + 'ms)，未找到标题包含"' + titleKeyword + '"的窗口',
    };
  }

  /** 检查窗口是否存在（单次检查） */
  windowExists(titleFilter: string): { success: boolean; exists: boolean; count: number; windows: WindowDetail[] } {
    const r = this.windowList({ titleFilter });
    return { success: r.success, exists: r.success && r.count > 0, count: r.count || 0, windows: r.windows || [] };
  }

  // ============================================================
  // Clipboard — 剪贴板
  // ============================================================

  /** 写入剪贴板 */
  clipboardWrite(text: string): CmdResult {
    const txt = String(text || '');
    if (IS_WIN) {
      const b64 = Buffer.from(txt, 'utf8').toString('base64');
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64 + '"))',
        '[System.Windows.Forms.Clipboard]::SetText($text)',
      ].join('\r\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      // 原 `echo -n | pbcopy` 管道拆解为 stdin 输入
      return this.runFileInput('pbcopy', [], txt, 3000);
    } else {
      // xclip 失败时回退 xsel（原 shell || 链拆解）
      let r = this.runFileInput('xclip', ['-selection', 'clipboard'], txt, 3000);
      if (r.success) return r;
      return this.runFileInput('xsel', ['--clipboard', '--input'], txt, 3000);
    }
  }

  /** 读取剪贴板 */
  clipboardRead(): string | null {
    if (IS_WIN) {
      const r = this.runPowerShell('Get-Clipboard -Format Text -Raw');
      return r.success ? r.stdout : null;
    } else if (IS_MAC) {
      const r = this.runFile('pbpaste', [], { timeout: 3000 });
      return r.success ? r.stdout : null;
    } else {
      // xclip 失败时回退 xsel（原 shell || 链拆解）
      let r = this.runFile('xclip', ['-selection', 'clipboard', '-o'], { timeout: 3000 });
      if (!r.success) r = this.runFile('xsel', ['--clipboard', '--output'], { timeout: 3000 });
      return r.success ? r.stdout : null;
    }
  }

  // ============================================================
  // Dialog — 对话框
  // ============================================================

  /** 显示警告对话框 */
  dialogAlert(message: string, title?: string, opts?: DialogOptions): CmdResult {
    const msg = message || 'Alert';
    const ttl = title || 'SkyAlyticClaw';

    if (IS_WIN) {
      const iconMap: Record<string, number> = { info: 64, warning: 48, error: 16, question: 32 };
      const icon = iconMap[(opts?.type || 'info').toLowerCase()] || 64;
      const btnMap: Record<string, number> = { ok: 0, okcancel: 1, yesno: 4, yesnocancel: 3 };
      const btnStr = typeof opts?.buttons === 'string' ? opts.buttons : 'ok';
      const btn = btnMap[btnStr.toLowerCase()] || 0;
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$result = [System.Windows.Forms.MessageBox]::Show(' + this.escapeShellArg(msg) + ', ' + this.escapeShellArg(ttl) + ', ' + btn + ', ' + icon + ')',
        'Write-Output $result',
      ].join('\n');
      return this.runPowerShell(psScript);
    } else if (IS_MAC) {
      let buttonsPart = '';
      if (opts?.buttons && Array.isArray(opts.buttons) && opts.buttons.length) {
        const escButtons = opts.buttons.map((b) => String(b).replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
        buttonsPart = ' buttons {"' + escButtons.join('","') + '"}';
      }
      const displayDialog = 'display dialog ' + this.escapeShellArg(msg) + ' with title ' + this.escapeShellArg(ttl) + buttonsPart;
      return this.runAppleScript(displayDialog);
    } else {
      if (process.env['DISPLAY']) {
        return this.runFile('zenity', ['--title=' + ttl, '--text=' + msg, '--info'], { timeout: 5000 });
      }
      return { success: false, stdout: '', stderr: '', error: 'No display server available for dialog' };
    }
  }

  /** 输入框对话框 */
  dialogPrompt(message: string, title?: string, defaultValue?: string): { value: string | null; cancelled: boolean; error?: string } {
    const msg = message || 'Please input:';
    const ttl = title || 'Input';
    const defVal = defaultValue || '';

    if (IS_WIN) {
      const psScript = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$input = [Microsoft.VisualBasic.Interaction]::InputBox(' + this.escapeShellArg(msg) + ', ' + this.escapeShellArg(ttl) + ', ' + this.escapeShellArg(defVal) + ')',
        'if ($input -ne "") { Write-Output $input } else { Write-Output "__CANCEL__" }',
      ].join('\n');
      const r = this.runPowerShell(psScript);
      return r.success
        ? { value: r.stdout === '__CANCEL__' ? null : r.stdout, cancelled: r.stdout === '__CANCEL__' }
        : { value: null, cancelled: true, ...(r.error ? { error: r.error } : {}) };
    } else if (IS_MAC) {
      const r = this.runAppleScript(
        [
          'display dialog ' + this.escapeShellArg(msg) + ' default answer ' + this.escapeShellArg(defVal) + ' with title ' + this.escapeShellArg(ttl),
          'return text returned of result as text & "|" & (button returned of result is "Cancel" as text)',
        ].join('\n'),
      );
      if (r.success) {
        const parts = r.stdout.split('|');
        return { value: parts[0] || null, cancelled: parts[1] === 'true' };
      }
      return { value: null, cancelled: true, ...(r.error ? { error: r.error } : {}) };
    } else {
      const r = this.runFile(
        'zenity',
        ['--entry', '--title=' + ttl, '--text=' + msg, '--entry-text=' + defVal],
        { timeout: 10000 },
      );
      return r.success ? { value: r.stdout, cancelled: false } : { value: null, cancelled: true, ...(r.error ? { error: r.error } : {}) };
    }
  }

  /** 文件选择对话框 */
  dialogFileSelect(opts?: DialogOptions): { files: string[]; cancelled: boolean; error?: string } {
    const title = opts?.title || 'Select File';
    const filter = opts?.filter || 'All Files|*.*';
    const multi = opts?.multiple || false;

    if (IS_WIN) {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
        '$dlg.Title = ' + this.escapeShellArg(title),
        '$dlg.Filter = ' + this.escapeShellArg(filter),
        '$dlg.Multiselect = $' + (multi ? 'true' : 'false'),
        'if ($dlg.ShowDialog() -eq "OK") {',
        '  Write-Output ($dlg.FileNames -join "|")',
        '} else {',
        '  Write-Output "__CANCEL__"',
        '}',
      ].join('\n');
      const r = this.runPowerShell(psScript, 30000);
      if (r.success) {
        if (r.stdout === '__CANCEL__') return { files: [], cancelled: true };
        return { files: r.stdout.split('|'), cancelled: false };
      }
      return { files: [], cancelled: true, ...(r.error ? { error: r.error } : {}) };
    } else if (IS_MAC) {
      const r = this.runAppleScript(
        [
          'set theFiles to choose file with prompt ' + this.escapeShellArg(title) + (multi ? ' of type {"*"} multiple selections allowed' : ''),
          'set fileList to {}',
          'repeat with f in theFiles',
          '  set end of fileList to POSIX path of f',
          'end repeat',
          "set AppleScript's text item delimiters to \"|\"",
          'return fileList as text',
        ].join('\n'),
        30000,
      );
      if (r.success) return { files: r.stdout.split('|'), cancelled: false };
      return { files: [], cancelled: true, ...(r.error ? { error: r.error } : {}) };
    } else {
      const r = this.runFile(
        'zenity',
        ['--file-selection', '--title=' + title, ...(multi ? ['--multiple', '--separator=|'] : [])],
        { timeout: 30000 },
      );
      if (r.success) return { files: r.stdout.split('|'), cancelled: false };
      return { files: [], cancelled: true, ...(r.error ? { error: r.error } : {}) };
    }
  }

  /** 显示系统通知 */
  dialogNotification(message: string, title?: string, opts?: DialogOptions): CmdResult {
    const msg = message || '';
    const ttl = title || 'SkyAlyticClaw';

    if (IS_WIN) {
      const validIcons = ['Info', 'Warning', 'Error', 'Question'];
      const icon = opts?.icon && validIcons.includes(opts.icon) ? opts.icon : 'Info';
      let duration = parseInt(String(opts?.duration), 10);
      if (!isFinite(duration) || duration <= 0) duration = 5000;
      const durStr = String(duration);
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$balloon = New-Object System.Windows.Forms.NotifyIcon',
        '$balloon.Icon = [System.Drawing.SystemIcons]::' + icon,
        '$balloon.BalloonTipTitle = ' + this.escapeShellArg(ttl),
        '$balloon.BalloonTipText = ' + this.escapeShellArg(msg),
        '$balloon.Visible = $true',
        '$balloon.ShowBalloonTip(' + durStr + ')',
        'Start-Sleep -Milliseconds 2000',
        '$balloon.Dispose()',
      ].join('\n');
      return this.runPowerShell(psScript, 8000);
    } else if (IS_MAC) {
      let sound = opts?.sound || 'default';
      if (!/^[A-Za-z0-9_-]+$/.test(sound)) sound = 'default';
      return this.runAppleScript(
        'display notification ' + this.escapeShellArg(msg) + ' with title ' + this.escapeShellArg(ttl) + ' sound name ' + sound,
        5000,
      );
    } else {
      if (process.env['DISPLAY']) {
        const icon = opts?.icon || 'dialog-information';
        return this.runFile('notify-send', ['-i', icon, ttl, msg], { timeout: 5000 });
      }
      return { success: false, stdout: '', stderr: '', error: 'No display server for notifications' };
    }
  }

  // ============================================================
  // ProcessManager — 进程管理
  // ============================================================

  /** 列出进程 */
  processList(nameFilter?: string): ProcessListResult {
    if (IS_WIN) {
      // nameFilter 严格白名单校验，防止 PowerShell 注入
      let filter = '';
      if (nameFilter && /^[A-Za-z0-9_.-]+$/.test(nameFilter)) {
        filter = ' | Where-Object {$_.ProcessName -like "*' + nameFilter + '*"}';
      }
      const r = this.runPowerShell(
        'Get-Process' + filter + ' | Select-Object Id, ProcessName, Path, MainWindowTitle | ConvertTo-Json -Compress',
        15000,
      );
      if (r.success && r.stdout) {
        try {
          const procs = JSON.parse(r.stdout);
          return { success: true, processes: Array.isArray(procs) ? procs : [procs], count: Array.isArray(procs) ? procs.length : 1 };
        } catch {
          // JSON 解析失败
        }
      }
      return { success: false, processes: [], count: 0, ...(r.error ? { error: r.error } : {}) };
    } else {
      // 原 shell 管道（grep -i / grep -v grep）拆解为 JS 过滤
      const r = this.runFile('ps', ['aux'], { timeout: 10000 });
      if (r.success && r.stdout) {
        const needle = (nameFilter || '').toLowerCase();
        const lines = r.stdout
          .split('\n')
          .slice(1)
          .filter((l) => {
            const t = l.trim();
            if (!t) return false;
            if (!needle) return true;
            return t.toLowerCase().includes(needle) && !/\bgrep\b/.test(t);
          });
        const procs: ProcessInfo[] = lines.map((line) => {
          const parts = line.trim().split(/\s+/);
          return { pid: parseInt(parts[1]!, 10), cpu: parts[2], mem: parts[3], command: parts.slice(10).join(' ') };
        });
        return { success: true, processes: procs, count: procs.length };
      }
      return { success: false, processes: [], count: 0, ...(r.error ? { error: r.error } : {}) };
    }
  }

  /** 终止进程（按 PID 或名称） */
  processKill(pidOrName: string | number, force?: boolean): CmdResult {
    const parsedPid = parseInt(String(pidOrName), 10);
    // 拒绝 PID 0 和负数（Unix 下 0=进程组, -1=所有进程）
    if (!isNaN(parsedPid) && parsedPid > 0) {
      const pidStr = String(parsedPid);
      if (IS_WIN) {
        return this.runPowerShell('Stop-Process -Id ' + pidStr + (force ? ' -Force' : '') + ' -ErrorAction SilentlyContinue');
      }
      return this.runFile('kill', [force ? '-9' : '-15', pidStr], { timeout: 5000 });
    } else {
      if (IS_WIN) {
        const safeName = String(pidOrName).replace(/'/g, "''");
        return this.runPowerShell(
          "Get-Process -Name '*" + safeName + "*' | Stop-Process" + (force ? ' -Force' : '') + ' -ErrorAction SilentlyContinue',
        );
      }
      return this.runFile('pkill', [...(force ? ['-9'] : []), '-f', String(pidOrName)], { timeout: 5000 });
    }
  }

  /** 启动进程 */
  processLaunch(command: string, opts?: LaunchOptions): CmdResult & { pid?: number } {
    if (IS_WIN) {
      const verb = opts?.admin ? 'RunAs' : 'Open';
      let argsPart = '';
      if (opts?.args && opts.args.length) {
        const escArgs = opts.args.map((a) => "'" + String(a).replace(/'/g, "''") + "'");
        argsPart = ' -ArgumentList ' + escArgs.join(',');
      }
      const workDir = opts?.cwd ? ' -WorkingDirectory ' + this.escapeShellArg(opts.cwd) : '';
      return this.runPowerShell(
        'Start-Process -FilePath ' + this.escapeShellArg(command) + argsPart + (workDir ? ' ' + workDir : '') + ' -Verb ' + verb,
      );
    } else if (IS_MAC) {
      // open -a 启动应用后即返回，原 shell `&` 后台化无实际必要；数组参数消除注入面
      const args = [
        '-a',
        command,
        ...((opts?.args && opts.args.length ? ['--args', ...opts.args.map(String)] : [])),
      ];
      return this.runFile('open', args, { timeout: 10000 });
    } else {
      try {
        const spawnOpts: { detached: boolean; stdio: 'ignore'; cwd?: string; env?: NodeJS.ProcessEnv } = {
          detached: !!opts?.background,
          stdio: 'ignore',
        };
        if (opts?.cwd) spawnOpts.cwd = opts.cwd;
        if (opts?.env) spawnOpts.env = Object.assign({}, process.env, opts.env);
        const child = spawn(command, opts?.args || [], spawnOpts);
        child.unref();
        return { success: true, stdout: '', stderr: '', ...(child.pid !== undefined ? { pid: child.pid } : {}) };
      } catch (err) {
        return { success: false, stdout: '', stderr: '', error: (err as Error).message };
      }
    }
  }

  // ============================================================
  // getStatus — 桌面状态信息
  // ============================================================

  /** 获取桌面状态（平台/屏幕/活动窗口/鼠标位置等） */
  getStatus(): DesktopStatus {
    const screenSize = this.screenGetSize();
    const activeWindow = this.windowGetActive();
    const mousePos = this.mouseGetPosition();
    const homeDir = process.env['USERPROFILE'] || process.env['HOME'] || '';
    let desktopPath = '';
    try {
      desktopPath = join(homedir(), 'Desktop');
    } catch {
      // 忽略
    }
    if (IS_WIN) {
      try {
        const dp = execFileSync(
          this.detectPS(),
          ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
          {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          },
        );
        if (dp) desktopPath = dp.trim();
      } catch {
        // 忽略
      }
    }

    return {
      platform: PLAT,
      osVersion: release(),
      arch: arch(),
      hostname: hostname(),
      screen: screenSize,
      activeWindow,
      mousePosition: mousePos,
      user: process.env['USERNAME'] || '',
      home: homeDir,
      desktopPath,
      tempPath: process.env['TEMP'] || process.env['TMP'] || '/tmp',
      capabilities: {
        mouse: true,
        keyboard: true,
        screen: true,
        window: true,
        clipboard: true,
        dialog: true,
        process: true,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
