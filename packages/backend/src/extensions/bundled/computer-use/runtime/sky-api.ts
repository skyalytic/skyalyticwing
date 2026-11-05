import { desktopObservationImage } from './desktop-observation-image.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DesktopInputObservationError } from './visual-desktop-workflow.js';
import type { UiaService } from '../../../../modules/automation/uia.service.js';
import { type VisualDesktopDriver, type VisualDesktopRoot, visualPointToScreen } from './visual-desktop-driver.js';

export interface SkyWindow { id: number; app: string; title?: string; kind?: 'desktop' | 'window'; visible?: boolean; minimized?: boolean; bounds?: VisualDesktopRoot['bounds'] }
type Dict = Record<string, any>;
type Snapshot = { window: SkyWindow; root: VisualDesktopRoot; id?: string; lookId?: string; refs: Map<number, string>; at: number;
  width: number; height: number; originalWidth: number; originalHeight: number; originX: number; originY: number; focused?: string; pixels?: Buffer };
export interface SkyHooks { check(): void; update(state: Dict): void; image(image: Dict): void }
const object = (value: any): Dict => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const sameBounds = (a: Dict, b: Dict) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const isDisplay = (root: VisualDesktopRoot) => root.windowId <= 0 && root.pid === 0 && root.rootRef === `desktop:${-root.windowId}`;
const forbiddenApp = /(?:^|[\\/])(?:cmd|powershell|pwsh|windowsterminal|lockapp|credentialuibroker|consent|sechealthui|securityhealthsystray|chatgpt|codex|1password|bitwarden|keepass|lastpass)(?:\.exe)?$/i;

