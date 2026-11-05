import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { execFileSync, spawn } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { LoggerService } from '../core/logger/logger.service.js';

/** 平台标识 */
const PLAT = platform();
const IS_WIN = PLAT === 'win32';

/** 浏览器导航结果 */
export interface NavigateResult {
  ok: boolean;
  url?: string;
  title?: string;
  targetId?: string;
  error?: string;
  message?: string;
}

/** 截图结果 */
export interface BrowserScreenshotResult {
  ok: boolean;
  path?: string;
  size?: number;
  mimeType?: string;
  error?: string;
}

/** 快照结果 */
export interface SnapshotResult {
  ok: boolean;
  snapshot?: unknown;
  refs?: Record<string, { role: string; name: string; nth?: number }>;
  text?: string;
  refMode?: string;
  fallback?: boolean;
  url?: string;
  title?: string;
  domInfo?: unknown;
  error?: string;
}

/** 操作参数 */
export interface ActionParams {
  kind?: string;
  action?: string;
  selector?: string;
  ref?: string;
  text?: string;
  button?: string;
  doubleClick?: boolean;
  clear?: boolean;
  submit?: boolean;
  delayMs?: number;
  key?: string;
  keys?: string;
  x?: number;
  y?: number;
  dy?: number;
  deltaY?: number;
  timeMs?: number;
  timeoutMs?: number;
  value?: string;
  values?: string[];
}

/** 操作结果 */
export interface ActResult {
  ok: boolean;
  action?: string;
  target?: string;
  text?: string;
  key?: string;
  deltaY?: number;
  duration?: number;
  error?: string;
}

/** 提取结果 */
export interface ExtractResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  links?: Array<{ text: string; href: string }>;
  total?: number;
  tables?: Array<{ index: number; rows: number; headers: string[] }>;
  error?: string;
}

/** 标签页信息 */
export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
}

/** 标签页列表结果 */
export interface TabsResult {
  ok: boolean;
  tabs: TabInfo[];
}

/** 浏览器状态 */
export interface BrowserStatus {
  ok: boolean;
  connected: boolean;
  cdpUrl: string | null;
  port: string | null;
  tabs: TabInfo[];
}

/** 截图选项 */
export interface ScreenshotOptions {
  targetId?: string;
  fullPage?: boolean;
  element?: string;
}

/** 快照选项 */
export interface SnapshotOptions {
  targetId?: string;
  refs?: string;
}

/** PDF 导出选项 */
export interface PdfOptions {
  targetId?: string;
  /** 保存路径（调用方须完成白名单校验；缺省落临时目录） */
  outputPath?: string;
  landscape?: boolean;
  printBackground?: boolean;
  /** 纸张宽（英寸，CDP paperWidth，默认 8.5） */
  paperWidth?: number;
  /** 纸张高（英寸，CDP paperHeight，默认 11） */
  paperHeight?: number;
  /** 缩放 0.1-2 */
  scale?: number;
  /** 页码范围，如 '1-5' */
  pageRanges?: string;
}

/** PDF 导出结果 */
export interface PdfResult {
  ok: boolean;
  path?: string;
  size?: number;
  error?: string;
}

/** 文件上传选项 */
export interface UploadOptions {
  targetId?: string;
  /** input[type=file] 的 CSS 选择器或 snapshot 元素引用（如 e12） */
  selector: string;
  /** 本地文件绝对路径列表（调用方须完成白名单校验） */
  filePaths: string[];
}

/** 文件上传结果 */
export interface UploadResult {
  ok: boolean;
  files?: number;
  error?: string;
}

/** JS 对话框处理选项 */
export interface DialogOptions {
  targetId?: string;
  /** accept/dismiss；不传则仅查询最近对话框状态 */
  response?: 'accept' | 'dismiss';
  /** prompt 对话框的输入文本（accept 时有效） */
  promptText?: string;
}

/** JS 对话框状态快照 */
export interface DialogInfo {
  /** alert/confirm/prompt/beforeunload */
  type: string;
  message: string;
  defaultValue: string;
  time: string;
  handled: boolean;
}

/** JS 对话框处理结果 */
export interface DialogResult {
  ok: boolean;
  dialog?: DialogInfo | null;
  handled?: boolean;
  error?: string;
}

/** console 日志读取选项 */
export interface ConsoleOptions {
  targetId?: string;
  /** 返回最近 N 条，默认 50 */
  limit?: number;
  /** 读取后清空缓冲 */
  clear?: boolean;
}

/** console 日志读取结果 */
export interface ConsoleResult {
  ok: boolean;
  logs: Array<{ type: string; text: string; time: string }>;
  errors: Array<{ message: string; time: string }>;
  error?: string;
}

/** 页面状态 */
interface PageState {
  console: Array<{ type: string; text: string; time: string }>;
  errors: Array<{ message: string; time: string }>;
  requests: unknown[];
  roleRefs: Record<string, { role: string; name: string; nth?: number }> | null;
  roleRefsMode: string;
  /** 最近一次 JS 对话框状态（page.on('dialog') 记录，供 dialog action 查询/处理） */
  lastDialog: DialogInfo | null;
  /** 最近对话框的 playwright 句柄（用于 accept/dismiss；未处理期间对话框保持打开） */
  dialogHandle: any | null;
}

