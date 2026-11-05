import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  chromium,
  type Download,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core';
import { basename, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { NativeBrowserBridge } from './native-browser-bridge.js';
import { browserAddress } from './browser-address.js';
import { sameBrowserTarget, browserConditionMatches, validateBrowserWait, BrowserObservationError, type BrowserTarget, type BrowserWait } from './browser-observation.js';

/** 页面内可见元素快照项 */
export interface BrowserElementInfo {
  /** 稳定索引（1 起），AI/前端按此引用 */
  index: number;
  tag: string;
  role?: string | undefined;
  /** 可见文本（截断 120） */
  text?: string | undefined;
  /** 输入类提示：placeholder/aria-label/name */
  hint?: string | undefined;
  href?: string | undefined;
  /** 视口坐标 {x,y,w,h} */
  rect: { x: number; y: number; w: number; h: number };
  /** 输入类标记 */
  input?: boolean | undefined;
  disabled?: boolean;
  readonly?: boolean;
  checked?: boolean;
}

/** 页面快照（截图 + 元素清单 + console 摘要） */
export interface BrowserSnapshot {
  documentId?: string;
  readyState?: string;
  activeElement?: BrowserElementInfo | null;
  observationId?: string;
  pageId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** JPEG base64（无 data: 前缀） */
  screenshot: string;
  pageText?: string;
  elements: BrowserElementInfo[];
  elementsTruncated?: boolean;
  consoleTail: string[];
  markedAt: number;
}

/** 用户/前端在截图上的坐标点选结果：命中的元素详情 */
export interface BrowserElementDetail {
  index?: number | undefined;
  tag: string;
  role?: string | undefined;
  text?: string | undefined;
  hint?: string | undefined;
  href?: string | undefined;
  selector: string;
  outerHTML: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** 操作结果：统一返回操作后的快照，前端与 AI 拿到的始终是最新画面 */
export interface BrowserActionResult extends BrowserSnapshot {
  ok: true;
  action: string;
  detail?: string;
}

const VIEWPORT = { width: 1280, height: 800 };
const MAX_ELEMENTS = 200;
const CONSOLE_BUF = 120;
const CONSOLE_TAIL = 16;
const TEXT_LIMIT = 120;
const HTML_LIMIT = 2000;

/** 标记引擎：注入到每个页面，负责元素采集/编号叠加/坐标反查/信息提取。
 *  独立 IIFE，挂在 window.__skyBrowserMarker，MutationObserver 防抖重标。 */
const MARKER_SCRIPT = `
(() => {
  if (window.__skyBrowserMarker) {
    window.__skyBrowserMarker.refresh();
    return;
  }
  const box = document.createElement('div');
  box.id = '__sky_browser_marker_box';
  box.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;');
  const mount = () => (document.body || document.documentElement);
  const doc = document;
  const INTERACTIVE = 'a,button,input,select,textarea,summary,details,label,video,audio,canvas,svg use,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[role=menuitem],[role=slider],[onclick],[contenteditable="true"],[contenteditable=""]';
  const state = { items: [], timer: 0 };
  const elementIds = new WeakMap();
  let nextElementId = 1;

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const st = doc.defaultView.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return null;
    // 视口相交裁剪：只标视口内部分（截图即视口）
    const x1 = Math.max(0, r.left), y1 = Math.max(0, r.top);
    const x2 = Math.min(doc.documentElement.clientWidth, r.right);
    const y2 = Math.min(doc.documentElement.clientHeight, r.bottom);
    if (x2 - x1 < 2 || y2 - y1 < 2) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, raw: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }

  function hintOf(el) {
    return el.getAttribute('placeholder') || el.getAttribute('aria-label')
      || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('alt') || '';
  }

  function textOf(el) {
    if (el.tagName === 'INPUT' && el.type === 'password') return '[password]';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.value || '').slice(0, ${TEXT_LIMIT});
    }
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_LIMIT});
  }

  function mark() {
    // 挂载标记层（body 就绪前 mark 先收集、后挂载）
    if (!box.isConnected && doc.body) doc.body.appendChild(box);
    box.innerHTML = '';
    state.items.length = 0;
    const els = doc.querySelectorAll(INTERACTIVE);
    for (const el of els) {
      if (state.items.length >= ${MAX_ELEMENTS}) break;
      if (box.contains(el) || el.closest('#__sky_browser_marker_box')) continue;
      const r = visibleRect(el);
      if (!r) continue;
      if (!elementIds.has(el)) elementIds.set(el, nextElementId++);
      const idx = elementIds.get(el);
      state.items.push({ i: idx, el, rect: r });
      const hl = doc.createElement('div');
      hl.setAttribute('style', 'position:fixed;pointer-events:none;border:1px solid rgba(37,99,235,.85);background:rgba(37,99,235,.10);border-radius:2px;'
        + 'left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px;');
      const tag = doc.createElement('div');
      tag.setAttribute('style', 'position:fixed;pointer-events:none;background:#2563eb;color:#fff;font:600 10px/1.4 system-ui,sans-serif;'
        + 'padding:0 4px;border-radius:2px;white-space:nowrap;z-index:2147483647;'
        + 'left:' + Math.max(0, r.x) + 'px;top:' + Math.max(0, r.y - 14) + 'px;');
      tag.textContent = String(idx);
      box.append(hl, tag);
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { try { mark(); } catch {} }, 120);
  }

  function refresh() { try { mark(); } catch {} }

  function topItemAt(x, y) {
    let best = null;
    for (const it of state.items) {
      const r = it.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (!best || r.w * r.h < best.rect.w * best.rect.h) best = it;
      }
    }
    return best;
  }

  function cssPath(el) {
    if (!el || el === doc.documentElement) return 'html';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur !== doc.documentElement && depth < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      const name = cur.getAttribute && cur.getAttribute('name');
      if (name) sel += '[name="' + name.replace(/"/g, '') + '"]';
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = parent; depth += 1;
    }
    return parts.join(' > ').slice(0, 300);
  }

  function info(el, r) {
    const rr = r || (el.getBoundingClientRect ? visibleRect(el) : null) || { x: 0, y: 0, w: 0, h: 0, raw: { x: 0, y: 0, w: 0, h: 0 } };
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : 'unknown',
      role: el.getAttribute ? (el.getAttribute('role') || undefined) : undefined,
      text: textOf(el) || undefined,
      hint: hintOf(el) || undefined,
      href: (el.tagName === 'A' && el.getAttribute('href')) ? el.getAttribute('href') : undefined,
      selector: cssPath(el),
      outerHTML: el.tagName === 'INPUT' && el.type === 'password' ? '<input type="password">' : (el.outerHTML || '').slice(0, ${HTML_LIMIT}),
      rect: { x: rr.raw.x, y: rr.raw.y, w: rr.raw.w, h: rr.raw.h },
    };
  }

  function elementAt(x, y) {
    // 优先命中标记元素；未命中则按 elementFromPoint 向上找可交互祖先
    const hit = topItemAt(x, y);
    if (hit) return { index: hit.i, ...info(hit.el, hit.rect) };
    const raw = doc.elementFromPoint(x, y);
    if (!raw || raw.closest('#__sky_browser_marker_box')) return null;
    const inter = raw.closest(INTERACTIVE);
    const target = inter || raw;
    return { ...info(target) };
  }

  window.__skyBrowserMarker = { refresh, elementAt, items: state.items, documentId: Date.now().toString(36) + Math.random().toString(36) };
  // document-start 阶段 documentElement 可能尚未创建（file:// 等）：判空用 document 兜底，
  // DOMContentLoaded 后补一次首标（document-start 时 body 未建，首个 mark 收集不到元素）
  const root = doc.documentElement || doc;
  new MutationObserver((records) => {
    // Painting our own overlays must not schedule another paint forever.
    if (records.some((r) => r.target !== box && !box.contains(r.target)
      && !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => n === box)))) schedule();
  }).observe(root, { childList: true, subtree: true, attributes: true });
  doc.defaultView.addEventListener('scroll', schedule, true);
  doc.defaultView.addEventListener('resize', schedule);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', schedule);
  mark();
})();
`;

/** 页面条目 */
interface PageEntry {
  id: string;
  page: Page;
  consoleBuf: string[];
  closed: boolean;
  observations?: Map<string, { signature: string; at: number; snapshot: BrowserSnapshot }>;
}

/**
 * BuiltInBrowserService - AI 可操作的内置浏览器
 *
 * 桌面通过 NativeBrowserBridge 操作用户可见的 Tauri 标签页；
 * 仅纯 CLI 环境使用 playwright-core 无头适配器：
 *  - DOM 观察提供稳定元素编号，按需附带视口截图
 *  - 元素快照 / 坐标点选取元素详情（供"添加到对话"）
 *  - click / fill / select / key / scroll / 导航等操作，操作后统一返回最新快照
 *  - console / pageerror / 请求失败捕获（AI 调试信息）
 *
 * AI 通过可卸载扩展的 builtin_browser 工具使用同一服务。
 */
@Injectable()
export class BuiltInBrowserService implements OnModuleDestroy {
  constructor(@Optional() private readonly security?: SecurityManagerService) {}
  native = new NativeBrowserBridge();
  private nativeSession = 'default';
  private nativeObservations = new Map<string, { signature: string; at: number; pageId: string; snapshot: BrowserSnapshot }>();
  private captureScreenshots = true;
  private operationSignal: AbortSignal | undefined;
  private epoch = 0;
  private operationEpoch = 0;
  private actor: 'agent' | 'user' | null = null;
  private controlling = false;
  private readonly logger = new Logger('BuiltInBrowserService');
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, PageEntry>();
  private activePageId: string | null = null;
  /** 启动探测结果缓存 */
  private launchChannel: string | null = null;

  private readonly sessions = new Map<string, BuiltInBrowserService>();
  private manual = false;
  private busy = false;
  private launchPromise: Promise<Browser> | null = null;
  private readonly downloads = new Map<
    string,
    { download: Download; name: string; status: string; error?: string }
  >();
  forSession(id?: string): BuiltInBrowserService {
    if (!id) return this;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id))
      throw new Error('无效的浏览器会话');
    let child = this.sessions.get(id);
    if (!child) {
      if (this.sessions.size >= 12) {
        const empty = [...this.sessions].find(([, v]) => !v.status().running && !v.busy);
        if (empty) this.sessions.delete(empty[0]);
        else throw new Error('同时打开的浏览器会话达到 12 个，请关闭不用的会话');
      }
      child = new BuiltInBrowserService(this.security);
      child.native = this.native;
      child.nativeSession = id;
      this.sessions.set(id, child);
    }
    return child;
  }
  setControl(manual: boolean) {
    if (typeof manual !== 'boolean') throw new Error('需要 manual 布尔值');
    this.manual = manual;
    if (manual && this.actor === 'agent') this.native.cancel(this.nativeSession);
    return this.status();
  }
  stopAgentOperations(): void {
    this.epoch++;
    if (this.actor === 'agent') this.native.cancel(this.nativeSession);
    this.nativeObservations.clear();
    for (const page of this.pages.values()) page.observations?.clear();
    for (const child of this.sessions.values()) child.stopAgentOperations();
  }
  private checkOperation(): void {
    if (this.actor === 'agent' && (this.manual || this.operationSignal?.aborted || this.epoch !== this.operationEpoch))
      throw new Error('Browser operation cancelled; observe before continuing. Do not replay input.');
  }
  async runOperation<T>(
    actor: 'agent' | 'user',
    operation: () => Promise<T>,
    controlling = true,
    options: { screenshot?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    if (actor === 'agent' && this.manual)
      throw new Error('用户已接管浏览器。请等待用户交还 AI，不要继续操作。');
    if (this.busy) throw new Error('浏览器当前操作尚未结束，请稍后重试');
    this.busy = true;
    this.actor = actor;
    this.controlling = controlling;
    this.captureScreenshots = options.screenshot !== false;
    this.operationSignal = options.signal;
    this.operationEpoch = this.epoch;
    const abort = () => this.native.cancel(this.nativeSession);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      this.checkOperation();
      return await operation();
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.operationSignal = undefined;
      this.captureScreenshots = true;
      this.busy = false;
      this.actor = null;
      this.controlling = false;
    }
  }
  async newTab(url: string) {
    if (this.native.enabled) return this.navigate(url, randomUUID());
    if (this.pages.size >= 12) throw new Error('标签页达到上限');
    return this.navigate(url, randomUUID());
  }
  async activate(pageId: string) {
    if (this.native.enabled) {
      await this.native.request(this.nativeSession, 'activate', { pageId });
      return this.snapshot(pageId);
    }
    const entry = this.activeEntry(pageId);
    this.activePageId = entry.id;
    return this.snapshot(entry.id);
  }
  async upload(pageId: string, index: number, name: string, mimeType: string, base64: string) {
    this.checkOperation();
    if (
      typeof base64 !== 'string' ||
      base64.length > 1_400_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    )
      throw new Error('上传文件需小于 1MB');
    if (this.native.enabled) {
      await this.native.request(this.nativeSession, 'upload', {
        pageId,
        index,
        name: basename(name),
        mimeType,
        base64,
        requireActive: this.actor === 'agent',
      });
      try { return await this.snapshot(pageId); }
      catch (error) { throw new BrowserObservationError(pageId, 'upload', error); }
    }
    const entry = this.activeEntry(pageId),
      target = await this.resolveTarget(entry.page, index);
    if (target.kind !== 'locator') throw new Error('请选择文件上传控件的编号');
    await target.loc.setInputFiles({
      name: basename(name).slice(0, 180) || 'upload.bin',
      mimeType: mimeType || 'application/octet-stream',
      buffer: Buffer.from(base64, 'base64'),
    });
    try { return await this.snapshot(pageId); }
    catch (error) { throw new BrowserObservationError(pageId, 'upload', error); }
  }
  async download(id: string) {
    if (this.native.enabled)
      return this.native.request<{ path: string; name: string }>(this.nativeSession, 'download', {
        id,
      });
    const item = this.downloads.get(id);
    if (!item || item.status !== 'ready') throw new Error('文件尚未下载完成或已清理');
    const path = await item.download.path();
    if (!path) throw new Error('下载文件不可用');
    return { path, name: item.name };
  }
  async saveDownload(id: string, target: string) {
    if (typeof target !== 'string' || !target) throw new Error('需要保存路径');
    const destination = resolve(target);
    if (!this.security?.isPathAllowed(destination, 'write'))
      throw new Error('下载保存路径未授权，请选择项目文件夹');
    const source = await this.download(id);
    await copyFile(source.path, destination, constants.COPYFILE_EXCL);
    return { path: destination, name: source.name };
  }
  /** 启动状态（供 status 端点与工具描述） */
  status() {
    if (this.native.enabled) {
      const state = this.native.state(this.nativeSession) || {};
      return {
        running: !!state.tabs?.length,
        pages: state.tabs?.length || 0,
        activePageId: state.activePageId || null,
        engine: 'native-webview',
        manual: this.manual,
        busy: this.busy,
        agentBusy: this.actor === 'agent' && this.controlling && !this.manual,
        tabs: state.tabs || [],
        downloads: state.downloads || [],
      };
    }
    return {
      running: this.browser !== null,
      pages: this.pages.size,
      activePageId: this.activePageId,
      engine: this.launchChannel,
      manual: this.manual,
      busy: this.busy,
      agentBusy: this.actor === 'agent' && this.controlling && !this.manual,
      tabs: [...this.pages.values()].map((e) => ({ id: e.id, url: e.page.url() })),
      downloads: [...this.downloads].map(([id, d]) => ({
        id,
        name: d.name,
        status: d.status,
        error: d.error,
      })),
    };
  }

  /** 探测系统浏览器：Edge 优先（Windows 必装），Chrome 兜底 */
  private async ensureBrowser(): Promise<Browser> {
    if (process.env['WING_DESKTOP_SURFACES'] === '1' || process.env['SKYALYTICWING_DESKTOP'] === '1')
      throw new Error('桌面内置浏览器尚未连接，请等待 Wing 主窗口就绪；不会另开隐藏浏览器。');
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launchBrowser();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }
  private async launchBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const channels = ['msedge', 'chrome'];
    let lastErr: unknown = null;
    for (const channel of channels) {
      try {
        this.logger.log(`启动系统浏览器：channel=${channel}`);
        this.browser = await chromium.launch({
          channel,
          headless: true,
          args: [
            '--no-first-run',
            '--disable-features=Translate',
            '--mute-audio',
            '--window-size=1300,900',
          ],
        });
        this.launchChannel = channel;
        this.context = await this.browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          locale: 'zh-CN',
        });
        this.context.setDefaultTimeout(20_000);
        return this.browser;
      } catch (err) {
        lastErr = err;
        await this.browser?.close().catch(() => {});
        this.browser = null;
        this.cleanupContext();
      }
    }
    throw new Error(
      `未找到可用的系统浏览器（已尝试 Edge/Chrome）。请安装 Microsoft Edge 或 Google Chrome 后重试。${lastErr instanceof Error ? ` 原始错误：${lastErr.message}` : ''}`,
    );
  }

  private cleanupContext(): void {
    try {
      this.context?.close().catch(() => {});
    } catch {}
    this.context = null;
  }

  /** 注入标记引擎并挂 console 捕获 */
  private async preparePage(entry: PageEntry): Promise<void> {
    await entry.page.addInitScript(MARKER_SCRIPT);
    entry.page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    entry.page.on('popup', (page) => {
      if (this.pages.size >= 12) {
        void page.close();
        return;
      }
      const popup: PageEntry = {
        id: randomUUID().slice(0, 8),
        page,
        consoleBuf: [],
        closed: false,
      };
      this.pages.set(popup.id, popup);
      tagPageId(popup);
      this.activePageId = popup.id;
      void this.preparePage(popup)
        .then(() => page.evaluate(MARKER_SCRIPT))
        .catch(() => {});
    });
    entry.page.on('download', (download) => {
      if (this.downloads.size >= 50) {
        void download.cancel();
        return;
      }
      const id = randomUUID(),
        item: { download: Download; name: string; status: string; error?: string } = {
          download,
          name: download.suggestedFilename(),
          status: 'pending',
        };
      this.downloads.set(id, item);
      void download
        .failure()
        .then((error) => {
          item.status = error ? 'failed' : 'ready';
          if (error) item.error = error;
        })
        .catch(() => {
          item.status = 'failed';
        });
    });
    entry.page.on('console', (msg) => {
      entry.consoleBuf.push(`[console.${msg.type()}] ${msg.text()}`.slice(0, 300));
      this.trimConsole(entry);
    });
    entry.page.on('pageerror', (err) => {
      entry.consoleBuf.push(`[pageerror] ${err.message}`.slice(0, 300));
      this.trimConsole(entry);
    });
    entry.page.on('requestfailed', (req) => {
      entry.consoleBuf.push(
        `[requestfailed] ${req.url().slice(0, 160)} ${req.failure()?.errorText ?? ''}`.slice(
          0,
          300,
        ),
      );
      this.trimConsole(entry);
    });
    entry.page.on('close', () => {
      entry.closed = true;
      this.pages.delete(entry.id);
      if (this.activePageId === entry.id)
        this.activePageId = this.pages.keys().next().value ?? null;
    });
  }

  private trimConsole(entry: PageEntry): void {
    if (entry.consoleBuf.length > CONSOLE_BUF)
      entry.consoleBuf.splice(0, entry.consoleBuf.length - CONSOLE_BUF);
  }

  private activeEntry(pageId?: string): PageEntry {
    const id = pageId || this.activePageId;
    const entry = id ? this.pages.get(id) : undefined;
    if (!entry || entry.closed) throw new Error('浏览器页面未打开或已关闭，请先 navigate 打开页面');
    return entry;
  }

  /** 打开/导航到 URL（首次调用自动拉起浏览器） */
  async navigate(url: string, pageId?: string): Promise<BrowserSnapshot> {
    const target = this.normalizeUrl(url);
    if (
      target.startsWith('file:') &&
      !this.security?.isPathAllowed(fileURLToPath(target), 'read')
    ) {
      throw new Error('浏览器文件路径未授权，请先选择项目文件夹');
    }
    if (this.native.enabled) {
      const result = await this.native.request<{ pageId: string }>(this.nativeSession, 'navigate', {
        url: target,
        pageId,
      });
      return this.snapshot(result.pageId);
    }
    await this.ensureBrowser();
    let entry = pageId
      ? this.pages.get(pageId)
      : this.activePageId
        ? this.pages.get(this.activePageId)
        : undefined;
    if (!entry || entry.closed) {
      if (!this.context) throw new Error('浏览器上下文未初始化');
      const page = await this.context.newPage();
      entry = { id: randomUUID().slice(0, 8), page, consoleBuf: [], closed: false };
      await this.preparePage(entry);
      tagPageId(entry);
      this.pages.set(entry.id, entry);
      this.activePageId = entry.id;
    }
    this.activePageId = entry.id;
    await entry.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.snapshot(entry.id);
  }

  private normalizeUrl(input: string): string {
    return browserAddress(input);
  }

  /** 当前页面快照：截图（含标记）+ 元素清单 + console 尾部 */
  async snapshot(pageId?: string, screenshot = this.captureScreenshots, waitForLoad = true, timeoutMs?: number): Promise<BrowserSnapshot> {
    this.checkOperation();
    if (this.native.enabled) {
      const data = await this.native.request<BrowserSnapshot & { documentId: string }>(
        this.nativeSession,
        'snapshot',
        { pageId, screenshot, waitForLoad },
        timeoutMs ?? (waitForLoad ? 24000 : 3000),
      );
      const observationId = randomUUID();
      const signature = createHash('sha256')
        .update(
          JSON.stringify({ documentId: data.documentId, url: data.url, elements: data.elements }),
        )
        .digest('hex');
      this.nativeObservations.set(observationId, {
        signature,
        at: Date.now(),
        pageId: data.pageId,
        snapshot: data,
      });
      while (this.nativeObservations.size > 24)
        this.nativeObservations.delete(this.nativeObservations.keys().next().value!);
      return { ...data, observationId, markedAt: Date.now() };
    }
    const entry = this.activeEntry(pageId);
    const markedAt = Date.now();
    // 重标一次确保坐标最新（滚动/动画后）
    await entry.page
      .evaluate(() => {
        const m = (window as unknown as { __skyBrowserMarker?: { refresh: () => void } })
          .__skyBrowserMarker;
        m?.refresh();
      })
      .catch(() => {});
    const elements = await entry.page
      .evaluate((): BrowserElementInfo[] => {
        const m = (
          window as unknown as {
            __skyBrowserMarker?: {
              items: Array<{
                i: number;
                el: Element;
                rect: {
                  x: number;
                  y: number;
                  w: number;
                  h: number;
                  raw: { x: number; y: number; w: number; h: number };
                };
              }>;
            };
          }
        ).__skyBrowserMarker;
        if (!m) return [];
        return m.items.map((it) => {
          const el = it.el as HTMLElement;
          const text =
            el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
              ? (el as HTMLInputElement).type === 'password'
                ? '[password]'
                : String((el as HTMLInputElement).value || '')
              : (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return {
            index: it.i,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            text: text.slice(0, 120) || undefined,
            hint:
              el.getAttribute('placeholder') ||
              el.getAttribute('aria-label') ||
              el.getAttribute('name') ||
              el.getAttribute('title') ||
              el.getAttribute('alt') ||
              undefined,
            href: el.tagName === 'A' ? el.getAttribute('href') || undefined : undefined,
            rect: { x: it.rect.raw.x, y: it.rect.raw.y, w: it.rect.raw.w, h: it.rect.raw.h },
            input:
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
              el.getAttribute('contenteditable') != null,
            disabled: (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
            readonly: (el as HTMLInputElement).readOnly === true,
            checked: (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true',
          };
        });
      })
      .catch(() => []);
    // Result notices, headings and table cells are often not interactive. They are
    // essential evidence, especially for text-only models validating an action.
    const pageText = await entry.page.evaluate(() => (document.body?.innerText || '').slice(0, 16000));
    const image = screenshot ? await entry.page.screenshot({ type: 'jpeg', quality: 85, fullPage: false }) : undefined;
    const focus = await entry.page.evaluate(() => {
      const m = (window as any).__skyBrowserMarker;
      return { index: m?.items.find((it: any) => it.el === document.activeElement)?.i, readyState: document.readyState };
    });
    const documentId = await entry.page.evaluate(
      () =>
        (window as unknown as { __skyBrowserMarker?: { documentId: string } }).__skyBrowserMarker
          ?.documentId || '',
    );
    const observationId = randomUUID();
    const signature = createHash('sha256')
      .update(JSON.stringify({ documentId, url: entry.page.url(), elements }))
      .digest('hex');
    const observations = (entry.observations ||= new Map());
    const result: BrowserSnapshot = {
      documentId,
      readyState: focus.readyState,
      activeElement: elements.find(e => e.index === focus.index) || null,
      observationId,
      pageId: entry.id,
      url: entry.page.url(),
      title: await entry.page.title().catch(() => ''),
      viewport: VIEWPORT,
      screenshot: image?.toString('base64') || '',
      pageText,
      elements,
      elementsTruncated: elements.length >= MAX_ELEMENTS,
      consoleTail: entry.consoleBuf.slice(-CONSOLE_TAIL),
      markedAt,
    };
    observations.set(observationId, { signature, at: markedAt, snapshot: result });
    while (observations.size > 24) observations.delete(observations.keys().next().value!);
    return result;
  }

  /** Agent input must refer to a recent observation from this page and document. */
  async assertObservation(pageId?: string, observationId?: string, target?: BrowserTarget): Promise<void> {
    this.checkOperation();
    if (!pageId || !observationId)
      throw new Error('Agent input requires pageId and observationId from the latest snapshot.');
    if (this.native.enabled) {
      const observed = this.nativeObservations.get(observationId);
      if (target?.action !== 'element') this.nativeObservations.delete(observationId);
      if (!observed || observed.pageId !== pageId || Date.now() - observed.at > 60000)
        throw new Error('Browser observation expired or consumed. Take a new snapshot.');
      const current = await this.snapshot(pageId, false, false);
      this.nativeObservations.delete(current.observationId!);
      if (!sameBrowserTarget(observed.snapshot, current, target))
        throw new Error(
          'The page changed since the observation. Take a new snapshot and reassess before acting.',
        );
      return;
    }
    const entry = this.activeEntry(pageId);
    const observed = entry.observations?.get(observationId);
    if (target?.action !== 'element') entry.observations?.delete(observationId); // Input is single use, including failures.
    if (!observed || Date.now() - observed.at > 60_000)
      throw new Error('Browser observation expired or consumed. Take a new snapshot.');
    const current = await this.snapshot(pageId, false, false);
    entry.observations?.delete(current.observationId!);
    if (!sameBrowserTarget(observed.snapshot, current, target))
      throw new Error(
        'The page changed since the observation. Take a new snapshot and reassess before acting.',
      );
  }

  async waitFor(pageId: string | undefined, wait: BrowserWait): Promise<{ snapshot: BrowserSnapshot; matched: boolean; timedOut: boolean }> {
    const deadline = Date.now() + validateBrowserWait(wait);
    const baseline = wait.condition === 'element' && pageId && wait.observationId
      ? this.native.enabled ? this.nativeObservations.get(wait.observationId) : this.activeEntry(pageId).observations?.get(wait.observationId)
      : undefined;
    if (wait.condition === 'element' && (!baseline || baseline.snapshot.pageId !== pageId || Date.now() - baseline.at > 60000 || !baseline.snapshot.elements.some(e => e.index === wait.index)))
      throw new Error('Element waits require pageId, observationId and index from a recent snapshot.');
    const initial = await this.snapshot(pageId, false, false);
    if (baseline && initial.documentId !== baseline.snapshot.documentId) throw new Error('Page navigated before element wait. Take a fresh snapshot.');
    let current = initial;
    for (;;) {
      this.checkOperation();
      // An old index must not be reinterpreted on a new document.
      if (wait.condition === 'element' && current.documentId !== initial.documentId)
        throw new Error('Page navigated while waiting for an element. Take a fresh snapshot.');
      const matched = browserConditionMatches(current, wait);
      if (matched || Date.now() >= deadline) return { snapshot: this.captureScreenshots ? await this.snapshot(current.pageId, true, false) : current, matched, timedOut: !matched };
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      this.checkOperation();
      current = await this.snapshot(current.pageId, false, false, Math.max(1, deadline - Date.now()));
    }
  }

  /** 坐标点选：返回命中元素详情（前端"选取元素→添加到对话"） */
  async elementAt(pageId: string, x: number, y: number): Promise<BrowserElementDetail | null> {
    if (this.native.enabled)
      return this.native.request(this.nativeSession, 'element', { pageId, x, y });
    const entry = this.activeEntry(pageId);
    return entry.page.evaluate(
      ([px, py]) => {
        const m = (
          window as unknown as {
            __skyBrowserMarker?: { elementAt: (x: number, y: number) => unknown };
          }
        ).__skyBrowserMarker;
        return m ? (m.elementAt(px, py) as Record<string, unknown> | null) : null;
      },
      [x, y] as const,
    ) as unknown as Promise<BrowserElementDetail | null>;
  }

  /** 按索引取元素详情（AI 读取元素用） */
  async elementByIndex(pageId: string, index: number): Promise<BrowserElementDetail | null> {
    if (this.native.enabled)
      return this.native.request(this.nativeSession, 'element', { pageId, index });
    const entry = this.activeEntry(pageId);
    return entry.page.evaluate((idx) => {
      const m = (
        window as unknown as {
          __skyBrowserMarker?: {
            items: Array<{
              i: number;
              el: Element;
              rect: { raw: { x: number; y: number; w: number; h: number } };
            }>;
            refresh: () => void;
          };
        }
      ).__skyBrowserMarker;
      if (!m) return null;
      m.refresh();
      const it = m.items.find((t) => t.i === idx);
      if (!it) return null;
      const el = it.el as HTMLElement;
      const text =
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
          ? (el as HTMLInputElement).type === 'password'
            ? '[password]'
            : String((el as HTMLInputElement).value || '')
          : (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const hint =
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('name') ||
        el.getAttribute('title') ||
        '';
      function cssPath(node: Element): string {
        if (node.id) return '#' + node.id.replace(/([^\w-])/g, '\\$1');
        const parts: string[] = [];
        let cur: Element | null = node;
        let depth = 0;
        while (cur && cur !== document.documentElement && depth < 6) {
          let sel = cur.tagName.toLowerCase();
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const tagName = cur.tagName;
            const same = Array.from(parent.children).filter((c) => c.tagName === tagName);
            if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          parts.unshift(sel);
          cur = parent;
          depth += 1;
        }
        return parts.join(' > ').slice(0, 300);
      }
      return {
        index: it.i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: text.slice(0, 120) || undefined,
        hint: hint || undefined,
        href: el.tagName === 'A' ? el.getAttribute('href') || undefined : undefined,
        selector: cssPath(el),
        outerHTML:
          (el as HTMLInputElement).type === 'password'
            ? '<input type="password">'
            : (el.outerHTML || '').slice(0, 2000),
        rect: { x: it.rect.raw.x, y: it.rect.raw.y, w: it.rect.raw.w, h: it.rect.raw.h },
      } as unknown;
    }, index) as Promise<BrowserElementDetail | null>;
  }

  /** 统一动作入口：click / fill / select / key / scroll / hover，执行后返回最新快照 */
  async action(
    pageId: string,
    action: string,
    args: {
      index?: number;
      text?: string;
      value?: string;
      key?: string;
      x?: number;
      y?: number;
      dx?: number;
      dy?: number;
    },
  ): Promise<BrowserActionResult> {
    this.checkOperation();
    if (this.native.enabled) {
      const outcome = await this.native.request<{ pageId?: string } | undefined>(this.nativeSession, action, { ...args, pageId, requireActive: this.actor === 'agent' });
      const targetPageId = typeof outcome?.pageId === 'string' ? outcome.pageId : pageId;
      try { return { ...(await this.snapshot(targetPageId)), ok: true, action }; }
      catch (error) { throw new BrowserObservationError(targetPageId, action, error); }
    }
    const entry = this.activeEntry(pageId);
    const page = entry.page;
    let detail = '';
    switch (action) {
      case 'click': {
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          await page.mouse.click(args.x, args.y);
          detail = `坐标点击 (${args.x},${args.y})`;
        } else {
          const t = await this.resolveTarget(page, args.index);
          if (t.kind === 'locator') {
            await t.loc.scrollIntoViewIfNeeded().catch(() => {});
            await t.loc.click({ timeout: 10_000 });
          } else {
            await page.mouse.click(t.x, t.y);
          }
          detail = `点击元素 #${args.index}`;
        }
        break;
      }
      case 'fill': {
        const value = args.text ?? args.value ?? '';
        const t = await this.resolveTarget(page, args.index);
        if (t.kind === 'locator') {
          const loc = t.loc;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          // 兼容 React 受控组件：先清空再逐键输入（真实键盘事件）
          await loc.fill('', { timeout: 10_000 }).catch(async () => {
            await loc.click({ timeout: 5_000 });
          });
        } else {
          // 坐标退路：点击聚焦后逐键输入
          await page.mouse.click(t.x, t.y);
        }
        await page.keyboard.type(value, { delay: 12 });
        detail = `向元素 #${args.index} 输入 ${value.length} 字符`;
        break;
      }
      case 'select': {
        const t = await this.resolveTarget(page, args.index);
        if (t.kind !== 'locator')
          throw new Error('该元素无法通过选择器定位，请改用 click 点击选项');
        if (args.value === undefined && args.text === undefined)
          throw new Error('select 需要 value 或 text 参数');
        await t.loc.selectOption(
          args.value !== undefined ? { value: args.value } : { label: args.text! },
          { timeout: 5_000 },
        );
        detail = `下拉选择 #${args.index} = ${args.value ?? args.text ?? ''}`;
        break;
      }
      case 'key': {
        await page.keyboard.press(args.key || 'Enter');
        detail = `按键 ${args.key || 'Enter'}`;
        break;
      }
      case 'type': {
        if (typeof args.text !== 'string') throw new Error('type 需要 text 参数');
        await page.keyboard.insertText(args.text);
        detail = `向当前焦点输入 ${args.text.length} 字符`;
        break;
      }
      case 'scroll': {
        await page.mouse.move(args.x ?? VIEWPORT.width / 2, args.y ?? VIEWPORT.height / 2);
        await page.mouse.wheel(args.dx ?? 0, args.dy ?? 600);
        detail = `滚动 dy=${args.dy ?? 600}`;
        break;
      }
      case 'hover': {
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          await page.mouse.move(args.x, args.y);
          detail = `悬停 (${args.x},${args.y})`;
        } else {
          const t = await this.resolveTarget(page, args.index);
          if (t.kind === 'locator') {
            await t.loc.hover({ timeout: 10_000 });
          } else {
            await page.mouse.move(t.x, t.y);
          }
          detail = `悬停元素 #${args.index}`;
        }
        break;
      }
      default:
        throw new Error(`不支持的操作：${action}（可用：click/fill/select/key/scroll/hover）`);
    }
    // 等待可能的导航/渲染
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      const snap = await this.snapshot(this.activePageId || entry.id);
      return { ...snap, ok: true, action, detail };
    } catch (error) { throw new BrowserObservationError(entry.id, action, error); }
  }

  /** index → 操作目标：优先标记引擎的稳定选择器定位器，退化为标记矩形中心坐标点 */
  private async resolveTarget(
    page: Page,
    index?: number,
  ): Promise<{ kind: 'locator'; loc: Locator } | { kind: 'point'; x: number; y: number }> {
    if (typeof index !== 'number') throw new Error('缺少元素索引 index');
    const info = await this.elementByIndex(pageIdOf(page), index).catch(() => null);
    if (info?.selector) {
      try {
        const loc = page.locator(info.selector);
        if ((await loc.count()) === 1) return { kind: 'locator', loc };
      } catch {}
    }
    // A missing/ambiguous DOM target must not silently turn into a coordinate click.
    throw new Error(`元素 #${index} 不存在或已消失（页面可能已变化，请重新获取快照）`);
  }

  /** 导航历史 */
  async history(pageId: string, dir: 'back' | 'forward'): Promise<BrowserSnapshot> {
    if (this.native.enabled) {
      await this.native.request(this.nativeSession, dir, { pageId });
      return this.snapshot(pageId);
    }
    const entry = this.activeEntry(pageId);
    if (dir === 'back') await entry.page.goBack({ timeout: 15_000 }).catch(() => {});
    else await entry.page.goForward({ timeout: 15_000 }).catch(() => {});
    await entry.page.waitForTimeout(300);
    return this.snapshot(entry.id);
  }

  /** 刷新 */
  async reload(pageId?: string): Promise<BrowserSnapshot> {
    if (this.native.enabled) {
      await this.native.request(this.nativeSession, 'reload', { pageId });
      return this.snapshot(pageId);
    }
    const entry = this.activeEntry(pageId);
    await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await entry.page.waitForTimeout(350);
    return this.snapshot(entry.id);
  }

  /** 关闭页面 */
  async closePage(pageId?: string): Promise<{ closed: boolean }> {
    if (this.native.enabled) return this.native.request(this.nativeSession, 'close', { pageId });
    const entry = this.activeEntry(pageId);
    entry.closed = true;
    this.pages.delete(entry.id);
    await entry.page.close().catch(() => {});
    if (this.activePageId === entry.id) this.activePageId = this.pages.keys().next().value ?? null;
    return { closed: true };
  }

  /** 关闭浏览器并清理临时用户目录 */
  async closeAll(): Promise<{ closed: boolean }> {
    if (this.native.enabled) {
      this.nativeObservations.clear();
      return this.native.request(this.nativeSession, 'close', { all: true });
    }
    for (const entry of this.pages.values()) {
      entry.closed = true;
      await entry.page.close().catch(() => {});
    }
    this.pages.clear();
    this.downloads.clear();
    this.activePageId = null;
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.cleanupContext();
    this.launchChannel = null;
    this.logger.log('内置浏览器已关闭');
    return { closed: true };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.native.enabled) {
      this.native.cancel(this.nativeSession);
      this.nativeObservations.clear();
    }
    for (const child of this.sessions.values()) await child.onModuleDestroy();
    this.sessions.clear();
    if (this.native.enabled) return; // Native views are owned and closed by the desktop process.
    await this.closeAll();
  }
}

/** 由 page 反查 entryId：resolveTarget 内部需调 elementByIndex，用 WeakMap 建立映射 */
const pageIdMap = new WeakMap<Page, string>();
function tagPageId(entry: PageEntry): void {
  pageIdMap.set(entry.page, entry.id);
}
function pageIdOf(page: Page): string {
  return pageIdMap.get(page) ?? '';
}