/** Bind desktop input to observed window identity, focus and image coordinates. */
export class SkyApi {
  private windows = new Map<number, { window: SkyWindow; root: VisualDesktopRoot }>();
  private snapshot: Snapshot | undefined;
  private apps = new Map<string, Dict>();
  constructor(private readonly driver: VisualDesktopDriver, _uia: UiaService) {}
  invalidate(preserveWindows = false): void { this.snapshot = undefined; if (!preserveWindows) this.windows.clear(); }
  private requireWindow(input: any): { window: SkyWindow; root: VisualDesktopRoot } {
    const candidate = object(input), known = this.windows.get(candidate['id']);
    if (!known || candidate['app'] !== known.window.app) throw new Error('Window must be selected from the returned app/window inventory.');
    if (forbiddenApp.test(known.window.app) || /密码管理|Windows 安全|Windows Security|ChatGPT|Codex/i.test(known.window.title || '')) throw new Error('This target is excluded by the Computer Use guide.');
    return known;
  }
  private async live(known: { window: SkyWindow; root: VisualDesktopRoot }, hooks: SkyHooks) {
    let root: VisualDesktopRoot;
    try { root = await this.driver.inspectWindow(known.root); hooks.check(); }
    catch (error) { this.snapshot = undefined; throw error; }
    if (root.windowId !== known.root.windowId || root.pid !== known.root.pid) {
      this.snapshot = undefined; throw new Error('Window was closed or replaced; select a current returned window.');
    }
    return root;
  }
  async call(method: string, input: Dict = {}, hooks: SkyHooks): Promise<unknown> {
    hooks.check();
    if (input['return_state'] !== undefined && typeof input['return_state'] !== 'boolean') throw new Error('return_state must be boolean');
    if (method === 'list_windows' || method === 'list_apps') {
      const roots = await this.driver.listWindows(); hooks.check(); this.windows.clear();
      // A hidden window is still a candidate. Native styles exclude some utility
      // windows, but only a fresh screen can identify the actual application UI.
      for (const root of roots.filter(r => isDisplay(r) || (r.windowId > 0 && (r.visible !== false || r.restorable === true || r.minimized === true)))) {
        const app = isDisplay(root) ? 'wing:desktop' : root.processPath || `${root.processName || root.pid}.exe`;
        const window: SkyWindow = { id: root.windowId, app, title: root.title, kind: isDisplay(root) ? 'desktop' : 'window', bounds: root.bounds,
          ...(root.visible === undefined ? {} : { visible: root.visible }),
          ...(root.minimized === undefined ? {} : { minimized: root.minimized }) };
        this.windows.set(window.id, { window, root });
      }
      if (method === 'list_windows') return [...this.windows.values()].map(v => v.window);
      const installed = await this.driver.listApps(); hooks.check(); this.apps.clear();
      for (const app of installed) this.apps.set(app.id.toLowerCase(), { ...app, windows: [] });
      // A process can be running without a visible/restorable window. Never infer
      // "not running" just from windows.length, or confuse a same-title helper app.
      for (const root of roots) {
        if (!root.processPath) continue;
        const app = this.apps.get(root.processPath.toLowerCase()) || { id: root.processPath, displayName: root.processName, windows: [] };
        app['isRunning'] = true; this.apps.set(root.processPath.toLowerCase(), app);
      }
      for (const { window } of this.windows.values()) {
        if (window.kind === 'desktop') continue;
        const app = this.apps.get(window.app.toLowerCase()) || { id: window.app, displayName: window.app, windows: [] };
        app['isRunning'] = true; app['windows'].push(window); this.apps.set(window.app.toLowerCase(), app);
      }
      // Link launcher records to canonical running executable windows. The window
      // keeps its actual process identity so PID/handle checks cannot follow an alias.
      for (const app of this.apps.values()) {
        const paths = new Set((Array.isArray(app['runningAppIds']) ? app['runningAppIds'] : []).map((p: string) => p.toLowerCase()));
        for (const { window } of this.windows.values()) {
          if (window.kind !== 'desktop' && paths.has(window.app.toLowerCase()) && !app['windows'].some((w: SkyWindow) => w.id === window.id)) app['windows'].push(window);
        }
      }
      return [...this.apps.values()];
    }
    if (method === 'get_window') {
      if (!this.windows.has(input['id'])) await this.call('list_windows', {}, hooks);
      const known = this.windows.get(input['id']);
      if (!known || (input['app'] !== undefined && input['app'] !== known.window.app)) throw new Error('Unknown window; refresh list_windows.');
      await this.live(known, hooks); return known.window;
    }
    if (method === 'launch_app') {
      const app = input['app'];
      if (typeof app !== 'string' || forbiddenApp.test(app) || (!this.apps.has(app.toLowerCase()) && !/^[^\r\n"<>|]+\.exe$/i.test(app))) throw new Error('Use a returned app id or an explicit executable identifier.');
      this.snapshot = undefined;
      await this.call('list_apps', {}, hooks);
      const existing = this.apps.get(app.toLowerCase());
      if (existing?.['isRunning']) {
        const candidates = existing['windows'] as SkyWindow[];
        if (candidates.length !== 1 || candidates[0]?.visible === false) throw new Error('Application is already running. Select and observe its returned window candidates. If ambiguous or hidden, use a returned desktop display from list_windows to inspect and restore the app from the visible tray. No new instance was launched.');
        return this.call('activate_window', { window: candidates[0] }, hooks);
      }
      await this.driver.launchApp(app); hooks.check(); return undefined;
    }
    const known = this.requireWindow(input['window']);
    const root = await this.live(known, hooks);
    if (method === 'activate_window') {
      this.snapshot = undefined; await this.driver.focus(root); hooks.check(); return undefined;
    }
    if (method === 'get_window_state') return input['region'] === undefined
      ? this.observe(known.window, root, input, hooks) : this.magnify(known.window, root, input, hooks);
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.window.id !== known.window.id || snapshot.window.app !== known.window.app || Date.now() - snapshot.at > 60_000) throw new Error('Observe the selected window before input.');
    if (input['screenshotId'] !== undefined && input['screenshotId'] !== snapshot.id) throw new Error('Screenshot does not belong to the latest observation.');
    this.snapshot = undefined; // Consume even on failure. No hidden replay.
    if (!sameBounds(root.bounds, snapshot.root.bounds)) throw new Error('Window moved; observe again before input.');
    // Activating the parent here can dismiss an observed search/menu popup. Input
    // must use the observed focus, never silently restore it after the screenshot.
    const info = root;
    if (info.foregroundWindowId === undefined) throw new Error('Foreground metadata unavailable; observe again before input.');
    if ( snapshot.root.foregroundWindowId !== undefined && info.foregroundWindowId !== snapshot.root.foregroundWindowId) throw new Error('Window focus changed since the observation; observe again before input. No input was sent.');
    const inputRoot = { ...snapshot.root, foregroundWindowId: info.foregroundWindowId };
    const indexed = input['element_index'] !== undefined;
    if (indexed) {
      const ref = snapshot.refs.get(input['element_index']);
      if (!ref || !snapshot.lookId) throw new Error('Element index is not from the latest accessibility observation.');
      if (!['click', 'set_value', 'perform_secondary_action'].includes(method)) throw new Error('This action does not accept element_index.');
      const result = await this.driver.accessibilityInput(inputRoot, { snapshotId: snapshot.lookId, index: input['element_index'],
        action: method === 'perform_secondary_action' ? input['action'] : method, value: input['value'],
        button: normalizeMouseButton(input['mouse_button']), clickCount: input['click_count'] || 1 });
      if (result['performed'] !== true) throw new Error('Accessibility input was not performed; refresh before retrying.');
      return this.afterInput(known, input, hooks);
    }
    const point = (x: unknown, y: unknown) => {
      if (!snapshot.id || typeof x !== 'number' || typeof y !== 'number') throw new Error('Pointer input requires a screenshot and image coordinates.');
      return visualPointToScreen({ x, y }, snapshot);
    };
    let kind: 'click' | 'typeText' | 'keypress' | 'scroll' | 'drag';
    let location: { x: number; y: number } | undefined; let params: Dict;
    if (method === 'click') { kind = 'click'; location = point(input['x'], input['y']); params = { button: normalizeMouseButton(input['mouse_button']), clickCount: input['click_count'] || 1 }; }
    else if (method === 'scroll') { kind = 'scroll'; location = point(input['x'], input['y']); if (![input['scrollX'], input['scrollY']].every(Number.isFinite)) throw new Error('Scroll deltas must be finite'); params = { deltaX: input['scrollX'], deltaY: -input['scrollY'] }; }
    else if (method === 'drag') { kind = 'drag'; location = point(input['from_x'], input['from_y']); const end = point(input['to_x'], input['to_y']); params = { toX: end.x, toY: end.y }; }
    else if (method === 'type_text') { kind = 'typeText'; if (typeof input['text'] !== 'string' || /[\r\n\t]/.test(input['text'])) throw new Error('type_text accepts literal text; use press_key for controls.'); params = { text: input['text'] }; }
    else if (method === 'press_key') { kind = 'keypress'; params = { key: normalizeSkyKey(input['key']) }; }
    else throw new Error(`Unsupported sky method: ${method}`);
    hooks.update({ phase: 'acting', lastAction: method, ...(location ? { cursor: { ...location, visible: false } } : {}) });
    const result = object(await this.driver.input(inputRoot, { kind, ...location, params }));
    if (result['performed'] === false || result['success'] === false) throw new Error('Input outcome is unknown; observe again before retrying.');
    return this.afterInput(known, input, hooks);
  }
  private async afterInput(known: { window: SkyWindow; root: VisualDesktopRoot }, input: Dict, hooks: SkyHooks) {
    try {
      hooks.check();
      if (input['return_state'] !== true) return undefined;
      // 复用绑定窗口并返回一次操作后观察，不另列所有应用，也不暗中切换窗口。
      const state = await this.observe(known.window, await this.live(known, hooks), { include_screenshot: true }, hooks);
      return { ...state, inputReceipt: { outcome: 'delivered', replay: false }, observationComplete: true };
    } catch (error) {
      throw new DesktopInputObservationError(`Input delivered, but post-action observation failed: ${error instanceof Error ? error.message : String(error)}. Observe again; do not replay input.`);
    }
  }
  private async observe(window: SkyWindow, root: VisualDesktopRoot, input: Dict, hooks: SkyHooks) {
    this.snapshot = undefined; hooks.update({ phase: 'observing', target: root, mode: 'visual' });
    const desktop = isDisplay(root);
    if (desktop && input['include_screenshot'] === false) throw new Error('Desktop/tray recovery requires a fresh screenshot.');
    const refs = new Map<number, string>(); let accessibility: Dict | null = null; let lookId: string | undefined;
    // Explicit text requests use UIA; weak accessibility apps keep screenshot-only default.
    if (!desktop && input['include_text'] === true) {
      const raw = await this.driver.accessibility(root); hooks.check();
      lookId = raw['snapshotId']; const { snapshotId: _id, ...state } = raw; accessibility = state;
      for (const line of String(raw['tree'] || '').split('\n')) { const match = line.match(/^\s*(\d+):/); if (match) refs.set(Number(match[1]), match[1]!); }
    }
    if (input['include_screenshot'] === false) {
      const info = await this.driver.windowInfo(root); hooks.check();
      root = { ...root, foregroundWindowId: info.foregroundWindowId };
    }
    const screenshots: Dict[] = [];
    let dimensions = { width: 0, height: 0, originalWidth: 0, originalHeight: 0, originX: root.bounds.x, originY: root.bounds.y };
    let id: string | undefined, pixels: Buffer | undefined;
    const capturedAt = Date.now();
    if (input['include_screenshot'] !== false) {
      const capture = desktop ? await this.driver.capture(root) : await this.driver.captureWindow(root); hooks.check();
      pixels = Buffer.from(capture.base64, 'base64');
      const image = await desktopObservationImage(sharp(pixels).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }));
      id = randomUUID(); dimensions = { width: image.info.width, height: image.info.height, originalWidth: capture.width, originalHeight: capture.height, originX: capture.originX, originY: capture.originY };
      root = { ...root, bounds: capture.bounds, foregroundWindowId: capture.foregroundWindowId } as VisualDesktopRoot;
      const base64 = image.data.toString('base64');
      screenshots.push({ id, width: dimensions.width, height: dimensions.height, originX: 0, originY: 0, url: `data:${image.mimeType};base64,${base64}`, zIndex: 0 });
      hooks.image({ kind: 'desktop', mimeType: image.mimeType, detail: 'high', coordinateSpace: 'image', base64, width: dimensions.width, height: dimensions.height, screenshotId: id, capturedAt });
    }
    this.snapshot = { window, root, refs, at: capturedAt, ...dimensions, ...(id && pixels ? { id, pixels } : {}), ...(lookId ? { lookId } : {}) };
    hooks.update({ phase: 'ready', target: root, mode: 'visual' });
    return { window, inputMode: this.driver.getInputMode(), accessibility, screenshots };
  }

