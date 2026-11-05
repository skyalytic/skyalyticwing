import { desktopObservationImage } from './desktop-observation-image.js';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ToolResult } from '@skyalyticwing/shared';
import { visualPointToScreen, type VisualDesktopInput } from './visual-desktop-driver.js';

export type VisualRoot = { rootRef: string; windowId: number; pid: number; title: string; processName?: string; visible?: boolean; minimized?: boolean; ownerWindowId?: number; isForeground?: boolean; foregroundWindowId?: number; bounds: { x: number; y: number; width: number; height: number } };
export type VisualRequest = {
  action: string; rootRef?: string; windowRef?: string; windowId?: number; pid?: number;
  lookId?: string; screenshotId?: string; kind?: string; targetRef?: string;
  targetX?: number; targetY?: number; params?: Record<string, unknown>; timeoutMs?: number;
  text?: string; role?: string; value?: string; expectedText?: string; maxDimension?: number;
  region?: { x: number; y: number; width: number; height: number };
  condition?: 'changed' | 'stable';
  steps?: Array<{ kind: string; targetX?: number; targetY?: number; params?: Record<string, unknown> }>;
};
export interface VisualDriver {
  available(): boolean;
  getInputMode?(): 'physical';
  listWindows(): Promise<VisualRoot[]>;
  focus(root: VisualRoot): Promise<unknown>;
  capture(root: VisualRoot): Promise<{ base64: string; width: number; height: number; originX: number; originY: number; bounds: VisualRoot['bounds']; foregroundWindowId?: number; regions?: Record<string, VisualRoot['bounds']>; cursor?: { x: number; y: number; visible: boolean } }>;
  input(root: VisualRoot, request: VisualDesktopInput): Promise<unknown>;
}
type Observation = { sessionId: string; id: string; root: VisualRoot; frameHash: string; pixels: Buffer; at: number; width: number; height: number; originalWidth: number; originalHeight: number; originX: number; originY: number };
type Hooks = { check: () => void; update: (state: Record<string, unknown>) => void };
const POINTER = new Set(['click', 'moveMouse', 'drag', 'scroll']);
const INPUT = new Set([...POINTER, 'typeText', 'keypress']);

export class DesktopInputObservationError extends Error {
  readonly data = { desktopWorkflow: true, actionPerformed: true, observationComplete: false,
    inputReceipt: { outcome: 'delivered', replay: false },
    recovery: 'Input was delivered. Observe the current window and any modal/popup before further input; do not replay.' };
}

/** Ignore isolated cursor/clock pixels; this measures visual change, not task success. */
export function visualPixelsChanged(before: Buffer, after: Buffer): boolean {
  if (before.length !== after.length) return true;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (Math.abs(before[i]! - after[i]!) > 20) changed++;
  return changed > before.length * 0.002;
}

/** The model uses pixels of the image it actually sees. Never ask it to calculate DPI. */
export function imagePointToScreen(o: Pick<Observation, 'width' | 'height' | 'originalWidth' | 'originalHeight' | 'originX' | 'originY'>, x: unknown, y: unknown): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('目标坐标必须位于刚返回的截图内，请根据截图重新定位。');
  return visualPointToScreen({ x, y }, o);
}

