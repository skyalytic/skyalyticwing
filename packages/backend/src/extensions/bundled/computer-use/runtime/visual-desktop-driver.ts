import { TextEntryGuard } from './text-entry-guard.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VISUAL_DESKTOP_NATIVE_SOURCE } from './visual-desktop-native.js';
import { UNIX_DESKTOP_SOURCE } from './visual-desktop-unix-source.js';
import { existsSync } from 'node:fs';
import { SOURCE_EDITION } from '../../../../modules/core/utils/desktop-edition.js';

export interface VisualDesktopBounds { x: number; y: number; width: number; height: number }
export interface VisualDesktopRoot { rootRef: string; windowId: number; pid: number; title: string; processName?: string; processPath?: string; visible?: boolean; restorable?: boolean; bounds: VisualDesktopBounds; minimized?: boolean; isForeground?: boolean; foregroundWindowId?: number }
export interface VisualDesktopCapture { base64: string; mimeType: 'image/png'; width: number; height: number; originX: number; originY: number; bounds: VisualDesktopBounds; coordinateSpace: 'physical-screen-pixels' | 'window-coordinates'; foregroundWindowId?: number; regions?: Record<string, VisualDesktopBounds>; cursor: { x: number; y: number; visible: boolean } }
export interface VisualDesktopInput { kind: 'click' | 'moveMouse' | 'drag' | 'scroll' | 'typeText' | 'keypress'; x?: number; y?: number; params?: Record<string, unknown> }
export type DesktopInputMode = 'physical';
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Convert screenshot pixels, including a cropped negative-origin monitor, without model-side arithmetic. */
export function visualPointToScreen(point: { x: number; y: number }, image: { width: number; height: number; originalWidth: number; originalHeight: number; originX: number; originY: number }): { x: number; y: number } {
  if (![point.x, point.y, image.width, image.height, image.originalWidth, image.originalHeight, image.originX, image.originY].every(Number.isFinite) || image.width <= 0 || image.height <= 0 || image.originalWidth <= 0 || image.originalHeight <= 0 || point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) throw new Error('Point must be inside the observed screenshot.');
  return { x: image.originX + Math.min(image.originalWidth - 1, Math.floor(point.x * image.originalWidth / image.width)), y: image.originY + Math.min(image.originalHeight - 1, Math.floor(point.y * image.originalHeight / image.height)) };
}

