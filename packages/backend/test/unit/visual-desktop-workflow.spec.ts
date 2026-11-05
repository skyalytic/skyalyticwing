import 'reflect-metadata';
import sharp from 'sharp';
import { VisualDesktopWorkflow, imagePointToScreen, visualPixelsChanged } from '../../src/modules/automation/visual-desktop-workflow';
import { DesktopControlService } from '../../src/extensions/bundled/computer-use/runtime/desktop-control.service';
import { DesktopControlController } from '../../src/modules/automation/desktop-control.controller';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation';

describe('visual desktop workflow without native input', () => {
  let png: string;
  let driver: any, uia: any, control: DesktopControlService, nativeStop: () => void;
  const root = { rootRef: 'visual:91:23', windowId: 91, pid: 23, title: 'Test window', bounds: { x: -1920, y: 100, width: 3200, height: 1800 } };
  beforeAll(async () => { png = (await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#123456' } }).png().toBuffer()).toString('base64'); });
  beforeEach(() => {
    driver = {
      available: () => true, listWindows: jest.fn(async () => [structuredClone(root)]), focus: jest.fn(async () => ({})),
      capture: jest.fn(async () => ({ base64: png, width: 3200, height: 1800, originX: -1920, originY: 100, bounds: { ...root.bounds } })),
      input: jest.fn(async () => ({ performed: true })), startOverlay: jest.fn(async () => ({})), stopOverlay: jest.fn(async () => ({})), dispose: jest.fn(),
      onStop: jest.fn(cb => { nativeStop = cb; return () => {}; }),
    };
    uia = { isAvailable: jest.fn(() => false), dispose: jest.fn(), look: jest.fn(), act: jest.fn() };
    control = new DesktopControlService(uia, driver);
  });
  afterEach(() => { control.onModuleDestroy(); ChatControlRegistry.markInactive('a'); ChatControlRegistry.markInactive('b'); ChatControlRegistry.clearAbort('a'); });
  async function observe() {
    expect((await control.execute('a', { action: 'list_windows' })).success).toBe(true);
    const result = await control.execute('a', { action: 'look', rootRef: root.rootRef });
    expect(result.success).toBe(true);
    return result;
  }
  it('uses the visual driver with no UIA bridge, and sends screenshot pixels to the model', async () => {
    const result = await observe();
    expect(uia.look).not.toHaveBeenCalled(); expect(driver.focus).toHaveBeenCalledWith(root);
    expect(control.status()).toMatchObject({ active: true, mode: 'visual', sessionId: 'a' });
    const data = result.data as any;
    expect(data.image).toEqual({ width: 1600, height: 900 });
    const model = visualObservation(result, 'gpt-4o', 'openai');
    expect(JSON.stringify(model.result)).not.toContain(png);
    expect(JSON.stringify(model.message)).toContain('无需换算');
  });
  it('observes the whole desktop directly and binds typing to its captured foreground', async () => {
    const desktop = { ...root, rootRef: 'desktop:0', windowId: 0, pid: 0 };
    driver.listWindows.mockResolvedValue([desktop]);
    driver.capture.mockResolvedValue({ base64: png, width: 3200, height: 1800, originX: -1920, originY: 100, bounds: root.bounds, foregroundWindowId: 777 });
    const shot = await control.execute('a', { action: 'screenshot' });
    expect(shot.success).toBe(true);
    const result = await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'typeText', params: { text: '你好' } });
    expect(result.success).toBe(true);
    expect(driver.input).toHaveBeenCalledWith({ ...desktop, foregroundWindowId: 777 }, { kind: 'typeText', params: { text: '你好' } });
    expect(uia.act).not.toHaveBeenCalled();
  });
  it('does not claim actionPerformed when the native adapter rejects delivery', async () => {
    const shot = await observe(); driver.input.mockResolvedValue({ performed: false });
    const result = await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'click', targetX: 8, targetY: 9 });
    expect(result.success).toBe(false);
    expect(result.data).not.toMatchObject({ actionPerformed: true });
  });
  it('follows an app opened on another display instead of repeatedly showing the taskbar display', async () => {
    const primary = { ...root, rootRef: 'desktop:0', windowId: 0, pid: 0, isForeground: true };
    const secondary = { ...root, rootRef: 'desktop:1', windowId: -1, pid: 0, isForeground: false, bounds: { ...root.bounds, x: 1280 } };
    driver.listWindows.mockImplementation(async () => [primary, secondary]);
    driver.capture.mockImplementation(async (r: any) => ({ base64: png, width: 3200, height: 1800, originX: r.bounds.x, originY: r.bounds.y, bounds: r.bounds }));
    driver.input.mockImplementation(async () => { primary.isForeground = false; secondary.isForeground = true; return { performed: true }; });
    const first = await control.execute('a', { action: 'screenshot' });
    expect(first.data).toMatchObject({ target: { rootRef: 'desktop:0' } });
    const after = await control.execute('a', { action: 'act', screenshotId: (first.data as any).screenshotId, kind: 'click', targetX: 10, targetY: 10 });
    expect(after.success).toBe(true);
    expect(after.data).toMatchObject({ target: { rootRef: 'desktop:1' }, displayChanged: true });
    expect(driver.capture.mock.calls.at(-1)[0]).toMatchObject({ windowId: -1, bounds: secondary.bounds });
  });
  it('stops replaying the same ineffective click and supplies a fresh image for another target', async () => {
    let shot = await observe();
    for (let i = 0; i < 2; i++) {
      shot = await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'click', targetX: 9, targetY: 9 });
      expect(shot.success).toBe(true);
      expect(shot.data).toMatchObject({ visualChange: 'none' });
    }
    shot = await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'click', targetX: 9, targetY: 9 });
    expect(shot.success).toBe(false);
    expect(shot.data).toMatchObject({ actionPerformed: false, verification: 'unchanged' });
    expect(driver.input).toHaveBeenCalledTimes(2);
    expect((await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'click', targetX: 10, targetY: 9 })).success).toBe(true);
    expect(driver.input).toHaveBeenCalledTimes(3);
  });
  it('keeps a non-activating tray popup on the clicked display', async () => {
    const primary = { ...root, rootRef: 'desktop:0', windowId: 0, pid: 0, isForeground: false };
    const secondary = { ...root, rootRef: 'desktop:1', windowId: -1, pid: 0, isForeground: true, bounds: { ...root.bounds, x: 1280 } };
    const app = { ...secondary, rootRef: 'visual:888:22', windowId: 888, pid: 22, processName: 'ExampleApp', bounds: { x: 1380, y: 200, width: 800, height: 600 } };
    driver.listWindows.mockResolvedValue([primary, secondary, app]);
    driver.capture.mockImplementation(async (r: any) => ({ base64: png, width: r.bounds.width, height: r.bounds.height, originX: r.bounds.x, originY: r.bounds.y, bounds: r.bounds, foregroundWindowId: 888 }));
    await control.execute('a', { action: 'list_windows' });
    const shot = await control.execute('a', { action: 'screenshot', rootRef: 'desktop:0' });
    const after = await control.execute('a', { action: 'act', screenshotId: (shot.data as any).screenshotId, kind: 'click', targetX: 100, targetY: 100 });
    expect(after.data).toMatchObject({ target: { rootRef: 'desktop:0' }, displayChanged: false });
  });
  it('returns a precise app viewport after a desktop click, with correct coordinates for the next click', async () => {
    const desktop = { ...root, rootRef: 'desktop:0', windowId: 0, pid: 0, isForeground: true };
    const app = { ...root, windowId: 777, pid: 22, isForeground: true, processName: 'ExampleApp', bounds: { x: -1800, y: 200, width: 800, height: 600 } };
    driver.listWindows.mockResolvedValue([desktop, app]);
    const first = await control.execute('a', { action: 'screenshot' });
    const after = await control.execute('a', { action: 'act', screenshotId: (first.data as any).screenshotId, kind: 'click', targetX: 50, targetY: 50 });
    expect(after.success).toBe(true);
    expect(after.data).toMatchObject({ image: { width: 800, height: 600 }, viewport: app.bounds });
    const next = await control.execute('a', { action: 'act', screenshotId: (after.data as any).screenshotId, kind: 'click', targetX: 20, targetY: 30 });
    expect(next.success).toBe(true);
    expect(driver.input.mock.calls.at(-1)[1]).toEqual({ kind: 'click', x: -1780, y: 230, params: {} });
  });
  it('maps a native-resolution crop back to the screen without model-side scaling', async () => {
    const initial = await observe();
    const cropped = await control.execute('a', { action: 'zoom', screenshotId: (initial.data as any).screenshotId, region: { x: 100, y: 50, width: 200, height: 100 } });
    expect(cropped.success).toBe(true);
    expect(cropped.data).toMatchObject({ image: { width: 1200, height: 600 } });
    const clicked = await control.execute('a', { action: 'act', screenshotId: (cropped.data as any).screenshotId, kind: 'click', targetX: 60, targetY: 90 });
    expect(clicked.success).toBe(true);
    expect(driver.input).toHaveBeenCalledWith(root, { kind: 'click', x: -1700, y: 230, params: {} });
    expect((await control.execute('a', { action: 'zoom', screenshotId: (initial.data as any).screenshotId, region: { x: 0, y: 0, width: 100, height: 100 } })).success).toBe(false);
  });
  it('handles negative screen origin and resizing on the server, then observes the result', async () => {
    const o = (await observe()).data as any;
    const result = await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 });
    expect(result.success).toBe(true);
    expect(driver.input).toHaveBeenCalledWith(root, { kind: 'click', x: -1760, y: 300, params: {} });
    expect(driver.capture).toHaveBeenCalledTimes(2); expect(driver.startOverlay).toHaveBeenCalledTimes(1);
    expect((await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 })).success).toBe(false);
    expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('refreshes a moved target without reusing its old coordinates', async () => {
    const o = (await observe()).data as any;
    driver.listWindows.mockResolvedValue([{ ...root, bounds: { ...root.bounds, x: -1800 } }]);
    const result = await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 });
    expect(result.success).toBe(true); expect(result.data).toMatchObject({ actionPerformed: false, verification: 'refreshed' });
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('refreshes an expired observation instead of sending an old click', async () => {
    const o = (await observe()).data as any;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      const result = await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 });
      expect(result.data).toMatchObject({ actionPerformed: false }); expect(driver.input).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('uses geometry from the actual capture when the window moved during observation', async () => {
    driver.capture.mockResolvedValueOnce({ base64: png, width: 3200, height: 1800, originX: -1800, originY: 100, bounds: { ...root.bounds, x: -1800 } });
    const o = (await observe()).data as any;
    expect(o.target.bounds.x).toBe(-1800);
    // Window moved back to its former position after the capture.
    const result = await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 });
    expect(result.data).toMatchObject({ actionPerformed: false, verification: 'refreshed' });
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('invalidates old visual observations when switching through UIA mode', async () => {
    const o = (await observe()).data as any;
    uia.isAvailable.mockReturnValue(true);
    uia.listRoots = jest.fn(async () => ({ roots: [root] }));
    expect((await control.execute('a', { action: 'list_windows', mode: 'uia' })).success).toBe(true);
    expect(driver.dispose).toHaveBeenCalled();
    const result = await control.execute('a', { action: 'act', mode: 'visual', screenshotId: o.screenshotId, kind: 'click', targetX: 80, targetY: 100 });
    expect(result.success).toBe(false); expect(driver.input).not.toHaveBeenCalled();
    await observe();
  });
  it('wait_for accepts a root without lookId and does not invent a text match', async () => {
    await control.execute('a', { action: 'list_windows' });
    const result = await control.execute('a', { action: 'wait_for', rootRef: root.rootRef, text: '通讯录', timeoutMs: 0 });
    expect(result.success).toBe(true); expect(result.data).toMatchObject({ requestedCondition: '通讯录', verification: 'needs_review' });
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('executes click/type/key in order without asking the model for another screenshot id', async () => {
    const o = (await observe()).data as any;
    const result = await control.execute('a', { action: 'act_batch', screenshotId: o.screenshotId, steps: [{ kind: 'click', targetX: 10, targetY: 20 }, { kind: 'typeText', params: { text: '联系人' } }, { kind: 'keypress', params: { key: 'Enter' } }] });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ batch: { completed: 3, total: 3, replay: false } });
    expect(driver.input.mock.calls.map((call: any) => call[1].kind)).toEqual(['click', 'typeText', 'keypress']);
    expect((result.data as any).visualObservation.base64).toBeTruthy();
    expect((await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'keypress', params: { key: 'Enter' } })).success).toBe(false);
    expect(driver.input).toHaveBeenCalledTimes(3);
  });
  it('rejects an invalid later step before executing any part of the batch', async () => {
    const o = (await observe()).data as any;
    const result = await control.execute('a', { action: 'act_batch', screenshotId: o.screenshotId, steps: [{ kind: 'typeText', params: { text: 'hello' } }, { kind: 'click', targetX: -1, targetY: 10 }] });
    expect(result.success).toBe(false); expect(driver.input).not.toHaveBeenCalled();
  });
  it('stops a batch after foreground changes rather than typing into the new app', async () => {
    let foregroundWindowId = 91;
    driver.capture.mockImplementation(async () => ({ base64: png, width: 3200, height: 1800, originX: -1920, originY: 100, bounds: root.bounds, foregroundWindowId }));
    const o = (await observe()).data as any;
    driver.input.mockImplementation(async () => { foregroundWindowId = 999; return { performed: true }; });
    const result = await control.execute('a', { action: 'act_batch', screenshotId: o.screenshotId, steps: [{ kind: 'click', targetX: 10, targetY: 20 }, { kind: 'typeText', params: { text: 'private' } }] });
    expect(result.success).toBe(false); expect(result.data).toMatchObject({ batch: { completed: 1, stoppedAt: 1 } });
    expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('returns a fresh image on uncertain native delivery and never retries the input', async () => {
    const o = (await observe()).data as any; driver.input.mockRejectedValueOnce(new Error('native timeout'));
    const result = await control.execute('a', { action: 'act_batch', screenshotId: o.screenshotId, steps: [{ kind: 'keypress', params: { key: 'Enter' } }, { kind: 'typeText', params: { text: 'duplicate' } }] });
    expect(result.success).toBe(false); expect(result.data).toMatchObject({ actionPerformed: 'unknown', batch: { completed: 0, stoppedAt: 0 } });
    expect((result.data as any).visualObservation.base64).toBeTruthy(); expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('user stop interrupts a batch before its remaining input', async () => {
    const o = (await observe()).data as any;
    driver.input.mockImplementationOnce(async () => { control.pause(); return { performed: true }; });
    const result = await control.execute('a', { action: 'act_batch', screenshotId: o.screenshotId, steps: [{ kind: 'click', targetX: 10, targetY: 20 }, { kind: 'typeText', params: { text: 'no' } }] });
    expect(result.success).toBe(false); expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('waits for visual change without claiming the requested text was recognized', async () => {
    const o = (await observe()).data as any;
    const changed = (await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64');
    driver.capture.mockResolvedValue({ base64: changed, width: 3200, height: 1800, originX: -1920, originY: 100, bounds: root.bounds });
    const result = await control.execute('a', { action: 'wait_for', screenshotId: o.screenshotId, condition: 'changed', text: '联系人', timeoutMs: 300 });
    expect(result.success).toBe(true); expect(result.data).toMatchObject({ conditionScope: 'pixels', matched: true, timedOut: false, verification: 'needs_review' });
    expect(driver.input).not.toHaveBeenCalled();
  });
  it('times out an unchanged screen with an inspectable screenshot and no input', async () => {
    await observe();
    const result = await control.execute('a', { action: 'wait_for', condition: 'changed', timeoutMs: 10 });
    expect(result.success).toBe(false); expect(result.data).toMatchObject({ matched: false, timedOut: true });
    expect((result.data as any).visualObservation.base64).toBeTruthy(); expect(driver.input).not.toHaveBeenCalled();
  });
  it('recognizes a stable screen only after polling, and rejects stale region coordinates', async () => {
    const o = (await observe()).data as any;
    const result = await control.execute('a', { action: 'wait_for', condition: 'stable', timeoutMs: 1500 });
    expect(result.success).toBe(true); expect(result.data).toMatchObject({ matched: true });
    expect(driver.capture.mock.calls.length).toBeGreaterThanOrEqual(4);
    const stale = await control.execute('a', { action: 'wait_for', condition: 'changed', screenshotId: o.screenshotId, region: { x: 0, y: 0, width: 100, height: 100 } });
    expect(stale.success).toBe(false); expect(driver.input).not.toHaveBeenCalled();
  });
  it('ignores isolated cursor pixels but detects substantial visual changes', () => {
    const a = Buffer.alloc(96 * 96, 10), b = Buffer.from(a); b[10] = 255;
    expect(visualPixelsChanged(a, b)).toBe(false);
    b.fill(200, 50, 150); expect(visualPixelsChanged(a, b)).toBe(true);
  });
  it('does not send any input after stop and only resumes through the local control', async () => {
    const o = (await observe()).data as any;
    nativeStop();
    expect(control.status()).toMatchObject({ active: false, paused: true }); expect(driver.dispose).toHaveBeenCalled();
    expect((await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'click', targetX: 1, targetY: 1 })).success).toBe(false);
    expect((await control.execute('a', { action: 'resume' })).success).toBe(false); expect(driver.input).not.toHaveBeenCalled();
    control.resume(); await observe(); expect(driver.startOverlay).toHaveBeenCalledTimes(2);
  });
  it('keeps another conversation from replacing the desktop owner or stopping it', async () => {
    await observe();
    expect((await control.execute('b', { action: 'list_windows' })).success).toBe(false);
    expect((await control.execute('b', { action: 'pause' })).success).toBe(false);
    ChatControlRegistry.requestAbort('b');
    expect(control.status()).toMatchObject({ active: true, paused: false, sessionId: 'a' });
    const api = new DesktopControlController(control as any);
    expect(() => api.stop({ sessionId: 'b' })).toThrow('桌面控制会话已改变');
  });
  it('normal completion hides the overlay and releases the desktop for another conversation', async () => {
    ChatControlRegistry.markActive('a'); await observe(); ChatControlRegistry.markInactive('a');
    expect(control.status()).toMatchObject({ active: false, paused: false }); expect(driver.stopOverlay).toHaveBeenCalled();
    expect((await control.execute('b', { action: 'list_windows' })).success).toBe(true);
  });
  it('does not report completion or replay input when the following screenshot fails', async () => {
    const o = (await observe()).data as any; driver.capture.mockRejectedValueOnce(new Error('capture failed'));
    const args = { action: 'act', screenshotId: o.screenshotId, kind: 'typeText', params: { text: '测试' } };
    const result = await control.execute('a', args);
    expect(result.success).toBe(false); expect(result.error).toContain('输入已发出');
    expect(result.data).toMatchObject({ actionPerformed: true, observationComplete: false, inputReceipt: { outcome: 'delivered', replay: false } });
    expect((await control.execute('a', args)).success).toBe(false); expect(driver.input).toHaveBeenCalledTimes(1);
    await observe();
    expect(driver.startOverlay.mock.calls.length).toBeGreaterThan(1);
  });
  it('counts delivered batch input even when all subsequent captures fail', async () => {
    const observed = (await observe()).data as any;
    driver.capture.mockRejectedValue(new Error('capture unavailable'));
    const result = await control.execute('a', { action: 'act_batch', screenshotId: observed.screenshotId,
      steps: [{ kind: 'typeText', params: { text: '只输入一次' } }, { kind: 'keypress', params: { key: 'Enter' } }] });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ inputReceipt: { outcome: 'delivered', replay: false }, batch: { completed: 1, total: 2, stoppedAt: 0 } });
    expect(driver.input).toHaveBeenCalledTimes(1);
  });
  it('converts drag endpoints and refuses out-of-image coordinates', async () => {
    const o = (await observe()).data as any;
    const result = await control.execute('a', { action: 'act', screenshotId: o.screenshotId, kind: 'drag', targetX: 20, targetY: 30, params: { toX: 100, toY: 60 } });
    expect(result.success).toBe(true); expect(driver.input).toHaveBeenCalledWith(root, { kind: 'drag', x: -1880, y: 160, params: { toX: -1720, toY: 220 } });
    expect(() => imagePointToScreen({ width: 1, height: 1, originalWidth: 2, originalHeight: 2, originX: 0, originY: 0 }, -1, 0)).toThrow();
  });
  it('interruption during a wait does not take a new screenshot or send input', async () => {
    await observe(); const before = driver.capture.mock.calls.length;
    const running = control.execute('a', { action: 'wait_for', rootRef: root.rootRef, timeoutMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 20)); control.pause();
    expect((await running).success).toBe(false); expect(driver.capture).toHaveBeenCalledTimes(before); expect(driver.input).not.toHaveBeenCalled();
  });
});