  /** Inspect a crop of the existing native frame; no input, recapture, or freshness extension. */
  private async magnify(window: SkyWindow, root: VisualDesktopRoot, input: Dict, hooks: SkyHooks) {
    const snapshot = this.snapshot, rawRegion = object(input['region']), scale = input['scale'] ?? 3;
    const region = { x: rawRegion['x'], y: rawRegion['y'], width: rawRegion['width'], height: rawRegion['height'] };
    if (!snapshot?.id || !snapshot.pixels || snapshot.window.id !== window.id || snapshot.window.app !== window.app
      || input['screenshotId'] !== snapshot.id || Date.now() - snapshot.at > 60_000) throw new Error('Magnification requires the latest screenshotId for this window; observe again.');
    if (!sameBounds(root.bounds, snapshot.root.bounds) || root.foregroundWindowId !== snapshot.root.foregroundWindowId) {
      this.snapshot = undefined; throw new Error('Window moved or focus changed; observe again before magnification.');
    }
    if (input['include_screenshot'] === false || ![region.x, region.y, region.width, region.height, scale].every(Number.isFinite)
      || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > snapshot.width
      || region.y + region.height > snapshot.height || scale < 1 || scale > 4) throw new Error('Use an image-bounded region and a scale between 1 and 4.');
    const source = sharp(snapshot.pixels), metadata = await source.metadata();
    const sx = metadata.width! / snapshot.width, sy = metadata.height! / snapshot.height;
    const left = Math.floor(region.x * sx), top = Math.floor(region.y * sy);
    const width = Math.min(metadata.width!, Math.ceil((region.x + region.width) * sx)) - left;
    const height = Math.min(metadata.height!, Math.ceil((region.y + region.height) * sy)) - top;
    const pixels = await source.extract({ left, top, width, height }).png().toBuffer();
    const image = await desktopObservationImage(sharp(pixels).resize({ width: Math.max(1, Math.min(1600, Math.round(region.width * scale))),
      height: Math.max(1, Math.min(1600, Math.round(region.height * scale))), fit: 'inside', kernel: 'nearest' }));
    hooks.check();
    const id = randomUUID();
    const next: Snapshot = { ...snapshot, id, pixels, refs: new Map(),
      width: image.info.width, height: image.info.height,
      originX: snapshot.originX + left * snapshot.originalWidth / metadata.width!,
      originY: snapshot.originY + top * snapshot.originalHeight / metadata.height!,
      originalWidth: width * snapshot.originalWidth / metadata.width!, originalHeight: height * snapshot.originalHeight / metadata.height! };
    // The live geometry check precedes asynchronous image processing. Input checks it again.
    delete next.lookId;
    this.snapshot = next;
    const base64 = image.data.toString('base64');
    hooks.image({ kind: 'desktop', mimeType: image.mimeType, detail: 'high', coordinateSpace: 'image', base64,
      width: next.width, height: next.height, screenshotId: id, capturedAt: snapshot.at, derivedFrom: snapshot.id, region });
    return { window, inputMode: this.driver.getInputMode(), accessibility: null, derivedFrom: snapshot.id,
      screenshots: [{ id, width: next.width, height: next.height, originX: 0, originY: 0, url: `data:${image.mimeType};base64,${base64}`, zIndex: 0 }] };
  }

}

