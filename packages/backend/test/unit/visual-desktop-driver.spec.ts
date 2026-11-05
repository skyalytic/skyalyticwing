import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { VisualDesktopDriver, visualPointToScreen } from '../../src/modules/automation/visual-desktop-driver';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

describe('visual screenshot coordinates', () => {
  const image = { width: 960, height: 540, originalWidth: 1920, originalHeight: 1080, originX: -1920, originY: 80 };
  it('maps resized cropped screenshots to physical pixels, including a negative monitor origin', () => {
    expect(visualPointToScreen({ x: 480, y: 270 }, image)).toEqual({ x: -960, y: 620 });
    expect(visualPointToScreen({ x: 959.9, y: 539.9 }, image)).toEqual({ x: -1, y: 1159 });
  });
  it('rejects image-edge, non-finite, negative and malformed image coordinates', () => {
    for (const point of [{ x: 960, y: 0 }, { x: -1, y: 0 }, { x: 0, y: Infinity }, { x: NaN, y: 10 }]) expect(() => visualPointToScreen(point, image)).toThrow();
    expect(() => visualPointToScreen({ x: 1, y: 1 }, { ...image, height: 0 })).toThrow();
  });
});

describe('visual native transport without executing desktop actions', () => {
  let driver: VisualDesktopDriver;
  let child: any;
  let requests: any[];
  let respond: (request: any) => unknown;
  const root = { rootRef: 'visual:901:42', windowId: 901, pid: 42, title: 'Fixture', bounds: { x: -700, y: 20, width: 600, height: 400 } };
  beforeEach(() => {
    requests = []; respond = () => ({ performed: true });
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = jest.fn();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line); requests.push(request); const result = respond(request);
        if (result !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n'));
      }
      callback();
    } });
    (spawn as jest.Mock).mockReset().mockReturnValue(child);
    driver = new VisualDesktopDriver(); (driver as any).platform = 'win32'; jest.spyOn(driver, 'available').mockReturnValue(true);
    driver.setInputMode('physical');
    jest.spyOn(driver as any, 'compile').mockResolvedValue('fixture-native-helper.exe');
  });
  afterEach(() => { driver.dispose(); child.emit('exit', 0); jest.restoreAllMocks(); });
  it('uses a hidden asynchronous helper and preserves stable HWND/PID plus physical coordinates', async () => {
    await driver.input(root, { kind: 'click', x: -200, y: 90 });
    expect(spawn).toHaveBeenCalledWith('fixture-native-helper.exe', [], expect.objectContaining({ windowsHide: true }));
    expect(requests[0]).toMatchObject({ command: 'input', inputMode: 'physical', root, action: { kind: 'click', x: -200, y: 90 } });
  });
  it('prevents repeated query appends despite nearby re-clicks, but allows result clicks and intentional replacement', async () => {
    await driver.input(root, { kind: 'click', x: -200, y: 90 });
    await driver.input(root, { kind: 'typeText', params: { text: '文宇' } });
    await driver.capture(root);
    await driver.input(root, { kind: 'click', x: -210, y: 90 });
    const before = requests.length;
    await expect(driver.input(root, { kind: 'typeText', params: { text: '文宇' } })).rejects.toMatchObject({ code: 'DESKTOP_INPUT_NOT_STARTED' });
    expect(requests).toHaveLength(before);
    await driver.input(root, { kind: 'click', x: -210, y: 180 }); // a returned result can be selected immediately
    await driver.input(root, { kind: 'typeText', params: { text: '文宇' } });
    await driver.input(root, { kind: 'keypress', params: { key: 'Ctrl+A' } });
    await driver.input(root, { kind: 'typeText', params: { text: '文宇' } });
    expect(requests.filter(r => r.action?.kind === 'typeText')).toHaveLength(3);
  });
  it('does not treat select-all followed by another click as a cleared field', async () => {
    await driver.input(root, { kind: 'click', x: -200, y: 90 });
    await driver.input(root, { kind: 'typeText', params: { text: '文宇' } });
    await driver.input(root, { kind: 'keypress', params: { key: 'Ctrl+A' } });
    await driver.input(root, { kind: 'click', x: -200, y: 90 });
    await expect(driver.input(root, { kind: 'typeText', params: { text: '文宇' } })).rejects.toMatchObject({ code: 'DESKTOP_INPUT_NOT_STARTED' });
    await driver.input(root, { kind: 'keypress', params: { key: 'Escape' } });
    await expect(driver.input(root, { kind: 'typeText', params: { text: '文宇' } })).rejects.toThrow('not started');
    await driver.input(root, { kind: 'keypress', params: { key: 'Ctrl+A' } });
    await driver.input(root, { kind: 'keypress', params: { key: 'Delete' } });
    await driver.input(root, { kind: 'click', x: -200, y: 90 });
    await driver.input(root, { kind: 'typeText', params: { text: '文宇' } });
    expect(requests.filter(r => r.action?.kind === 'typeText')).toHaveLength(2);
  });
  it('does not let a failed observation erase an attempted text entry', async () => {
    await driver.input(root, { kind: 'typeText', params: { text: 'same query' } });
    await driver.inspectWindow(root);
    await expect(driver.input(root, { kind: 'typeText', params: { text: 'same query' } })).rejects.toThrow('not started');
    await driver.input({ ...root, pid: 99 }, { kind: 'typeText', params: { text: 'same query' } });
    expect(requests.filter(r => r.action?.kind === 'typeText')).toHaveLength(2);
  });
  it('allows rendering before the next screenshot and cancels that wait on stop', async () => {
    await driver.input(root, { kind: 'typeText', params: { text: 'render' } });
    const at = Date.now(); await driver.capture(root);
    expect(Date.now() - at).toBeGreaterThanOrEqual(170);
    await driver.input(root, { kind: 'keypress', params: { key: 'Tab' } });
    const capture = driver.capture(root); driver.dispose();
    await expect(capture).rejects.toThrow('cancelled');
    expect(requests.filter(r => r.command === 'capture')).toHaveLength(1);
  });
  it('rejects malformed pointer input without starting any process', async () => {
    await expect(driver.input(root, { kind: 'click', x: NaN, y: 10 })).rejects.toThrow('finite');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('retains unresized image geometry and cursor metadata returned by the native capture', async () => {
    const capture = { base64: 'fixture', width: 600, height: 400, originX: -700, originY: 20, bounds: root.bounds, cursor: { x: -300, y: 88, visible: true } };
    respond = () => capture;
    expect(await driver.capture(root)).toEqual(capture);
  });
  it('uses visible composition for physical window observations, not the isolated WGC parent surface', async () => {
    const capture = { base64: 'composed-popup', width: 720, height: 400, originX: -720, originY: 20, bounds: root.bounds, foregroundWindowId: 902 };
    respond = () => capture;
    expect(await driver.captureWindow(root)).toEqual(capture);
    expect(requests.map(r => r.command)).toEqual(['capture']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('fixture-native-helper.exe', [], expect.anything());
  });
  it('defaults to real input and rejects obsolete virtual commands without starting a helper', () => {
    expect(new VisualDesktopDriver().getInputMode()).toBe('physical');
    expect(() => driver.setInputMode('virtual' as any)).toThrow('Only physical');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('validates one selected handle instead of enumerating unrelated applications', async () => {
    respond = () => ({ ...root, foregroundWindowId: 901 });
    expect(await driver.inspectWindow(root)).toMatchObject(root);
    expect(requests.map(r => r.command)).toEqual(['inspect_window']);
  });
  it('forwards user stop events once and does not implicitly restart when stopping an unused overlay', async () => {
    await driver.stopOverlay(); expect(spawn).not.toHaveBeenCalled();
    const stop = jest.fn(); const unsubscribe = driver.onStop(stop);
    await driver.startOverlay({ title: 'Test control' });
    child.stdout.write('{"event":"stop","reason":"user"}\n');
    expect(stop).toHaveBeenCalledTimes(1); unsubscribe(); child.stdout.write('{"event":"stop"}\n'); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('cancels an active native operation through the separate reader before retiring the helper', async () => {
    respond = () => undefined; const abort = new AbortController();
    const active = driver.input(root, { kind: 'typeText', params: { text: '中文' } }, { signal: abort.signal });
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    abort.abort(); await expect(active).rejects.toThrow('stopped');
    expect(requests.some(request => request.command === 'cancel')).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('rejects unsupported platforms explicitly without spawning a bridge', async () => {
    jest.spyOn(driver, 'available').mockReturnValue(false);
    await expect(driver.listWindows()).rejects.toThrow('does not support'); expect(spawn).not.toHaveBeenCalled();
  });
  it('runs the read-only native handshake without overlay, capture or input and retires its helper', async () => {
    respond = () => ({ protocolVersion: 1, platform: 'win32' });
    expect(await driver.readOnlySelfTest()).toEqual({ protocolVersion: 1, platform: 'win32' });
    expect(requests.map(request => request.command)).toEqual(['ping', 'cancel']);
  });
  it('never starts a replacement helper when an overlay-stop was queued before native exit', async () => {
    respond = () => undefined;
    const input = driver.input(root, { kind: 'typeText', params: { text: 'fixture' } });
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const stopping = driver.stopOverlay();
    child.emit('exit', 1);
    await expect(input).rejects.toThrow('helper exited');
    expect(await stopping).toEqual({ visible: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(requests.map(request => request.command)).toEqual(['input']);
  });
  it('handles a closed native stdin pipe without an unhandled stream error or restarting on stop', async () => {
    respond = () => undefined;
    const input = driver.input(root, { kind: 'typeText', params: { text: 'fixture' } });
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    expect(() => child.stdin.emit('error', new Error('EPIPE fixture'))).not.toThrow();
    await expect(input).rejects.toThrow('EPIPE');
    expect(await driver.stopOverlay()).toEqual({ visible: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});


describe.each(['darwin', 'linux'])('%s helper transport (no desktop interaction)', platform => {
  let driver: VisualDesktopDriver;
  let child: any;
  let request: any;
  let response: any;
  beforeEach(() => {
    driver = new VisualDesktopDriver(); (driver as any).platform = platform;
    response = { ok: true, result: { protocolVersion: 1, platform } };
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = jest.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true; });
    child.stdin = new Writable({ write(chunk, _encoding, callback) { request = JSON.parse(chunk.toString()); callback(); }, final(callback) {
      callback(); if (!response) return;
      queueMicrotask(() => { child.emit('exit', 0); child.stdout.write(JSON.stringify(response)); child.emit('close', 0); });
    } });
    (spawn as jest.Mock).mockReset().mockReturnValue(child);
  });
  afterEach(() => driver.dispose());
  it('waits for drained stdout, uses Python directly and defaults to real input', async () => {
    await expect(driver.readOnlySelfTest()).resolves.toEqual({ protocolVersion: 1, platform });
    expect(request).toMatchObject({ command: 'ping', inputMode: 'physical' });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['-c', expect.any(String)], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    expect((spawn as jest.Mock).mock.calls[0][2].shell).toBeUndefined();
  });
  it('surfaces missing permission/Wayland failures without starting a fallback', async () => {
    response = { ok: false, error: 'Permission or Wayland portal unavailable' };
    await expect(driver.listWindows()).rejects.toThrow('portal unavailable');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(driver.getInputMode()).toBe('physical');
  });
  it('cancels pending work when the user stops', async () => {
    response = undefined;
    const pending = driver.listWindows();
    await Promise.resolve(); await Promise.resolve();
    driver.dispose();
    await expect(pending).rejects.toThrow(/stopped|cancelled/i);
    expect(child.kill).toHaveBeenCalled();
  });
});