/**
 * BrowserService - 浏览器自动化服务
 *
 * 全量移植自 packages/web/browser-manager.cjs，包含：
 *   - connectBrowser：通过 CDP 连接 Chrome/Edge 浏览器
 *   - launchChromeWithDebug：自动启动带调试端口的浏览器
 *   - navigate：页面导航
 *   - screenshot：网页截图（全页/元素）
 *   - snapshot：无障碍快照（UIA 元素树）
 *   - act：执行操作（click/type/press/scroll/hover/wait/select/focus/close）
 *   - extract：提取页面内容（text/links/tables）
 *   - pdf：导出当前页面为 PDF（CDP Page.printToPDF）
 *   - upload：向 input[type=file] 上传本地文件（CDP DOM.setFileInputFiles）
 *   - dialog：JS 对话框状态查询与 accept/dismiss 处理（promptText 支持）
 *   - console：读取页面 console 日志（console 通道即 CDP Runtime.consoleAPICalled）
 *   - openTab：打开新标签页
 *   - tabs：列出所有标签页
 *   - status：获取浏览器连接状态
 *   - close：关闭浏览器连接
 *
 * 使用 playwright-core（动态加载）通过 CDP 协议连接浏览器。
 * 安全：禁用 page.evaluate 直接执行任意 JS 代码。
 */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  /** playwright-core 模块缓存 */
  private pw: any = null;
  /** 已连接的浏览器实例 */
  private connectedBrowser: any = null;
  /** CDP URL */
  private cdpUrl: string | null = null;
  /** 页面状态映射（WeakMap 避免内存泄漏） */
  private pageStates: WeakMap<object, PageState> = new WeakMap();
  /** 浏览器启动标志（防并发启动） */
  private browserStarting = false;

  constructor(private readonly logger: LoggerService) {}

  /**
   * 模块销毁时关闭浏览器连接
   */
  onModuleDestroy(): void {
    this.close();
  }

  /** 动态加载 playwright-core */
  private async initPlaywright(): Promise<any> {
    if (this.pw) return this.pw;
    try {
      this.pw = require('playwright-core');
      return this.pw;
    } catch {
      // 尝试动态 import
    }
    try {
      this.pw = await import('playwright-core');
      return this.pw;
    } catch {
      // 尝试从全局 node_modules 加载
      try {
        const npmRoot = execFileSync('npm', ['root', '-g'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        }).trim();
        this.pw = require(join(npmRoot, 'playwright-core'));
        return this.pw;
      } catch {
        this.logger.error('playwright-core not found. Install: pnpm install playwright-core');
        return null;
      }
    }
  }

  /** 获取 chromium 浏览器类型 */
  private getChromium(): any {
    return this.pw ? this.pw.chromium : null;
  }

  /** 查找已运行的 Chrome/Edge 调试端口 */
  private async findChromeDebugPort(): Promise<number | null> {
    try {
      if (IS_WIN) {
        // 查询进程命令行的 PowerShell 管道脚本（完全硬编码，无外部输入拼接）
        const cmdlinePs =
          'Get-Process {PROC} -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.CommandLine }';
        const result = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', cmdlinePs.replace('{PROC}', 'chrome')],
          { encoding: 'utf8', timeout: 5000, windowsHide: true },
        ).trim();
        if (result && result.includes('remote-debugging-port')) {
          const match = result.match(/remote-debugging-port=(\d+)/);
          if (match) return parseInt(match[1]!, 10);
        }
        const result2 = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', cmdlinePs.replace('{PROC}', 'msedge')],
          { encoding: 'utf8', timeout: 5000, windowsHide: true },
        ).trim();
        if (result2 && result2.includes('remote-debugging-port')) {
          const match2 = result2.match(/remote-debugging-port=(\d+)/);
          if (match2) return parseInt(match2[1]!, 10);
        }
      }
    } catch {
      // 忽略
    }
    // 扫描 9222-9235 端口
    for (let p = 9222; p <= 9235; p++) {
      try {
        const res = await fetch('http://127.0.0.1:' + p + '/json/version');
        if (res.ok) return p;
      } catch {
        // 端口未开放，继续
      }
    }
    return null;
  }

  /** 启动带调试端口的 Chrome/Edge 浏览器 */
  private async launchChromeWithDebug(): Promise<number | null> {
    if (this.browserStarting) return null;
    this.browserStarting = true;

    let chromePath: string | null = null;
    let possiblePaths: string[] = [];
    if (IS_WIN) {
      possiblePaths = [
        (process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES(X86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['LOCALAPPDATA'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
        (process.env['PROGRAMFILES(x86)'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
    } else if (PLAT === 'darwin') {
      possiblePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    } else {
      possiblePaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];
    }
    for (const p of possiblePaths) {
      if (p && existsSync(p)) {
        chromePath = p;
        break;
      }
    }
    if (!chromePath) {
      this.browserStarting = false;
      throw new Error('未找到Chrome/Edge浏览器，请安装或手动启动带 --remote-debugging-port 参数的浏览器');
    }
    const debugPort = 9222;
    const userDataDir = join(tmpdir(), 'skyalyticwing-browser-profile');
    try {
      mkdirSync(userDataDir, { recursive: true });
    } catch {
      // 忽略
    }
    const args = [
      '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + userDataDir,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-infobars',
      '--window-size=1280,900',
      '--restore-last-session',
    ];
    if (PLAT !== 'darwin') args.push('--start-maximized');
    this.logger.info('启动浏览器: ' + chromePath);
    const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    // Windows 下延迟 2s 将浏览器窗口置前
    if (IS_WIN) {
      try {
        setTimeout(() => {
          try {
            const fgScript = [
              'Add-Type @"',
              'using System;',
              'using System.Runtime.InteropServices;',
              'public class Win32FG {',
              '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
              '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
              '}"@',
              '$procs = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -ne ""}',
              'if ($procs) { [Win32FG]::ShowWindow($procs[0].MainWindowHandle, 9); [Win32FG]::SetForegroundWindow($procs[0].MainWindowHandle) }',
            ].join('\r\n');
            execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
              input: fgScript,
              timeout: 5000,
              windowsHide: true,
            });
          } catch {
            // 忽略
          }
        }, 2000);
      } catch {
        // 忽略
      }
    }
    // 等待调试端口就绪（最多 10s）
    for (let w = 0; w < 20; w++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch('http://127.0.0.1:' + debugPort + '/json/version');
        if (res.ok) {
          this.cdpUrl = 'http://127.0.0.1:' + debugPort;
          this.browserStarting = false;
          return debugPort;
        }
      } catch {
        // 端口未就绪，继续等待
      }
    }
    this.browserStarting = false;
    throw new Error('浏览器启动超时（10秒）');
  }

  /** 连接到浏览器（CDP） */
  async connectBrowser(options?: { port?: number; autoLaunch?: boolean }): Promise<any> {
    const opts = options || {};
    const pw = await this.initPlaywright();
    if (!pw) throw new Error('playwright-core 未安装或加载失败');
    if (this.connectedBrowser) {
      try {
        if (this.connectedBrowser.contexts().length > 0 || (await this.connectedBrowser.version().catch(() => ''))) {
          return this.connectedBrowser;
        }
      } catch {
        // 旧连接已失效
      }
      this.logger.info('旧连接已失效，重新连接...');
      try {
        await this.connectedBrowser.close().catch(() => {});
      } catch {
        // 忽略
      }
      this.connectedBrowser = null;
    }
    let port = opts.port || (await this.findChromeDebugPort());
    if (!port && opts.autoLaunch !== false) {
      port = await this.launchChromeWithDebug();
    }
    if (!port) {
      throw new Error('无法连接到浏览器。请启动 Chrome/Edge 并带上参数 --remote-debugging-port=9222');
    }
    this.cdpUrl = 'http://127.0.0.1:' + port;
    try {
      const chromium = this.getChromium();
      this.connectedBrowser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 10000 });
      this.logger.info('已通过CDP连接到浏览器 (port=' + port + ')');
      return this.connectedBrowser;
    } catch (e) {
      if (opts.autoLaunch !== false && !this.browserStarting) {
        this.logger.info('CDP直连失败，尝试启动新浏览器...');
        port = await this.launchChromeWithDebug();
        if (port) {
          this.cdpUrl = 'http://127.0.0.1:' + port;
          const chromium2 = this.getChromium();
          this.connectedBrowser = await chromium2.connectOverCDP(this.cdpUrl, { timeout: 15000 });
          return this.connectedBrowser;
        }
      }
      throw e;
    }
  }

  /** 确保页面状态被追踪（console/error 事件监听） */
  private ensurePageState(page: any): PageState | null {
    if (!this.pw) return null;
    const existing = this.pageStates.get(page);
    if (existing) return existing;
    const state: PageState = {
      console: [],
      errors: [],
      requests: [],
      roleRefs: null,
      roleRefsMode: 'role',
      lastDialog: null,
      dialogHandle: null,
    };
    page.on('console', (msg: any) => {
      state.console.push({ type: msg.type(), text: msg.text(), time: new Date().toISOString() });
      if (state.console.length > 200) state.console.shift();
    });
    // JS 对话框（Page.javascriptDialogOpening）：仅记录状态、不自动处理——
    // 对话框保持打开、页面 JS 阻塞（与原生模态语义一致），
    // 由 browser dialog action 显式 accept/dismiss（Page.handleJavaScriptDialog 语义）
    page.on('dialog', (dialog: any) => {
      state.lastDialog = {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        time: new Date().toISOString(),
        handled: false,
      };
      state.dialogHandle = dialog;
    });
    page.on('pageerror', (err: Error) => {
      state.errors.push({ message: err.message, time: new Date().toISOString() });
      if (state.errors.length > 50) state.errors.shift();
    });
    page.on('close', () => {
      this.pageStates.delete(page);
    });
    this.pageStates.set(page, state);
    return state;
  }

  /** 获取页面（按 targetId 或第一个可用页面） */
  private async getPage(targetId?: string): Promise<any> {
    const browser = await this.connectBrowser({ autoLaunch: false });
    if (!browser) throw new Error('浏览器未连接');
    const contexts = browser.contexts();
    let pages: any[] = [];
    for (const ctx of contexts) {
      pages = pages.concat(ctx.pages());
    }
    if (!pages.length) {
      const ctx = browser.contexts()[0] || (await browser.newContext());
      const newPage = await ctx.newPage();
      this.ensurePageState(newPage);
      return newPage;
    }
    if (!targetId) {
      this.ensurePageState(pages[0]);
      return pages[0];
    }
    for (const page of pages) {
      try {
        const tid = await page.evaluate(() => (window as any).__targetId || '');
        if (tid === targetId) {
          this.ensurePageState(page);
          return page;
        }
      } catch {
        // 忽略
      }
    }
    if (pages.length === 1) {
      this.ensurePageState(pages[0]);
      return pages[0];
    }
    this.ensurePageState(pages[0]);
    return pages[0];
  }

  /** 打开 URL（在默认浏览器中打开外部链接） */
  async openUrl(url: string): Promise<void> {
    if (!this.isValidUrl(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (IS_WIN) {
      await this.execAsync('cmd', ['/c', 'start', '', url]);
    } else if (PLAT === 'darwin') {
      await this.execAsync('open', [url]);
    } else {
      await this.execAsync('xdg-open', [url]);
    }
    this.logger.info('URL opened in default browser', { url });
  }

  /** 简单 URL 合法性校验（仅 http/https） */
  private isValidUrl(url: string): boolean {
    if (typeof url !== 'string' || url.length === 0) return false;
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private execAsync(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      import('node:child_process').then(({ execFile }) => {
        execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /** 页面导航 */
  async navigate(url: string, targetId?: string): Promise<NavigateResult> {
    const page = await this.getPage(targetId);
    let navError: string | null = null;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: Error) => {
      navError = e.message || String(e);
    });
    if (navError) {
      return { ok: false, error: '导航失败: ' + navError, url };
    }
    const tid = await page.evaluate(() => {
      (window as any).__targetId = (window as any).__targetId || ('t' + Date.now().toString(36));
      return (window as any).__targetId;
    });
    return { ok: true, url: page.url(), title: await page.title(), targetId: tid };
  }

  /** 网页截图（全页/元素） */
  async screenshot(url: string): Promise<{ success: boolean; path?: string; error?: string }>;
  async screenshot(options?: ScreenshotOptions): Promise<BrowserScreenshotResult>;
  async screenshot(urlOrOpts?: string | ScreenshotOptions): Promise<{ success: boolean; path?: string; error?: string } | BrowserScreenshotResult> {
    // 兼容控制器旧接口：传入 URL 字符串
    if (typeof urlOrOpts === 'string') {
      if (!this.isValidUrl(urlOrOpts)) {
        throw new Error(`Invalid URL: ${urlOrOpts}`);
      }
      try {
        const navigation = await this.navigate(urlOrOpts);
        if (!navigation.ok) return { success: false, error: navigation.error ?? '页面导航失败' };
        const result = await this.browserScreenshot(navigation.targetId ? { targetId: navigation.targetId } : {});
        return { success: result.ok, ...(result.path ? { path: result.path } : {}), ...(result.error ? { error: result.error } : {}) };
      } catch (err) {
        this.logger.warn('Browser screenshot failed', { error: err instanceof Error ? err.message : String(err) });
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.browserScreenshot(urlOrOpts || {});
  }

  /** 网页截图（完整实现） */
  async browserScreenshot(options?: ScreenshotOptions): Promise<BrowserScreenshotResult> {
    const opts = options || {};
    const page = await this.getPage(opts.targetId);
    const screenshotDir = join(tmpdir(), 'skyalyticwing-screenshots');
    mkdirSync(screenshotDir, { recursive: true });
    const filePath = join(screenshotDir, 'screenshot-' + Date.now() + '.png');
    const screenshotOpts: { type: 'png'; fullPage: boolean; path?: string } = { type: 'png', fullPage: !!opts.fullPage };
    if (opts.element) {
      const el = page.locator(opts.element).first();
      await el.screenshot(Object.assign({}, screenshotOpts, { path: filePath }));
    } else {
      await page.screenshot(Object.assign({}, screenshotOpts, { path: filePath }));
    }
    const stats = statSync(filePath);
    return { ok: true, path: filePath, size: stats.size, mimeType: 'image/png' };
  }

  /** 无障碍快照（UIA 元素树，含回退 DOM 提取） */
  async browserSnapshot(options?: SnapshotOptions): Promise<SnapshotResult> {
    const opts = options || {};
    const page = await this.getPage(opts.targetId);
    if (!page) throw new Error('无法获取页面对象');
    try {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } catch {
      // 忽略
    }
    try {
      await page.waitForTimeout(500).catch(() => {});
    } catch {
      // 忽略
    }
    const mode = opts.refs || 'role';
    let pageUrl = '';
    let pageTitle = '';
    try {
      pageUrl = page.url();
    } catch {
      // 忽略
    }
    try {
      pageTitle = await page.title().catch(() => '');
    } catch {
      // 忽略
    }
    let snapshot: any = null;
    try {
      snapshot = await page.accessibility.snapshot({ mode: mode === 'aria' ? 'aria' : 'spatial' });
    } catch (accErr) {
      // accessibility.snapshot 失败，使用 DOM 结构化提取
      this.logger.warn('accessibility.snapshot失败，使用DOM结构化提取: ' + (accErr as Error).message);
      try {
        const domInfo = await page.evaluate(() => {
          const result: { interactive: any[]; headings: any[]; textBlocks: string[]; error?: string } = {
            interactive: [],
            headings: [],
            textBlocks: [],
          };
          try {
            const allInteractive = document.querySelectorAll(
              'a[href],button:not([disabled]),input:not([type=hidden]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="menuitem"],[tabindex]:not([tabindex="-1"])',
            );
            for (let i = 0; i < Math.min(allInteractive.length, 80); i++) {
              const el = allInteractive[i] as HTMLElement;
              if (el.offsetParent === null || el.offsetWidth === 0) continue;
              result.interactive.push({
                ref: 'e' + (i + 1),
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                text: (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el as HTMLInputElement).value || (el.textContent || '').trim()).substring(0, 80),
                href: ((el as HTMLAnchorElement).href || '').substring(0, 120),
                type: (el as HTMLInputElement).type || '',
              });
            }
            const hEls = document.querySelectorAll('h1,h2,h3');
            for (let hi = 0; hi < Math.min(hEls.length, 10); hi++) {
              result.headings.push({ level: hEls[hi].tagName, text: (hEls[hi].textContent || '').trim().substring(0, 100) });
            }
            const mainContent = document.querySelector('main,[role="main"],#content,.content,#app') || document.body;
            const paragraphs = mainContent.querySelectorAll('p,li,div');
            for (let pi = 0; pi < Math.min(paragraphs.length, 15); pi++) {
              const pt = (paragraphs[pi].textContent || '').trim();
              if (pt.length > 5) result.textBlocks.push(pt.substring(0, 150));
            }
          } catch (e) {
            result.error = (e as Error).message;
          }
          return result;
        });
        const fallbackSnapshot: any = { role: 'WebArea', name: pageTitle || '', children: [] };
        const refs: Record<string, { role: string; name: string }> = {};
        for (const item of (domInfo.interactive || [])) {
          const refKey = item.ref;
          refs[refKey] = { role: item.role || item.tag, name: item.text };
          fallbackSnapshot.children.push({ role: item.role || item.tag, name: item.text, _ref: refKey });
        }
        const headingText = (domInfo.headings || []).map((h: any) => '  #' + h.level.replace(/h/i, '') + ' ' + h.text).join('\n');
        const textBlockText = (domInfo.textBlocks || []).slice(0, 8).map((t: string) => '  - ' + t).join('\n');
        let domSummary = '[页面: ' + (pageTitle || pageUrl || '未知') + ' | URL: ' + pageUrl + ']\n';
        domSummary += '[交互元素: ' + (domInfo.interactive || []).length + '个]\n';
        if (headingText) domSummary += '\n[页面标题]\n' + headingText + '\n';
        if (textBlockText) domSummary += '\n[主要内容]\n' + textBlockText + '\n';
        domSummary += '\n[可交互元素列表]\n' + this.formatSnapshotText(fallbackSnapshot, 0);
        return { ok: true, snapshot: fallbackSnapshot, refs, text: domSummary, refMode: mode, fallback: true, url: pageUrl, title: pageTitle, domInfo };
      } catch (fallbackErr) {
        // DOM 结构化提取也失败
        this.logger.warn('DOM结构化提取也失败了: ' + (fallbackErr as Error).message);
        const simpleText = await page.textContent().catch(() => '(页面内容获取失败)');
        const outText = '[页面: ' + (pageTitle || pageUrl || '未知') + ' | URL: ' + (pageUrl || '') + ']\n' + (simpleText || '').substring(0, 2000);
        return { ok: true, snapshot: { role: 'WebArea', name: pageTitle || '' }, refs: {}, text: outText, refMode: mode, fallback: true, url: pageUrl, title: pageTitle };
      }
    }
    // 成功获取 accessibility snapshot，提取 refs
    const state = this.pageStates.get(page);
    const refs: Record<string, { role: string; name: string; nth?: number }> = {};
    let refCounter = 1;
    const extractRefs = (node: any): void => {
      if (!node) return;
      if (node.role && node.role !== 'None' && node.role !== 'StaticText' && node.role !== 'List' && node.role !== 'WebArea') {
        const refKey = 'e' + refCounter++;
        refs[refKey] = { role: node.role, name: node.name || '' };
        node._ref = refKey;
      }
      if (node.children) {
        for (const child of node.children) {
          extractRefs(child);
        }
      }
    };
    extractRefs(snapshot);
    if (state) {
      state.roleRefs = refs;
      state.roleRefsMode = mode;
    }
    const textOutput = '[页面: ' + (pageTitle || pageUrl || '未知') + ' | URL: ' + (pageUrl || '') + ']\n' + this.formatSnapshotText(snapshot, 0);
    return { ok: true, snapshot, refs, text: textOutput, refMode: mode, url: pageUrl, title: pageTitle };
  }

  /** 格式化快照为文本（递归） */
  private formatSnapshotText(node: any, depth: number): string {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    let line = '';
    if (node.role === 'StaticText' || node.role === 'text') {
      line = indent + (node.name || '').substring(0, 80);
    } else if (node.role && node.role !== 'None' && node.role !== 'WebArea') {
      const refStr = node._ref ? '[' + node._ref + ']' : '';
      const nameStr = node.name ? ' "' + (node.name as string).substring(0, 40) + '"' : '';
      line = indent + refStr + node.role + (nameStr ? ' ' + nameStr : '');
    }
    let children = '';
    if (node.children) {
      for (let i = 0; i < Math.min(node.children.length, 30); i++) {
        children += this.formatSnapshotText(node.children[i], depth + 1) + '\n';
      }
      if (node.children.length > 30) children += indent + '  ... (' + (node.children.length - 30) + ' more)\n';
    }
    return line ? line + '\n' + children : children;
  }

  /** 解析 ref 为 Playwright locator */
  private resolveRefLocator(page: any, ref: string): any {
    const normalized = ref.replace(/^@/, '');
    const state = this.pageStates.get(page);
    if (/^e\d+$/.test(normalized)) {
      if (state && state.roleRefs && state.roleRefs[normalized]) {
        const info = state.roleRefs[normalized]!;
        const locator = page.getByRole(info.role.toLowerCase(), info.name ? { name: info.name, exact: true } : {});
        if (info.nth !== undefined) return locator.nth(info.nth);
        return locator;
      }
      return page.locator('aria-ref=' + normalized);
    }
    return page.locator(normalized);
  }

  /** 执行浏览器操作（click/type/press/scroll/hover/wait/select/focus/close） */
  async browserAct(actionParams: ActionParams, targetId?: string): Promise<ActResult> {
    const page = await this.getPage(targetId);
    const kind = actionParams.kind || actionParams.action || '';
    const selector = actionParams.selector || actionParams.ref;
    const text = actionParams.text;
    const button = actionParams.button || 'left';

    switch (kind) {
      case 'click': {
        const clickLocator = selector ? this.resolveRefLocator(page, selector) : null;
        if (clickLocator) {
          if (button === 'right') await clickLocator.click({ button: 'right' });
          else if (actionParams.doubleClick) await clickLocator.dblclick();
          else await clickLocator.click();
        } else if (actionParams.x !== undefined && actionParams.y !== undefined) {
          await page.mouse.click(actionParams.x, actionParams.y, { button });
        }
        return { ok: true, action: 'click', target: selector || '(' + actionParams.x + ',' + actionParams.y + ')' };
      }
      case 'type': {
        const typeLocator = selector ? this.resolveRefLocator(page, selector) : null;
        const typeText = text || '';
        if (typeLocator) {
          if (actionParams.clear !== false) await typeLocator.fill('');
          await typeLocator.type(typeText, { delay: actionParams.delayMs || 30 });
        } else {
          await page.keyboard.type(typeText, { delay: actionParams.delayMs || 30 });
        }
        if (actionParams.submit) await page.keyboard.press('Enter');
        return { ok: true, action: 'type', text: typeText.substring(0, 50) + (typeText.length > 50 ? '...' : '') };
      }
      case 'press':
      case 'key': {
        const keyToPress = actionParams.key || actionParams.keys || text || 'Enter';
        await page.keyboard.press(keyToPress);
        return { ok: true, action: 'press', key: keyToPress };
      }
      case 'scroll': {
        const scrollDeltaY = actionParams.dy || actionParams.deltaY || 200;
        await page.mouse.wheel(0, scrollDeltaY);
        return { ok: true, action: 'scroll', deltaY: scrollDeltaY };
      }
      case 'hover': {
        const hoverLocator = selector ? this.resolveRefLocator(page, selector) : null;
        if (hoverLocator) await hoverLocator.hover();
        else if (actionParams.x !== undefined) await page.mouse.move(actionParams.x, actionParams.y!);
        return { ok: true, action: 'hover' };
      }
      case 'wait': {
        const waitMs = actionParams.timeMs || actionParams.timeoutMs || 2000;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 30000)));
        return { ok: true, action: 'wait', duration: waitMs };
      }
      case 'select': {
        const selectLocator = selector ? this.resolveRefLocator(page, selector) : null;
        if (selectLocator) await selectLocator.selectOption(actionParams.value || actionParams.values || []);
        return { ok: true, action: 'select' };
      }
      case 'focus': {
        if (selector) {
          const focusLoc = this.resolveRefLocator(page, selector);
          await focusLoc.focus();
        }
        return { ok: true, action: 'focus' };
      }
      case 'close': {
        await page.close().catch(() => {});
        return { ok: true, action: 'close' };
      }
      default:
        throw new Error('未知操作类型: ' + kind);
    }
  }

  /** 提取页面内容（text/links/tables） */
  async browserExtract(options?: { targetId?: string; format?: string }): Promise<ExtractResult> {
    const opts = options || {};
    const page = await this.getPage(opts.targetId);
    const format = opts.format || 'text';
    switch (format) {
      case 'text': {
        const txt = await page.innerText('body').catch(() => page.textContent());
        return { ok: true, text: (txt || '').substring(0, 10000), truncated: (txt || '').length > 10000 };
      }
      case 'links': {
        const links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            text: (a.textContent || '').trim(),
            href: (a as HTMLAnchorElement).href,
          })).filter((l) => l.href);
        });
        return { ok: true, links: links.slice(0, 100), total: links.length };
      }
      case 'tables': {
        const tables = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('table')).map((t, idx) => ({
            index: idx,
            rows: t.rows.length,
            headers: Array.from(t.querySelectorAll('th')).map((h) => h.textContent.trim()),
          }));
        });
        return { ok: true, tables };
      }
      default: {
        const bodyText = await page.textContent();
        return { ok: true, text: (bodyText || '').substring(0, 10000) };
      }
    }
  }

  /** 导出当前页面为 PDF（CDP Page.printToPDF，headful Chrome 亦支持） */
  async browserPdf(options?: PdfOptions): Promise<PdfResult> {
    const opts = options || {};
    try {
      const page = await this.getPage(opts.targetId);
      // 保存路径：显式传入则由调用方完成白名单校验，默认落临时目录
      const pdfDir = join(tmpdir(), 'skyalyticwing-browser-downloads');
      mkdirSync(pdfDir, { recursive: true });
      const filePath = opts.outputPath || join(pdfDir, 'page-' + Date.now() + '.pdf');
      const client = await page.context().newCDPSession(page);
      try {
        const printParams: Record<string, unknown> = {
          landscape: opts.landscape === true,
          printBackground: opts.printBackground !== false,
        };
        if (typeof opts.paperWidth === 'number') printParams['paperWidth'] = opts.paperWidth;
        if (typeof opts.paperHeight === 'number') printParams['paperHeight'] = opts.paperHeight;
        if (typeof opts.scale === 'number') printParams['scale'] = opts.scale;
        if (opts.pageRanges) printParams['pageRanges'] = opts.pageRanges;
        const result: { data: string } = await client.send('Page.printToPDF', printParams);
        const buf = Buffer.from(result.data, 'base64');
        writeFileSync(filePath, buf);
        return { ok: true, path: filePath, size: buf.length };
      } finally {
        await client.detach().catch(() => {});
      }
    } catch (e) {
      return { ok: false, error: 'PDF 导出失败: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  /** 文件上传：定位 input[type=file] 后经 CDP DOM.setFileInputFiles 设置文件列表 */
  async browserUpload(options: UploadOptions): Promise<UploadResult> {
    try {
      const page = await this.getPage(options.targetId);
      // resolveRefLocator 同时支持 CSS 选择器与 snapshot ref（e12）；
      // setInputFiles 底层即 CDP DOM.setFileInputFiles
      const locator = this.resolveRefLocator(page, options.selector);
      await locator.setInputFiles(options.filePaths);
      return { ok: true, files: options.filePaths.length };
    } catch (e) {
      return { ok: false, error: '文件上传失败: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  /** JS 对话框处理：查询最近对话框状态，或显式 accept/dismiss（含 promptText） */
  async browserDialog(options?: DialogOptions): Promise<DialogResult> {
    const opts = options || {};
    const page = await this.getPage(opts.targetId);
    const state = this.ensurePageState(page);
    if (!state) return { ok: false, error: '页面状态追踪不可用（playwright 未加载）' };
    if (opts.response) {
      const handle = state.dialogHandle;
      if (!handle) {
        return { ok: false, error: '当前没有待处理的 JS 对话框' };
      }
      try {
        if (opts.response === 'accept') {
          await handle.accept(opts.promptText);
        } else {
          await handle.dismiss();
        }
        if (state.lastDialog) state.lastDialog.handled = true;
        state.dialogHandle = null;
        return { ok: true, handled: true, dialog: state.lastDialog };
      } catch (e) {
        return { ok: false, error: '对话框处理失败: ' + (e instanceof Error ? e.message : String(e)) };
      }
    }
    // 查询模式：返回最近一次对话框状态（可能为 null）
    return { ok: true, dialog: state.lastDialog };
  }

  /** 读取页面 console 日志（console 通道即 CDP Runtime.consoleAPICalled；errors 为未捕获异常） */
  async browserConsole(options?: ConsoleOptions): Promise<ConsoleResult> {
    const opts = options || {};
    const page = await this.getPage(opts.targetId);
    const state = this.ensurePageState(page);
    if (!state) return { ok: false, logs: [], errors: [], error: '页面状态追踪不可用（playwright 未加载）' };
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 50;
    const logs = state.console.slice(-limit);
    const errors = state.errors.slice(-Math.min(limit, 50));
    if (opts.clear === true) {
      state.console = [];
      state.errors = [];
    }
    return { ok: true, logs, errors };
  }

  /** 执行脚本（安全禁用：不允许直接执行任意 JS） */
  async browserExecute(_script: string): Promise<{ ok: boolean; error: string }> {
    // 禁用通过 page.evaluate(eval) 直接执行任意 JS 代码的路径，防止任意代码执行
    return { ok: false, error: 'Direct script execution is disabled for security' };
  }

  /** 打开新标签页 */
  async browserOpenTab(url?: string): Promise<NavigateResult> {
    const browser = await this.connectBrowser();
    let newTabUrl = 'chrome://newtab/';
    if (IS_WIN) {
      let isEdge = false;
      try {
        const procs = execFileSync('tasklist', ['/FI', 'IMAGENAME eq msedge.exe', '/NH'], {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
        });
        isEdge = procs.length > 0 && procs.includes('msedge');
      } catch {
        // 忽略
      }
      if (isEdge) newTabUrl = 'edge://newtab/';
    }
    if (!url || url === 'about:blank') {
      const contexts = browser.contexts();
      for (const ctx of contexts) {
        const pages = ctx.pages();
        for (const p of pages) {
          const pUrl = p.url();
          if (pUrl && pUrl !== 'about:blank' && pUrl !== '') {
            this.ensurePageState(p);
            const tid = await p.evaluate(() => {
              (window as any).__targetId = (window as any).__targetId || ('t' + Date.now().toString(36));
              return (window as any).__targetId;
            });
            return {
              ok: true,
              targetId: tid,
              url: p.url(),
              title: await p.title().catch(() => ''),
              message: '浏览器已打开，当前显示: ' + (await p.title().catch(() => pUrl)),
            };
          }
        }
      }
      const ctx = browser.contexts()[0] || (await browser.newContext());
      const page = await ctx.newPage();
      this.ensurePageState(page);
      await page.goto(newTabUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      const tid2 = await page.evaluate(() => {
        (window as any).__targetId = (window as any).__targetId || ('t' + Date.now().toString(36));
        return (window as any).__targetId;
      });
      const pageUrl = page.url();
      const pageTitle = await page.title().catch(() => '');
      return { ok: true, targetId: tid2, url: pageUrl, title: pageTitle, message: '浏览器已打开' + (pageTitle ? '，当前: ' + pageTitle : '') };
    }
    const ctx2 = browser.contexts()[0] || (await browser.newContext());
    const page2 = await ctx2.newPage();
    this.ensurePageState(page2);
    let openNavError: string | null = null;
    await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: Error) => {
      openNavError = e.message || String(e);
    });
    if (openNavError) {
      return { ok: false, error: '打开页面失败: ' + openNavError, url };
    }
    const tid3 = await page2.evaluate(() => {
      (window as any).__targetId = (window as any).__targetId || ('t' + Date.now().toString(36));
      return (window as any).__targetId;
    });
    return { ok: true, targetId: tid3, url: page2.url(), title: await page2.title().catch(() => ''), message: '已打开: ' + url };
  }

  /** 列出所有标签页 */
  async browserTabs(): Promise<TabsResult> {
    const browser = await this.connectBrowser({ autoLaunch: false });
    if (!browser) return { ok: true, tabs: [] };
    const contexts = browser.contexts();
    const tabs: TabInfo[] = [];
    for (const ctx of contexts) {
      const pages = ctx.pages();
      for (const p of pages) {
        tabs.push({
          targetId: await p.evaluate(() => (window as any).__targetId || ''),
          url: p.url(),
          title: await p.title().catch(() => ''),
        });
      }
    }
    return { ok: true, tabs };
  }

  /** 获取浏览器连接状态 */
  async browserStatus(): Promise<BrowserStatus> {
    const port = this.cdpUrl ? this.cdpUrl.replace(/[^:]*:(\d+).*/, '$1') : null;
    const connected = !!this.connectedBrowser;
    let tabsInfo: TabsResult | null = null;
    if (connected) {
      try {
        tabsInfo = await this.browserTabs();
      } catch {
        // 忽略
      }
    }
    return {
      ok: true,
      connected,
      cdpUrl: this.cdpUrl,
      port,
      tabs: tabsInfo ? tabsInfo.tabs : [],
    };
  }

  /** 关闭浏览器连接 */
  async close(): Promise<{ ok: boolean }> {
    if (this.connectedBrowser) {
      try {
        await this.connectedBrowser.close();
      } catch {
        // 忽略
      }
      this.connectedBrowser = null;
    }
    this.cdpUrl = null;
    return { ok: true };
  }
}
