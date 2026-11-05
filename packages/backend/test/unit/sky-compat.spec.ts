import { SkyApi, normalizeSkyKey } from '../../src/extensions/bundled/computer-use/runtime/sky-api';
import { SkyRepl } from '../../src/extensions/bundled/computer-use/runtime/sky-repl';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { DesktopInputObservationError } from '../../src/extensions/bundled/computer-use/runtime/visual-desktop-workflow';

describe('Computer Use guide and window2 contract', () => {
  const root = { rootRef: 'visual:123:7', windowId: 123, pid: 7, title: 'Fixture', processPath: 'C:\\Fixture.exe', bounds: { x: -400, y: 50, width: 300, height: 200 } };
  let driver: any, api: SkyApi, window: any, image: jest.Mock, png: string;
  const hooks = () => ({ check() {}, update() {}, image });
  beforeEach(async () => {
    png = (await sharp({ create: { width: 300, height: 200, channels: 3, background: '#198C42' } }).png().toBuffer()).toString('base64');
    driver = { listWindows: jest.fn(async () => [structuredClone(root)]), listApps: jest.fn(async () => [{ id: root.processPath, displayName: 'Fixture' }]),
      launchApp: jest.fn(), getInputMode: () => 'physical', focus: jest.fn(async () => ({ focused: true, bounds: root.bounds })), windowInfo: jest.fn(async () => ({ bounds: root.bounds, foregroundWindowId: 123 })),
      captureWindow: jest.fn(async () => ({ base64: png, width: 300, height: 200, originX: -400, originY: 50, bounds: root.bounds, foregroundWindowId: 123 })),
      accessibility: jest.fn(async () => ({ snapshotId: 'access-1', tree: '0: Window Fixture\n\t1: Edit Input', focused_element: '1: Edit Input' })), accessibilityInput: jest.fn(async () => ({ performed: true })), input: jest.fn(async () => ({ performed: true })) };
    driver.inspectWindow = jest.fn(async (target: any) => {
      // Test fixtures mutate the inventory response to model external geometry/PID changes.
      const current = await driver.listWindows.getMockImplementation()();
      const live = current.find((r: any) => r.windowId === target.windowId && r.pid === target.pid);
      if (!live) throw new Error('Window closed or replaced');
      const info = await driver.windowInfo(target);
      return { ...live, foregroundWindowId: info.foregroundWindowId };
    });
    image = jest.fn(); api = new SkyApi(driver, {} as any); window = (await api.call('list_windows', {}, hooks()) as any[])[0];
  });
  it('selects canonical app/window objects and restores a previously returned window after reset', async () => {
    const apps = await api.call('list_apps', {}, hooks()) as any[]; expect(apps[0].windows).toEqual([window]);
    api.invalidate(); expect(await api.call('get_window', window, hooks())).toEqual(window);
    await expect(api.call('get_window', { id: 123, app: 'fake' }, hooks())).rejects.toThrow('Unknown');
  });
  it('returns one fresh bound-window screenshot with input and preserves delivery if capture fails', async () => {
    await api.call('get_window_state', { window }, hooks());
    const after = await api.call('click', { window, x: 10, y: 10, return_state: true }, hooks()) as any;
    expect(after).toMatchObject({ window, observationComplete: true, inputReceipt: { outcome: 'delivered', replay: false } });
    expect(after.screenshots).toHaveLength(1);
    expect(driver.input).toHaveBeenCalledTimes(1);
    expect(driver.captureWindow).toHaveBeenCalledTimes(2);
    driver.captureWindow.mockRejectedValue(new Error('capture failed'));
    const failure = await api.call('type_text', { window, text: 'once', return_state: true }, hooks()).catch(e => e);
    expect(failure).toBeInstanceOf(DesktopInputObservationError);
    expect((failure as DesktopInputObservationError).data.inputReceipt.outcome).toBe('delivered');
    expect(driver.input).toHaveBeenCalledTimes(2);
    await expect(api.call('type_text', { window, text: 'once', return_state: true }, hooks())).rejects.toThrow('Observe');
  });
  it('exposes and restores a hidden tray main window without launching a second process', async () => {
    const hidden = { ...root, visible: false, minimized: true, restorable: true };
    driver.listWindows.mockResolvedValue([hidden,
      { ...hidden, windowId: 124, title: 'Tray message sink', minimized: false, restorable: false },
      { ...root, windowId: 125, processPath: 'C:\\Helper.exe', title: root.title, visible: true }]);
    const apps = await api.call('list_apps', {}, hooks()) as any[];
    const app = apps.find(a => a.id === root.processPath);
    expect(app.isRunning).toBe(true);
    expect(app.windows).toEqual([expect.objectContaining({ id: 123, visible: false, minimized: true, bounds: root.bounds })]);
    await api.call('activate_window', { window: app.windows[0] }, hooks());
    expect(driver.focus).toHaveBeenCalledWith(expect.objectContaining(hidden));
    await expect(api.call('launch_app', { app: root.processPath }, hooks())).rejects.toThrow('already running');
    expect(driver.launchApp).not.toHaveBeenCalled();
    expect(driver.focus).toHaveBeenCalledTimes(1);
  });
  it('associates package launchers with canonical running windows without guessing a hidden main window', async () => {
    const launcher = 'C:\\Tools\\GenericMessenger\\GenericMessenger.exe';
    const executable = 'C:\\Tools\\GenericMessenger\\app-9.2\\GenericMessenger.exe';
    driver.listApps.mockResolvedValue([{ id: launcher, isRunning: true, runningAppIds: [executable] }]);
    driver.listWindows.mockResolvedValue([{ ...root, processPath: executable, visible: false, restorable: true },
      { ...root, windowId: 124, title: 'Auxiliary', processPath: executable, visible: false, restorable: true }]);
    const apps = await api.call('list_apps', {}, hooks()) as any[];
    expect(apps.find(a => a.id === launcher)).toMatchObject({ isRunning: true, windows: [
      expect.objectContaining({ id: 123, app: executable }), expect.objectContaining({ id: 124, app: executable }),
    ] });
    await expect(api.call('launch_app', { app: launcher }, hooks())).rejects.toThrow('already running');
    expect(driver.focus).not.toHaveBeenCalled(); expect(driver.launchApp).not.toHaveBeenCalled();
  });
  it('exposes desktop displays for visual tray recovery when a running app has no restorable window', async () => {
    const display = { rootRef: 'desktop:0', windowId: 0, pid: 0, title: 'Primary display', bounds: root.bounds };
    driver.listWindows.mockResolvedValue([display]);
    driver.listApps.mockResolvedValue([{ id: root.processPath, isRunning: true, runningAppIds: [root.processPath] }]);
    driver.capture = jest.fn(async () => ({ base64: png, width: 300, height: 200, originX: -400, originY: 50, bounds: display.bounds, foregroundWindowId: 900 }));
    driver.windowInfo.mockResolvedValue({ bounds: display.bounds, foregroundWindowId: 900 });
    expect(await api.call('list_apps', {}, hooks())).toEqual([expect.objectContaining({ id: root.processPath, windows: [], isRunning: true })]);
    const displays = await api.call('list_windows', {}, hooks()) as any[];
    const desktop = displays.find(w => w.kind === 'desktop'); expect(desktop).toBeDefined();
    const selected = await api.call('get_window', desktop, hooks());
    const state: any = await api.call('get_window_state', { window: selected, include_text: true }, hooks());
    expect(state.accessibility).toBeNull(); expect(driver.accessibility).not.toHaveBeenCalled(); expect(driver.captureWindow).not.toHaveBeenCalled();
    await api.call('click', { window: selected, screenshotId: state.screenshots[0].id, x: 30, y: 40 }, hooks());
    expect(driver.input).toHaveBeenCalledWith(expect.objectContaining({ windowId: 0 }), expect.objectContaining({ x: -370, y: 90 }));
    expect(driver.focus).not.toHaveBeenCalled(); expect(driver.launchApp).not.toHaveBeenCalled();
    await expect(api.call('click', { window: selected, x: 30, y: 40 }, hooks())).rejects.toThrow('Observe');
    await expect(api.call('get_window_state', { window: selected, include_screenshot: false }, hooks())).rejects.toThrow('fresh screenshot');
    await api.call('get_window_state', { window: selected }, hooks());
    driver.windowInfo.mockResolvedValue({ bounds: display.bounds, foregroundWindowId: 901 });
    await expect(api.call('type_text', { window: selected, text: 'fixture' }, hooks())).rejects.toThrow('focus changed');
    expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('requires a new observation after a monitor layout change and rejects fabricated displays', async () => {
    const display = { rootRef: 'desktop:1', windowId: -1, pid: 0, title: 'Display 2', bounds: root.bounds };
    driver.listWindows.mockResolvedValue([display, { ...display, windowId: -2 }]);
    driver.capture = jest.fn(async () => ({ base64: png, width: 300, height: 200, originX: -400, originY: 50, bounds: display.bounds, foregroundWindowId: 900 }));
    const windows = await api.call('list_windows', {}, hooks()) as any[];
    expect(windows).toHaveLength(1);
    await api.call('get_window_state', { window: windows[0] }, hooks());
    driver.listWindows.mockResolvedValue([{ ...display, bounds: { ...display.bounds, x: 0 } }]);
    await expect(api.call('click', { window: windows[0], x: 30, y: 40 }, hooks())).rejects.toThrow('moved');
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('refuses a duplicate launch with no main window or ambiguous windows, and allows a stopped app', async () => {
    driver.listWindows.mockResolvedValue([]);
    driver.listApps.mockResolvedValue([{ id: root.processPath, isRunning: true }]);
    await expect(api.call('launch_app', { app: root.processPath }, hooks())).rejects.toThrow('already running');
    driver.listWindows.mockResolvedValue([root, { ...root, windowId: 124 }]);
    await expect(api.call('launch_app', { app: root.processPath }, hooks())).rejects.toThrow('already running');
    expect(driver.launchApp).not.toHaveBeenCalled(); expect(driver.focus).not.toHaveBeenCalled();
    driver.listWindows.mockResolvedValue([]);
    driver.listApps.mockResolvedValue([{ id: root.processPath, isRunning: false }]);
    await api.call('launch_app', { app: root.processPath }, hooks());
    expect(driver.launchApp).toHaveBeenCalledTimes(1);
  });
  it('counts hidden helper processes as running without treating helper windows as main windows', async () => {
    driver.listWindows.mockResolvedValue([{ ...root, visible: false, minimized: false, restorable: false }]);
    const apps = await api.call('list_apps', {}, hooks()) as any[];
    expect(apps[0]).toMatchObject({ isRunning: true, windows: [] });
    await expect(api.call('launch_app', { app: root.processPath }, hooks())).rejects.toThrow('already running');
    expect(driver.launchApp).not.toHaveBeenCalled();
  });
  it('invalidates pre-wait observations and detects a replaced window before resuming', async () => {
    await api.call('get_window_state', { window }, hooks());
    api.invalidate();
    await expect(api.call('click', { window, x: 10, y: 10 }, hooks())).rejects.toThrow('inventory');
    await api.call('list_windows', {}, hooks());
    await expect(api.call('click', { window, x: 10, y: 10 }, hooks())).rejects.toThrow('Observe');
    driver.listWindows.mockResolvedValue([{ ...root, pid: 999 }]);
    await expect(api.call('activate_window', { window }, hooks())).rejects.toThrow('replaced');
    expect(driver.input).not.toHaveBeenCalled(); expect(driver.focus).not.toHaveBeenCalled();
  });
  it('displays screenshots, maps image coordinates, preserves focus and consumes observations', async () => {
    const state: any = await api.call('get_window_state', { window }, hooks());
    expect(state.accessibility).toBeNull(); expect(image).toHaveBeenCalledTimes(1);
    expect(image.mock.calls[0][0]).toMatchObject({ mimeType: 'image/png', detail: 'high' });
    expect(state.screenshots[0].url).toMatch(/^data:image\/png;base64,/);
    await api.call('click', { window, screenshotId: state.screenshots[0].id, x: 30, y: 40, mouse_button: 'r', click_count: 2 }, hooks());
    expect(driver.input).toHaveBeenCalledWith(expect.objectContaining({ foregroundWindowId: 123 }), { kind: 'click', x: -370, y: 90, params: { button: 'right', clickCount: 2 } });
    expect(driver.focus).not.toHaveBeenCalled();
    await expect(api.call('click', { window, x: 30, y: 40 }, hooks())).rejects.toThrow('Observe');
  });
  it.each([-2400, 2052])('maps a resized popup composition at display origin %s and keeps popup keyboard focus', async originX => {
    const bounds = { x: originX + 60, y: 176, width: 1800, height: 900 };
    driver.listWindows.mockResolvedValue([{ ...root, bounds }]);
    driver.windowInfo.mockResolvedValue({ bounds, foregroundWindowId: 456 });
    const composed = (await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#D25588' } }).png().toBuffer()).toString('base64');
    driver.captureWindow.mockResolvedValue({ base64: composed, width: 2000, height: 1000, originX, originY: 120, bounds, foregroundWindowId: 456 });
    const state: any = await api.call('get_window_state', { window }, hooks());
    expect(state.screenshots[0]).toMatchObject({ width: 1600, height: 800 });
    await api.call('click', { window, screenshotId: state.screenshots[0].id, x: 1560, y: 720 }, hooks());
    expect(driver.input).toHaveBeenLastCalledWith(expect.objectContaining({ foregroundWindowId: 456 }),
      expect.objectContaining({ x: originX + 1950, y: 1020 }));
    await api.call('get_window_state', { window }, hooks());
    await api.call('type_text', { window, text: '文宇' }, hooks());
    expect(driver.input).toHaveBeenLastCalledWith(expect.objectContaining({ foregroundWindowId: 456 }),
      { kind: 'typeText', params: { text: '文宇' } });
    expect(driver.focus).not.toHaveBeenCalled();
  });
  it('refuses input after popup focus changes rather than silently activating the parent', async () => {
    driver.captureWindow.mockResolvedValue({ base64: png, width: 300, height: 200, originX: -400, originY: 50, bounds: root.bounds, foregroundWindowId: 456 });
    await api.call('get_window_state', { window }, hooks());
    await expect(api.call('type_text', { window, text: '文宇' }, hooks())).rejects.toThrow('focus changed');
    expect(driver.focus).not.toHaveBeenCalled(); expect(driver.input).not.toHaveBeenCalled();
  });
  it.each([-2400, 2052])('magnifies native pixels without recapture and maps crop clicks at origin %s', async originX => {
    const bounds = { x: originX, y: 50, width: 2000, height: 1000 };
    driver.listWindows.mockResolvedValue([{ ...root, bounds }]);
    const native = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#fff' } })
      .composite([{ input: Buffer.from('<svg width="100" height="40"><rect width="100" height="40" fill="red"/><path d="M10 5H90V35H10Z" stroke="blue" fill="none"/></svg>'), left: 250, top: 100 }]).png().toBuffer();
    driver.captureWindow.mockResolvedValue({ base64: native.toString('base64'), width: 2000, height: 1000, originX, originY: 50, bounds, foregroundWindowId: 123 });
    const full: any = await api.call('get_window_state', { window }, hooks());
    const zoom: any = await api.call('get_window_state', { window, screenshotId: full.screenshots[0].id,
      region: { x: 200, y: 80, width: 80, height: 32 }, scale: 3 }, hooks());
    expect(driver.captureWindow).toHaveBeenCalledTimes(1); expect(driver.input).not.toHaveBeenCalled();
    expect(zoom.screenshots[0]).toMatchObject({ width: 240, height: 96 });
    expect(zoom.derivedFrom).toBe(full.screenshots[0].id);
    const expected = await sharp(native).extract({ left: 250, top: 100, width: 100, height: 40 }).resize(240, 96, { kernel: 'nearest' }).raw().toBuffer();
    const actual = await sharp(Buffer.from(image.mock.calls.at(-1)![0].base64, 'base64')).raw().toBuffer();
    expect(actual).toEqual(expected);
    await expect(api.call('click', { window, screenshotId: full.screenshots[0].id, x: 20, y: 10 }, hooks())).rejects.toThrow('Screenshot');
    await api.call('click', { window, screenshotId: zoom.screenshots[0].id, x: 120, y: 48 }, hooks());
    expect(driver.input).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ x: originX + 300, y: 170 }));
  });
  it('does not renew screenshot freshness through magnification or inspect stale/foreign regions', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const state: any = await api.call('get_window_state', { window }, hooks());
      const region = { x: 10, y: 10, width: 50, height: 30 };
      await expect(api.call('get_window_state', { window, region, screenshotId: 'wrong' }, hooks())).rejects.toThrow('latest screenshotId');
      await expect(api.call('get_window_state', { window, region: { ...region, x: 290 }, screenshotId: state.screenshots[0].id }, hooks())).rejects.toThrow('image-bounded');
      clock.mockReturnValue(60_000);
      const zoom: any = await api.call('get_window_state', { window, region, screenshotId: state.screenshots[0].id }, hooks());
      clock.mockReturnValue(70_001);
      await expect(api.call('get_window_state', { window, region, screenshotId: zoom.screenshots[0].id }, hooks())).rejects.toThrow('latest screenshotId');
      await expect(api.call('click', { window, x: 5, y: 5 }, hooks())).rejects.toThrow('Observe');
      expect(driver.captureWindow).toHaveBeenCalledTimes(1); expect(driver.input).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('rejects magnification after focus changes and allows fresh full observation to recover', async () => {
    const state: any = await api.call('get_window_state', { window }, hooks());
    driver.windowInfo.mockResolvedValue({ bounds: root.bounds, foregroundWindowId: 456 });
    await expect(api.call('get_window_state', { window, screenshotId: state.screenshots[0].id,
      region: { x: 10, y: 10, width: 50, height: 30 } }, hooks())).rejects.toThrow('focus changed');
    await expect(api.call('click', { window, x: 5, y: 5 }, hooks())).rejects.toThrow('Observe');
    const fresh: any = await api.call('get_window_state', { window }, hooks());
    expect(fresh.screenshots[0].width).toBe(300);
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('keeps a window identity after a recoverable cell error but always requires a fresh observation', async () => {
    await api.call('get_window_state', { window }, hooks()); api.invalidate(true);
    await expect(api.call('type_text', { window, text: '文宇' }, hooks())).rejects.toThrow('Observe');
    await api.call('get_window_state', { window }, hooks());
    await api.call('type_text', { window, text: '文宇' }, hooks());
    expect(driver.input).toHaveBeenCalledTimes(1);
    api.invalidate(true); driver.listWindows.mockResolvedValue([{ ...root, pid: 999 }]);
    await expect(api.call('get_window_state', { window }, hooks())).rejects.toThrow('replaced');
  });
  it('rejects stale screenshots, moved windows, and out-of-image coordinates without sending input', async () => {
    await api.call('get_window_state', { window }, hooks());
    await expect(api.call('click', { window, screenshotId: 'stale', x: 10, y: 10 }, hooks())).rejects.toThrow('Screenshot');
    await api.call('get_window_state', { window }, hooks());
    await expect(api.call('click', { window, x: 300, y: 0 }, hooks())).rejects.toThrow('inside');
    await api.call('get_window_state', { window }, hooks());
    driver.listWindows.mockResolvedValue([{ ...root, bounds: { ...root.bounds, x: 200 } }]);
    await expect(api.call('click', { window, x: 10, y: 10 }, hooks())).rejects.toThrow('moved');
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('supports text-only accessibility state and indexed value replacement', async () => {
    const state: any = await api.call('get_window_state', { window, include_screenshot: false, include_text: true }, hooks());
    expect(state.accessibility.focused_element).toBe('1: Edit Input'); expect(state.screenshots).toEqual([]);
    await api.call('set_value', { window, element_index: 1, value: '你好' }, hooks());
    expect(driver.accessibilityInput).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshotId: 'access-1', index: 1, action: 'set_value', value: '你好' }));
  });
  it('reuses the selected window without scanning the full inventory per input or observation', async () => {
    driver.listWindows.mockClear();
    await api.call('get_window_state', { window }, hooks());
    await api.call('click', { window, x: 30, y: 40 }, hooks());
    await api.call('get_window_state', { window }, hooks());
    await api.call('type_text', { window, text: 'fixture' }, hooks());
    expect(driver.listWindows).not.toHaveBeenCalled();
    expect(driver.inspectWindow).toHaveBeenCalledTimes(4);
    expect(driver.input).toHaveBeenCalledTimes(2);
  });
  it('translates scroll direction and rejects prohibited keys', async () => {
    await api.call('get_window_state', { window }, hooks()); await api.call('scroll', { window, x: 10, y: 10, scrollX: -120, scrollY: 600 }, hooks());
    expect(driver.input.mock.calls[0][1].params).toEqual({ deltaX: -120, deltaY: -600 });
    expect(normalizeSkyKey('Control_L+Shift_L+period')).toBe('Ctrl+Shift+.'); expect(normalizeSkyKey('KP_4')).toBe('NUMPAD4'); expect(normalizeSkyKey('Numpad_Decimal')).toBe('DECIMAL');
    expect(() => normalizeSkyKey('Win+r')).toThrow('Windows-key');
  });
  it('retains source hashes for every unmodified Codex guide', () => {
    const base = join(__dirname, '../../src/extensions/bundled/computer-use/references/codex');
    const provenance = JSON.parse(readFileSync(join(base, 'source.json'), 'utf8'));
    // The exact copied documents are separately checked by the release audit as well.
    expect(readFileSync(join(base, 'skills/computer-use/SKILL.md'), 'utf8')).toContain('await import("@oai/sky")');
    expect(JSON.stringify(provenance)).toContain(createHash('sha256').update(readFileSync(join(base, 'skills/computer-use/SKILL.md'))).digest('hex'));
  });
});

describe('persistent Computer Use JavaScript lifecycle', () => {
  let repl: SkyRepl, control: any;
  beforeEach(() => { control = { invalidateSky: jest.fn(), skyCall: jest.fn(async (_session: string, method: string) => method === 'list_windows' ? [{ id: 1, app: 'Fixture.exe' }] : undefined) }; repl = new SkyRepl(control); });
  afterEach(() => repl.dispose());
  const context = (sessionId = 'one') => ({ sessionId, signal: new AbortController().signal } as any);
  it('runs the original initialization, preserves globals and isolates conversations', async () => {
    const init = 'if (!globalThis.sky) { const { sky } = await import("@oai/sky"); globalThis.sky = sky; }';
    expect((await repl.run(init, context())).success).toBe(true);
    expect((await repl.run('globalThis.windows = await sky.list_windows(); nodeRepl.write(JSON.stringify(windows));', context())).output).toContain('Fixture.exe');
    expect((await repl.run('nodeRepl.write(typeof windows);', context('two'))).output).toBe('undefined');
    repl.reset('one'); expect((await repl.run('nodeRepl.write(typeof sky);', context())).output).toBe('undefined');
  });
  it('limits a cell to one input and cancels a waiting cell on removal', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    const two = await repl.run('await sky.click({}); await sky.type_text({text:"x"});', context()); expect(two.success).toBe(false); expect(control.skyCall).toHaveBeenCalledTimes(1);
    expect(two.data).toMatchObject({ observationComplete: false, inputReceipts: [{ method: 'click', outcome: 'delivered' }, { method: 'type_text', outcome: 'not_started' }] });
    expect(two.error).toContain('this error did not undo it');
    expect(control.invalidateSky).toHaveBeenCalledWith('one', true);
    const pending = repl.run('await new Promise(resolve => setTimeout(resolve, 30000));', context()); repl.dispose(); expect((await pending).success).toBe(false);
  });
  it('reports a delivered type even if the following observation fails, without replaying it', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    control.skyCall.mockImplementation(async (_session: string, method: string) => { if (method === 'get_window_state') throw new Error('fixture capture failed'); });
    const result = await repl.run('await sky.type_text({text:"文宇"}); await sky.get_window_state({});', context());
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ inputReceipts: [{ method: 'type_text', outcome: 'delivered' }], observationComplete: false });
    expect(control.skyCall.mock.calls.filter((c: any[]) => c[1] === 'type_text')).toHaveLength(1);
  });
  it('records the combined input observation and preserves delivery on its failure', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    control.skyCall.mockResolvedValue({ observationComplete: true });
    const result = await repl.run('await sky.click({return_state:true});', context());
    expect(result.data).toMatchObject({ observationComplete: true, inputReceipts: [{ method: 'click', outcome: 'delivered' }] });
    control.skyCall.mockRejectedValue(new DesktopInputObservationError('post-action capture failed'));
    const failed = await repl.run('await sky.type_text({text:"once",return_state:true});', context());
    expect(failed.success).toBe(false);
    expect(failed.data).toMatchObject({ observationComplete: false, inputReceipts: [{ method: 'type_text', outcome: 'delivered' }] });
  });
  it('does not present a pre-input screenshot as the result when post-input capture fails', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    let observations = 0;
    control.skyCall.mockImplementation(async (_session: string, method: string, _args: any, image: any) => {
      if (method === 'get_window_state') {
        if (++observations > 1) throw new Error('fixture capture failed');
        image({ screenshotId: 'before-input', base64: 'fixture' });
      }
    });
    const result = await repl.run('await sky.get_window_state({}); await sky.type_text({text:"文宇"}); await sky.get_window_state({});', context());
    expect(result.data).toMatchObject({ inputReceipts: [{ method: 'type_text', outcome: 'delivered' }], observationComplete: false });
    expect(result.data).not.toHaveProperty('visualObservation');
  });
  it('reports a caught second-input rejection as failure and preserves the delivered select-all', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    const result = await repl.run('try { await sky.press_key({key:"Control_L+a"}); await sky.press_key({key:"Delete"}); } catch(e) { nodeRepl.write("caught"); }', context());
    expect(result.success).toBe(false); expect(result.error).toContain('additional input was not started');
    expect(result.error).toContain('this error did not undo it');
    expect(result.data).toMatchObject({ inputReceipts: [{ method: 'press_key', outcome: 'delivered' }, { method: 'press_key', outcome: 'not_started' }] });
  });
  it('marks a rejected duplicate as not started rather than unknown or delivered', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    control.skyCall.mockRejectedValue(Object.assign(new Error('Repeated text insertion was not started'), { code: 'DESKTOP_INPUT_NOT_STARTED' }));
    const result = await repl.run('await sky.type_text({text:"文宇"});', context());
    expect(result.data).toMatchObject({ inputReceipts: [{ method: 'type_text', outcome: 'not_started' }], observationComplete: false });
  });
  it('does not label a failed input attempt as delivered or roll it back', async () => {
    await repl.run('globalThis.sky = (await import("@oai/sky")).sky;', context());
    control.skyCall.mockRejectedValue(new Error('partial input fixture'));
    const result = await repl.run('await sky.type_text({text:"文宇"});', context());
    expect(result.data).toMatchObject({ inputReceipts: [{ method: 'type_text', outcome: 'unknown' }], observationComplete: false });
    expect(control.skyCall).toHaveBeenCalledTimes(1);
  });
});