export function normalizeSkyKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing key');
  const aliases: Record<string, string> = { control: 'Ctrl', control_l: 'Ctrl', control_r: 'Ctrl', shift_l: 'Shift', shift_r: 'Shift', alt_l: 'Alt', alt_r: 'Alt', period: '.', comma: ',', slash: '/', backslash: '\\', greater: '.', less: ',', question: '/', return: 'Enter', escape: 'Escape', kp_enter: 'Enter', numpad_enter: 'Enter', kp_add: 'ADD', numpad_add: 'ADD', kp_subtract: 'SUBTRACT', kp_multiply: 'MULTIPLY', kp_divide: 'DIVIDE', kp_decimal: 'DECIMAL', numpad_subtract: 'SUBTRACT', numpad_multiply: 'MULTIPLY', numpad_divide: 'DIVIDE', numpad_decimal: 'DECIMAL', page_up: 'PageUp', page_down: 'PageDown' };
  return value.split('+').map(part => {
    const key = part.trim().toLowerCase();
    if (/^(meta|windows|win|cmd|command|super|os)(_[lr])?$/.test(key)) throw new Error('Windows-key shortcuts are excluded by the Computer Use guide.');
    if (/^(kp|numpad)_\d$/.test(key)) return 'NUMPAD' + key.slice(-1);
    return aliases[key] || part.trim();
  }).join('+');
}

function normalizeMouseButton(value: unknown): string {
  const button = value === undefined ? 'left' : String(value); const aliases: Record<string,string> = { l: 'left', r: 'right', m: 'middle' };
  const result = aliases[button] || button; if (!['left','right','middle'].includes(result)) throw new Error('Invalid mouse_button'); return result;
}