/** Real OS pointer/keyboard transport; the desktop package owns the native helpers. */
export class VisualDesktopDriver {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();
  private readonly inputMode: DesktopInputMode = 'physical';
  private platform = process.platform;
  private unixChildren = new Set<ChildProcessWithoutNullStreams>();
  private keyboardPoints = new Map<number, { x: number; y: number }>();
  private epoch = 0;
  private readonly textEntry = new TextEntryGuard();
  private captureAfter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  available(): boolean { return ['win32', 'darwin', 'linux'].includes(this.platform); }
  isAvailable(): boolean { return this.available(); }
  async readOnlySelfTest(): Promise<{ protocolVersion: number; platform: string }> {
    if (this.child || this.starting) throw new Error('Run the read-only self-test on a separate driver instance.');
    try {
      const result = await this.command<{ protocolVersion: number; platform: string }>('ping');
      if (result.protocolVersion !== 1 || result.platform !== this.platform) throw new Error('Unexpected native visual helper protocol.');
      return result;
    } finally { this.dispose(); }
  }
  onStop(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  setInputMode(mode: DesktopInputMode): void { if (mode !== 'physical') throw new Error('Only physical desktop input is supported.'); }
  getInputMode(): DesktopInputMode { return this.inputMode; }
  async listApps(): Promise<Array<{ id: string; displayName?: string; isRunning?: boolean; runningAppIds?: string[] }>> { return this.command('list_apps'); }
  async launchApp(app: string): Promise<unknown> { return this.command('launch_app', { app }); }
  async windowInfo(root: VisualDesktopRoot): Promise<{ bounds: VisualDesktopBounds; foregroundWindowId: number; foregroundBelongsToTarget?: boolean }> { return this.command('window_info', { root }); }
  async accessibility(root: VisualDesktopRoot): Promise<Record<string, any>> { return this.command('accessibility', { root }); }
  async accessibilityInput(root: VisualDesktopRoot, args: Record<string, unknown>): Promise<Record<string, any>> { return this.command('accessibility_input', { root, ...args }); }
  async captureWindow(root: VisualDesktopRoot): Promise<VisualDesktopCapture> { return this.capture(root); }
  /** Validate only the selected native handle/PID; do not enumerate unrelated windows per action. */
  async inspectWindow(root: VisualDesktopRoot): Promise<VisualDesktopRoot> { return this.command('inspect_window', { root }); }
  async listWindows(): Promise<VisualDesktopRoot[]> { return this.command('list'); }
  async focus(root: VisualDesktopRoot): Promise<{ focused: boolean; bounds: VisualDesktopBounds }> { return this.command('focus', { root }); }
  async capture(root: VisualDesktopRoot): Promise<VisualDesktopCapture> {
    const epoch = this.epoch;
    // Give the receiving app time to render queued input, including its search popup.
    while (Date.now() < this.captureAfter) {
      if (epoch !== this.epoch) throw new Error('Desktop capture cancelled.');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, this.captureAfter - Date.now())));
    }
    if (epoch !== this.epoch) throw new Error('Desktop capture cancelled.');
    return this.command('capture', { root });
  }
  async input(root: VisualDesktopRoot, action: VisualDesktopInput, options: { signal?: AbortSignal } = {}): Promise<{ performed: boolean; kind: string; verification: string }> {
    if (!['click', 'moveMouse', 'drag', 'scroll', 'typeText', 'keypress'].includes(action.kind)) throw new Error('Unsupported visual input kind.');
    if (['click', 'moveMouse', 'drag', 'scroll'].includes(action.kind) && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) throw new Error('Pointer input requires finite physical screen coordinates.');
    if (options.signal?.aborted) throw new Error('Desktop input cancelled.');
    this.textEntry.before(root, action);
    const abort = () => this.dispose(); options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.command<{ performed: boolean; kind: string; verification: string }>('input', { root, action }, 60_000);
      if (result.performed !== false) this.textEntry.delivered(root, action);
      this.captureAfter = Date.now() + (['typeText', 'keypress'].includes(action.kind) ? 180 : 80);
      return result;
    }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  async startOverlay(options: { title?: string } = {}): Promise<unknown> { return this.command('overlay_start', { ...options, shellManaged: false }); }
  async updateOverlay(options: { title?: string } = {}): Promise<unknown> { return this.command('overlay_update', options); }
  async stopOverlay(): Promise<unknown> {
    if (!this.child && !this.starting) return { visible: false };
    const child = this.child;
    return this.command('overlay_stop', {}, 20_000, { noStart: true, ...(child ? { expectedChild: child } : {}) });
  }
  dispose(): void {
    for (const child of this.unixChildren) child.kill();
    this.unixChildren.clear(); this.keyboardPoints.clear(); this.textEntry.clear(); this.captureAfter = 0;
    this.epoch++; const child = this.child; this.child = undefined;
    if (child) this.retire(child);
    this.failPending(new Error('Visual desktop driver stopped. Observe again before continuing.'));
  }
  private retire(child: ChildProcessWithoutNullStreams): void {
    // Native cancellation runs on its reader thread so held keys/buttons are released in finally.
    try { child.stdin.end(JSON.stringify({ id: randomUUID(), command: 'cancel' }) + '\n', () => {}); }
    catch { /* The pipe may already have closed; the bounded shutdown below still retires it. */ }
    const kill = setTimeout(() => child.kill(), 2_000); kill.unref(); child.once('exit', () => clearTimeout(kill));
  }
  private failPending(error: Error): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  private async compile(): Promise<string> {
    const fingerprint = createHash('sha256').update(VISUAL_DESKTOP_NATIVE_SOURCE).digest('hex').slice(0, 24);
    const dir = join(tmpdir(), 'skyalyticwing-' + SOURCE_EDITION + '-visual-desktop', fingerprint);
    const exe = join(dir, 'WingVisualDesktop.exe');
    try { await access(exe); return exe; } catch { /* compile this source version once */ }
    await mkdir(dir, { recursive: true });
    const source = join(dir, 'WingVisualDesktop.cs');
    await writeFile(source, VISUAL_DESKTOP_NATIVE_SOURCE, 'utf8');
    const output = join(dir, `WingVisualDesktop-${randomUUID()}.exe`);
    const compiler = join(process.env['SystemRoot'] || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    try {
      await new Promise<void>((resolve, reject) => {
        const wpf = join(process.env['SystemRoot'] || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF');
        const child = spawn(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => '/reference:' + join(wpf, file)), '/out:' + output, source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let diagnostic = ''; child.stdout.on('data', value => { diagnostic += value.toString(); }); child.stderr.on('data', value => { diagnostic += value.toString(); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Native visual helper compilation timed out.')); }, 60_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Native visual helper compilation failed: ' + diagnostic.slice(-6000))); });
      });
      try { await rename(output, exe); } catch (error) { try { await access(exe); } catch { throw error; } }
      return exe;
    } finally { await rm(output, { force: true }).catch(() => {}); }
  }
  private async ensureStarted(): Promise<void> {
    if (!this.available()) throw new Error('Wing visual desktop control does not support this platform.');
    if (this.child) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    this.starting = (async () => {
      const executable = await this.compile();
      if (epoch !== this.epoch) throw new Error('Visual desktop startup cancelled.');
      const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let buffer = '';
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 80_000_000) { this.dispose(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
          let value: { id?: string; event?: string; approvalId?: string; approved?: boolean; ok?: boolean; result?: unknown; error?: string };
          try { value = JSON.parse(line); } catch { this.dispose(); return; }
          if (value.event === 'stop') { for (const listener of this.listeners) { try { listener(); } catch { /* local stop listeners are isolated */ } } continue; }
          const pending = value.id ? this.pending.get(value.id) : undefined; if (!pending) continue;
          this.pending.delete(value.id!); clearTimeout(pending.timer);
          value.ok ? pending.resolve(value.result) : pending.reject(new Error(value.error || 'Native visual operation failed.'));
        }
      });
      child.stderr.on('data', () => { /* never copy native diagnostics into model output */ });
      const ended = (error: Error, retire = true) => { if (this.child !== child) return; this.child = undefined; this.epoch++; this.failPending(error); if (retire) this.retire(child); };
      child.stdin.on('error', error => ended(error));
      child.once('error', error => ended(error)); child.once('exit', () => ended(new Error('Native visual helper exited. Input outcome may be uncertain; observe before retrying.'), false));
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private command<T = unknown>(command: string, data: Record<string, unknown> = {}, timeoutMs = 20_000, options: { noStart?: boolean; expectedChild?: ChildProcessWithoutNullStreams } = {}): Promise<T> {
    if (this.platform !== 'win32') return this.unixCommand<T>(command, data, timeoutMs);
    const epoch = this.epoch;
    const result = this.queue.catch(() => {}).then(async () => {
      // Closing a control overlay must never create or affect a replacement helper.
      if (options.noStart && (epoch !== this.epoch || !this.child || (options.expectedChild && options.expectedChild !== this.child))) return { visible: false } as T;
      if (epoch !== this.epoch) throw new Error('Queued desktop operation cancelled.');
      if (!options.noStart) await this.ensureStarted();
      if (epoch !== this.epoch || !this.child) throw new Error('Visual desktop operation cancelled.');
      const child = this.child; const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Visual desktop operation timed out; input outcome may be uncertain. Observe before retrying.')); this.dispose(); }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, command, inputMode: this.inputMode, ...data }) + '\n', error => { if (!error) return; const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(error); } });
      });
    });
    this.queue = result.catch(() => {}); return result;
  }
  private unixCommand<T>(command: string, data: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.available()) return Promise.reject(new Error('Unsupported desktop platform.'));
    if (command.startsWith('overlay_')) return Promise.resolve({ visible: false, managedBy: 'tauri' } as T);
    const epoch = this.epoch;
    const result = this.queue.catch(() => {}).then(() => new Promise<T>((resolve, reject) => {
      if (epoch !== this.epoch) { reject(new Error('Queued desktop operation cancelled.')); return; }
      const bundled = join(__dirname, '../../../../../python/bin/python3');
      const executable = process.env['SKYWING_PYTHON'] || (this.platform === 'linux' && existsSync('/usr/bin/python3') ? '/usr/bin/python3' : existsSync(bundled) ? bundled : 'python3');
      const child = spawn(executable, ['-c', UNIX_DESKTOP_SOURCE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.unixChildren.add(child);
      let output = '', diagnostic = '', done = false;
      const finish = (error?: Error, value?: T) => {
        if (done) return; done = true; clearTimeout(timer); this.unixChildren.delete(child);
        error ? reject(error) : resolve(value!);
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error('Desktop helper timed out. Observe before retrying; input may be partial.')); }, timeoutMs);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 40_000_000) { child.kill(); finish(new Error('Desktop capture is too large.')); } });
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
      child.once('error', e => finish(new Error(`Desktop helper unavailable: ${e.message}. Check Python 3 and platform desktop permissions.`)));
      child.once('close', code => {
        if (epoch !== this.epoch) { finish(new Error('Desktop control stopped. Observe before continuing.')); return; }
        if (code !== 0) { finish(new Error(`Desktop helper failed: ${diagnostic}`)); return; }
        try {
          const response = JSON.parse(output);
          if (!response.ok) { finish(new Error(String(response.error))); return; }
          const action = data['action'] as VisualDesktopInput | undefined, root = data['root'] as VisualDesktopRoot | undefined;
          if (command === 'input' && root && action?.x !== undefined && action.y !== undefined) this.keyboardPoints.set(root.windowId, { x: action.x, y: action.y });
          finish(undefined, response.result as T);
        } catch { finish(new Error('Invalid desktop helper response.')); }
      });
      child.stdin.on('error', e => finish(e));
      const root = data['root'] as VisualDesktopRoot | undefined;
      child.stdin.end(JSON.stringify({ command, inputMode: this.inputMode, ...data, keyboardPoint: root ? this.keyboardPoints.get(root.windowId) : undefined }));
    }));
    this.queue = result.catch(() => {}); return result;
  }
}