/** Visual observations do not depend on a UIA tree or its fingerprint. */
export class VisualDesktopWorkflow {
  private latest: Observation | undefined;
  private unchangedClick: { signature: string; count: number } | undefined;
  private inventories = new Map<string, VisualRoot[]>();
  constructor(private readonly driver: VisualDriver) {}
  invalidate() { this.latest = undefined; this.unchangedClick = undefined; this.inventories.clear(); }
  requiresObservation() { return !this.latest || Date.now() - this.latest.at > 60_000; }
  private async list(sessionId: string, hooks: Hooks) {
    const roots = await this.driver.listWindows(); hooks.check();
    if (this.inventories.size > 64) this.inventories.clear();
    this.inventories.set(sessionId, roots);
    return roots;
  }
  private async activeDisplay(sessionId: string, hooks: Hooks): Promise<VisualRoot | undefined> {
    const roots = await this.list(sessionId, hooks);
    return roots.find(root => root.rootRef.startsWith('desktop:') && root.isForeground)
      || roots.find(root => root.rootRef === 'desktop:0');
  }
  private appViewport(sessionId: string, display: VisualRoot): VisualRoot['bounds'] | undefined {
    const roots = this.inventories.get(sessionId) || [];
    const app = roots.find(r => r.windowId > 0 && r.isForeground && r.visible !== false && !r.minimized && r.bounds.width >= 200 && r.bounds.height >= 150 && !/^(explorer|gnome-shell|plasmashell|Window Server)$/i.test(r.processName || ''));
    if (!app) return undefined;
    const windows = roots.filter(r => r.visible !== false && !r.minimized && r.bounds.width > 1 && r.bounds.height > 1 && (r.windowId === app.windowId || r.ownerWindowId === app.windowId));
    const left = Math.max(display.bounds.x, Math.min(...windows.map(r => r.bounds.x)));
    const top = Math.max(display.bounds.y, Math.min(...windows.map(r => r.bounds.y)));
    const right = Math.min(display.bounds.x + display.bounds.width, Math.max(...windows.map(r => r.bounds.x + r.bounds.width)));
    const bottom = Math.min(display.bounds.y + display.bounds.height, Math.max(...windows.map(r => r.bounds.y + r.bounds.height)));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
  }
  private select(sessionId: string, a: VisualRequest): VisualRoot {
    const roots = this.inventories.get(sessionId) || [];
    const ref = a.rootRef || a.windowRef;
    const matches = roots.filter(r => (!ref || r.rootRef === ref) && (a.windowId === undefined || r.windowId === a.windowId) && (a.pid === undefined || a.pid === r.pid));
    if ((!ref && a.windowId === undefined) || matches.length !== 1) throw new Error('请先 list_windows，并从返回结果选择唯一窗口 rootRef 或 windowId。');
    return matches[0]!;
  }
  private async live(sessionId: string, root: VisualRoot, hooks: Hooks): Promise<VisualRoot> {
    const roots = await this.list(sessionId, hooks);
    const live = roots.find(r => r.windowId === root.windowId && r.pid === root.pid);
    if (!live) throw new Error('目标窗口已关闭或被替换，请重新 list_windows 选择窗口。');
    return live;
  }
  private async observe(sessionId: string, root: VisualRoot, hooks: Hooks, extra: Record<string, unknown> = {}, region?: VisualRoot['bounds'], magnify = false): Promise<ToolResult> {
    hooks.update({ phase: 'observing', target: root, mode: 'visual' });
    const shot = await this.driver.capture(root); hooks.check();
    // Coordinates and target geometry must come from the same native capture.
    root = { ...root, bounds: { ...shot.bounds }, ...(shot.foregroundWindowId === undefined ? {} : { foregroundWindowId: shot.foregroundWindowId }) };
    let source = sharp(Buffer.from(shot.base64.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'), { limitInputPixels: 100_000_000 });
    let view = { x: shot.originX, y: shot.originY, width: shot.width, height: shot.height };
    if (region) {
      if (region.x < view.x || region.y < view.y || region.x + region.width > view.x + view.width || region.y + region.height > view.y + view.height) throw new Error('截图区域已变化，请重新截图。');
      const metadata = await source.metadata();
      const sx = metadata.width! / shot.width, sy = metadata.height! / shot.height;
      const left = Math.round((region.x - shot.originX) * sx), top = Math.round((region.y - shot.originY) * sy);
      source = source.extract({ left, top, width: Math.min(metadata.width! - left, Math.max(1, Math.round(region.width * sx))), height: Math.min(metadata.height! - top, Math.max(1, Math.round(region.height * sy))) });
      view = region;
    }
    const rendered = await desktopObservationImage(source
      .resize({ width: magnify ? Math.min(1280, Math.round(view.width * 3)) : root.rootRef.startsWith('desktop:') ? 1280 : 1600, height: magnify ? Math.min(1280, Math.round(view.height * 3)) : root.rootRef.startsWith('desktop:') ? 1280 : 1600, fit: 'inside', withoutEnlargement: !magnify }));
    hooks.check();
    const pixels = await sharp(rendered.data).resize(96, 96, { fit: 'fill' }).greyscale().raw().toBuffer();
    const o: Observation = { id: randomUUID(), sessionId, root, frameHash: createHash('sha256').update(rendered.data).digest('hex'), pixels, at: Date.now(), width: rendered.info.width, height: rendered.info.height, originalWidth: view.width, originalHeight: view.height, originX: view.x, originY: view.y };
    this.latest = o;
    const cursor = shot.cursor ? { x: (shot.cursor.x - o.originX) * o.width / o.originalWidth, y: (shot.cursor.y - o.originY) * o.height / o.originalHeight, visible: shot.cursor.visible } : undefined;
    const regions = Object.fromEntries(Object.entries(shot.regions || {}).filter(([,r]) => r.x >= view.x && r.y >= view.y && r.x + r.width <= view.x + view.width && r.y + r.height <= view.y + view.height).map(([name,r]) => [name, { x: (r.x-view.x)*o.width/view.width, y: (r.y-view.y)*o.height/view.height, width: r.width*o.width/view.width, height: r.height*o.height/view.height }]));
    const data = { desktopWorkflow: true, mode: 'visual', inputMode: this.driver.getInputMode?.() || 'physical', lookId: o.id, screenshotId: o.id, target: root,
      image: { width: o.width, height: o.height }, viewport: view, regions, cursor, foregroundWindow: this.inventories.get(sessionId)?.find(r => r.windowId === root.foregroundWindowId),
      coordinateSpace: 'image pixels: (0,0) is the top-left of this returned image. Pass these exact pixels; the tool handles window origin, resizing and DPI.',
      next: 'Inspect this image, then act with this screenshotId. Use targetX/targetY for the pointer, params.text for typeText, params.key for keypress. Continue from each returned screenshot, without another look unless needed. Verify recipient before sending and the sent bubble afterwards. Use screenshot without a root for the active display; list_windows exposes desktop:1 etc for other displays. A post-action image may be cropped to the active app for precision; all coordinates still refer only to this returned image. Use screenshot without a root for the full active display or screenshot rootRef=desktop:0 for the primary taskbar/tray.', ...extra };
    hooks.update({ phase: 'ready', target: root, verification: extra['verification'] || 'needs_review' });
    return { success: true, output: JSON.stringify(data), data: { ...data, visualObservation: { kind: 'desktop', mimeType: rendered.mimeType, detail: 'high', base64: rendered.data.toString('base64'), width: o.width, height: o.height, coordinateSpace: 'image', screenshotId: o.id, capturedAt: o.at } } };
  }
  private annotate(result: ToolResult, extra: Record<string, unknown>, error?: string): ToolResult {
    const data = { ...(result.data as Record<string, unknown> || {}), ...extra };
    const { visualObservation: _image, ...text } = data;
    return { ...result, ...(error ? { success: false, error } : {}), data, output: JSON.stringify(text) };
  }
  private async delay(ms: number, hooks: Hooks) {
    const end = Date.now() + ms;
    while (Date.now() < end) { hooks.check(); await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now()))); }
    hooks.check();
  }
  private async batch(sessionId: string, a: VisualRequest, hooks: Hooks): Promise<ToolResult> {
    const initial = this.latest;
    if (!initial || initial.sessionId !== sessionId || (a.screenshotId || a.lookId) !== initial.id) throw new Error('连续动作需要当前会话最新 screenshotId。');
    if (!Array.isArray(a.steps) || !a.steps.length) throw new Error('steps 必须包含按顺序执行的动作。');
    // Validate the whole plan before sending its first input. Coordinates belong to the initial image.
    const steps = a.steps.map(step => {
      if (!step || !INPUT.has(step.kind)) throw new Error('不支持的连续动作。');
      const params = { ...step.params };
      if (step.kind === 'typeText' && (typeof params['text'] !== 'string' || !params['text'])) throw new Error('typeText 需要 params.text。');
      if (step.kind === 'keypress' && (typeof params['key'] !== 'string' || !params['key'])) throw new Error('keypress 需要 params.key。');
      const point = POINTER.has(step.kind) ? imagePointToScreen(initial, step.targetX, step.targetY) : undefined;
      const end = step.kind === 'drag' ? imagePointToScreen(initial, params['toX'], params['toY']) : undefined;
      return { kind: step.kind, params, point, end };
    });
    let completed = 0, result: ToolResult | undefined;
    const foreground = initial.root.foregroundWindowId;
    for (const step of steps) {
      hooks.check();
      const current = this.latest;
      if (!current || current.sessionId !== sessionId) throw new Error('连续动作已中断，需要重新观察。');
      if (completed && (current.root.rootRef !== initial.root.rootRef || JSON.stringify(current.root.bounds) !== JSON.stringify(initial.root.bounds) || current.root.foregroundWindowId !== foreground)) {
        return this.annotate(result!, { batch: { completed, total: steps.length, stoppedAt: completed, replay: false }, recovery: 'Window or foreground changed. Inspect the screenshot and plan remaining actions again.' }, '连续动作因窗口或焦点变化而停止，未执行剩余动作。');
      }
      const params = { ...step.params };
      const toImage = (p: { x: number; y: number }) => ({ x: (p.x - current.originX) * current.width / current.originalWidth, y: (p.y - current.originY) * current.height / current.originalHeight });
      const point = step.point && toImage(step.point), end = step.end && toImage(step.end);
      if (end) { params['toX'] = end.x; params['toY'] = end.y; }
      try {
        result = await this.execute(sessionId, { action: 'act', screenshotId: current.id, kind: step.kind, params, ...(point ? { targetX: point.x, targetY: point.y } : {}) }, hooks);
      } catch (error) {
        if (error instanceof DesktopInputObservationError) {
          // 已投递的动作计入 completed；截图失败不能导致整批输入被重新执行。
          return { success: false, error: error.message, data: { ...error.data,
            batch: { completed: completed + 1, total: steps.length, stoppedAt: completed, replay: false } } };
        }
        hooks.check();
        const refreshed = await this.observe(sessionId, await this.live(sessionId, current.root, hooks), hooks, { verification: 'needs_review' });
        return this.annotate(refreshed, { batch: { completed, total: steps.length, stoppedAt: completed, replay: false } }, error instanceof Error ? error.message : String(error));
      }
      if (!result.success || (result.data as Record<string, unknown>)?.['actionPerformed'] !== true) {
        return this.annotate(result, { batch: { completed, total: steps.length, stoppedAt: completed, replay: false } }, result.error || '连续动作已停止，请根据返回截图重新决定剩余动作。');
      }
      completed++;
    }
    return this.annotate(result!, { batch: { completed, total: steps.length, replay: false } });
  }
  private async waitForVisual(sessionId: string, a: VisualRequest, root: VisualRoot, timeout: number, hooks: Hooks): Promise<ToolResult> {
    if (a.condition !== 'changed' && a.condition !== 'stable') throw new Error('condition 必须为 changed 或 stable。');
    const original = this.latest;
    let region: VisualRoot['bounds'] | undefined;
    if (a.region) {
      const r = a.region;
      if (!original || original.sessionId !== sessionId || a.screenshotId !== original.id || original.root.rootRef !== root.rootRef || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x + r.width > original.width || r.y + r.height > original.height) throw new Error('等待区域需要最新 screenshotId 和图片范围内的 region。');
      region = { ...imagePointToScreen(original, r.x, r.y), width: Math.max(1, Math.floor(r.width * original.originalWidth / original.width)), height: Math.max(1, Math.floor(r.height * original.originalHeight / original.height)) };
    } else if (original?.sessionId === sessionId && original.root.rootRef === root.rootRef) {
      region = { x: original.originX, y: original.originY, width: original.originalWidth, height: original.originalHeight };
    }
    let result = await this.observe(sessionId, await this.live(sessionId, root, hooks), hooks, {}, region);
    let previous = this.latest!;
    // Compare to the last observation when the viewport is unchanged, so a completed transition is not missed.
    const sameView = original && original.sessionId === sessionId && original.root.rootRef === root.rootRef && original.originX === previous.originX && original.originY === previous.originY && original.originalWidth === previous.originalWidth && original.originalHeight === previous.originalHeight;
    const baseline = sameView ? original.pixels : previous.pixels;
    const deadline = Date.now() + timeout;
    let stableSamples = 0;
    for (;;) {
      hooks.check();
      const current = this.latest!;
      const matched = a.condition === 'changed' ? visualPixelsChanged(baseline, current.pixels) : stableSamples >= 2;
      if (matched || Date.now() >= deadline) return this.annotate(result, { condition: a.condition, conditionScope: 'pixels', matched, timedOut: !matched, requestedCondition: a.text || a.expectedText || null, verification: 'needs_review', next: 'Only visual change/stability was checked. Inspect the screenshot to decide whether the requested text or business result is present.' }, matched ? undefined : '等待画面条件超时，请检查新截图；未重放任何输入。');
      await this.delay(Math.min(250, Math.max(0, deadline - Date.now())), hooks);
      const live = await this.live(sessionId, root, hooks);
      if (JSON.stringify(live.bounds) !== JSON.stringify(root.bounds)) return this.observe(sessionId, live, hooks, { matched: false, verification: 'refreshed', next: 'Target moved while waiting. Inspect the fresh full image.' });
      result = await this.observe(sessionId, live, hooks, {}, region);
      stableSamples = visualPixelsChanged(previous.pixels, this.latest!.pixels) ? 0 : stableSamples + 1;
      previous = this.latest!;
    }
  }
  async execute(sessionId: string, a: VisualRequest, hooks: Hooks): Promise<ToolResult> {
    if (a.action === 'act_batch') return this.batch(sessionId, a, hooks);
    if (a.action === 'zoom') {
      const o = this.latest, r = a.region;
      if (!o || o.sessionId !== sessionId || a.screenshotId !== o.id || !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x + r.width > o.width || r.y + r.height > o.height) throw new Error('zoom 需要最新 screenshotId 和图片范围内的 region:{x,y,width,height}。');
      const live = await this.live(sessionId, o.root, hooks);
      if (JSON.stringify(live.bounds) !== JSON.stringify(o.root.bounds)) return this.observe(sessionId, live, hooks, { actionPerformed: false, verification: 'refreshed' });
      const point = imagePointToScreen(o, r.x, r.y);
      return this.observe(sessionId, live, hooks, {}, { ...point, width: Math.max(1, Math.floor(r.width * o.originalWidth / o.width)), height: Math.max(1, Math.floor(r.height * o.originalHeight / o.height)) }, true);
    }
    if (a.action === 'list_windows' || a.action === 'list_roots') {
      const roots = (await this.list(sessionId, hooks)).filter(r => a.pid === undefined || r.pid === a.pid);
      const data = { desktopWorkflow: true, mode: 'visual', roots, next: 'Use screenshot without a root for the active display, taskbar, tray and menus. Other displays have their own desktop rootRef. Or look with one returned window rootRef. Physical mouse/keyboard is the default. Read the screenshot to choose the target; window titles alone are not proof. visible=false means hidden (often in the tray); restore it via the observed taskbar/tray, do not look/focus it or substitute another process sharing the title.' };
      return { success: true, output: JSON.stringify(data), data };
    }
    if (a.action === 'look' || a.action === 'screenshot' || a.action === 'focus_window') {
      const selected = a.rootRef || a.windowRef || a.windowId !== undefined
        ? this.select(sessionId, a)
        : await this.activeDisplay(sessionId, hooks);
      if (!selected) throw new Error('当前输入模式没有全桌面目标，请选择 list_windows 返回的窗口。');
      this.latest = undefined;
      await this.driver.focus(selected); hooks.check();
      const root = await this.live(sessionId, selected, hooks);
      return this.observe(sessionId, root, hooks);
    }
    if (a.action === 'wait_for') {
      // Waiting is an observation, not input. It must work with a window reference alone.
      const root = a.rootRef || a.windowRef || a.windowId !== undefined ? this.select(sessionId, a) : this.latest?.sessionId === sessionId ? this.latest.root : undefined;
      if (!root) throw new Error('wait_for 需要已选择的窗口引用。');
      const wait = Number.isFinite(a.timeoutMs) ? Math.min(15_000, Math.max(0, a.timeoutMs!)) : a.condition ? 3000 : 500;
      hooks.update({ phase: 'verifying', target: root });
      if (a.condition) return this.waitForVisual(sessionId, a, root, wait, hooks);
      // Check interruption between slices; never hold a stop request for the entire timeout.
      const end = Date.now() + wait;
      while (Date.now() < end) { hooks.check(); await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, end - Date.now())))); }
      hooks.check();
      return this.observe(sessionId, await this.live(sessionId, root, hooks), hooks, { verification: 'needs_review', requestedCondition: a.text || a.role || a.value || null, next: '等待结束；请从新截图判断条件是否满足。本结果未声称已匹配文字。' });
    }
    if (a.action === 'read_text') throw new Error('当前为视觉模式，请直接阅读截图中的文字。');
    if (a.action !== 'act' || !INPUT.has(a.kind || '')) throw new Error('视觉模式支持 act: click/moveMouse/drag/scroll/typeText/keypress。');
    if (a.targetRef) throw new Error('视觉模式使用截图像素坐标，不使用 UIA 元素引用；请重新看图定位。');
    const o = this.latest;
    if (!o || o.sessionId !== sessionId || (a.screenshotId || a.lookId) !== o.id) throw new Error('该截图不属于当前会话或已被使用，请 look 后根据新截图决定下一步。');
    const live = await this.live(sessionId, o.root, hooks);
    if (Date.now() - o.at > 60_000 || JSON.stringify(live.bounds) !== JSON.stringify(o.root.bounds)) {
      this.latest = undefined;
      return this.observe(sessionId, live, hooks, { actionPerformed: false, verification: 'refreshed', next: '窗口位置或截图时效发生变化，已自动刷新截图，未发送输入。请根据新截图重新决定动作。' });
    }
    const kind = a.kind as VisualDesktopInput['kind'];
    const point = POINTER.has(kind) ? imagePointToScreen(o, a.targetX, a.targetY) : undefined;
    const params = { ...a.params };
    if (point) hooks.update({ cursor: { ...point, visible: true } });
    if (kind === 'drag') {
      const to = imagePointToScreen(o, params['toX'], params['toY']);
      params['toX'] = to.x; params['toY'] = to.y;
    }
    if (kind === 'typeText' && (typeof params['text'] !== 'string' || !params['text'])) throw new Error('typeText 需要 params.text。');
    if (kind === 'keypress' && (typeof params['key'] !== 'string' || !params['key'])) throw new Error('keypress 需要 params.key。');
    const signature = JSON.stringify([sessionId, live.rootRef, kind, point, params]);
    if (kind === 'click' && this.unchangedClick?.signature === signature && this.unchangedClick.count >= 2) {
      const refreshed = await this.observe(sessionId, live, hooks, { actionPerformed: false, verification: 'unchanged', next: '同一点已点击两次，画面完全未变。不要重复该点击；重新识别图标/遮挡/弹窗，改用托盘图标或其他可见入口。窗口标题不等于实际应用画面。' });
      return { ...refreshed, success: false, error: 'Repeated click produced no visible change. Choose a different observed target.' };
    }
    this.latest = undefined;
    hooks.update({ phase: 'acting', lastAction: kind, verification: 'pending' }); hooks.check();
    let input: unknown;
    try {
      input = await this.driver.input({ ...live, ...(o.root.foregroundWindowId === undefined ? {} : { foregroundWindowId: o.root.foregroundWindowId }) }, { kind, ...(point || {}), params });
      if (input && typeof input === 'object' && ('performed' in input && input.performed === false || 'success' in input && input.success === false)) throw new Error('Native input was not performed.');
    }
    catch (error) {
      hooks.check();
      const message = `桌面输入未能确认：${error instanceof Error ? error.message : String(error)}。请先检查新截图，不要直接重放输入。`;
      try {
        const refreshed = await this.observe(sessionId, await this.live(sessionId, live, hooks), hooks, { actionPerformed: 'unknown', verification: 'needs_review', recovery: 'Inspect the returned image before deciding the next action. Never replay an uncertain send.' });
        return { ...refreshed, success: false, error: message };
      } catch { hooks.check(); throw new Error(message); }
    }
    try {
      hooks.check(); hooks.update({ phase: 'verifying' });
      // Let the target process paint after receiving an asynchronous click/type message.
      for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 50)); hooks.check(); }
      let currentRoot = live;
      if (live.rootRef.startsWith('desktop:')) {
        const activeDisplay = await this.activeDisplay(sessionId, hooks);
        const foreground = this.inventories.get(sessionId)?.find(r => r.windowId > 0 && r.isForeground);
        // Tray popups may not activate: keep the clicked display unless focus moved to another app.
        if (activeDisplay && (o.root.foregroundWindowId === undefined || !foreground || foreground.windowId !== o.root.foregroundWindowId)) currentRoot = activeDisplay;
      } else currentRoot = await this.live(sessionId, live, hooks);
      const result = await this.observe(sessionId, currentRoot, hooks, { input, actionPerformed: true, verification: 'needs_review', displayChanged: currentRoot.rootRef !== live.rootRef }, currentRoot.rootRef.startsWith('desktop:') ? this.appViewport(sessionId, currentRoot) : undefined);
      const after = this.latest as Observation | undefined;
      const unchanged = !!after && after.root.rootRef === o.root.rootRef && after.originX === o.originX && after.originY === o.originY && after.originalWidth === o.originalWidth && after.originalHeight === o.originalHeight && !visualPixelsChanged(o.pixels, after.pixels);
      this.unchangedClick = kind === 'click' && unchanged ? { signature, count: this.unchangedClick?.signature === signature ? this.unchangedClick.count + 1 : 1 } : undefined;
      if (unchanged) {
        const data = result.data as Record<string, unknown>;
        data['visualChange'] = 'none';
        data['next'] = '输入已投递，但截图没有可见变化，尚未证明操作生效。重新判断图标和输入焦点；不要重复相同点击或声称已打开。任务栏入口无效时观察托盘及展开箭头。';
        const { visualObservation: _image, ...text } = data;
        result.output = JSON.stringify(text);
      }
      return result;
    }
    catch (error) { throw new DesktopInputObservationError(`输入已发出，但操作后截图失败：${error instanceof Error ? error.message : String(error)}。请重新 look 核对结果，不能把此错误当作未执行而重复输入。`); }
  }
}
