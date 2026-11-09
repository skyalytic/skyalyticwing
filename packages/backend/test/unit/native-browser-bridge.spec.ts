import 'reflect-metadata';
import { NativeBrowserBridge } from '../../src/modules/browser/native-browser-bridge.js';
import { BuiltInBrowserService } from '../../src/modules/browser/browser.service.js';
const owner = 'test-native-owner-000001';
describe('native browser bridge', () => {
  afterEach(() => jest.useRealTimers());
  it('requires a live host and rejects stale or foreign owners', async () => {
    jest.useFakeTimers();
    const b = new NativeBrowserBridge();
    await expect(b.request('s', 'snapshot')).rejects.toThrow('未连接');
    b.connect(owner);
    expect(() => b.connect('other-native-owner-000')).toThrow('已有活动连接');
    expect(() => b.poll('wrong')).toThrow('已失效');
    jest.advanceTimersByTime(5001);
    await expect(b.request('s', 'snapshot')).rejects.toThrow('未连接');
  });
  it('delivers each command once, returns results and separates session status', async () => {
    const b = new NativeBrowserBridge();
    b.connect(owner);
    const task = b.request('s1', 'navigate', { url: 'https://www.baidu.com/' });
    const { commands } = b.poll(owner, { s1: { activePageId: 'p1' }, s2: { activePageId: 'p2' } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ sessionId: 's1', op: 'navigate' });
    expect(b.poll(owner).commands).toHaveLength(0);
    expect(b.state('s2').activePageId).toBe('p2');
    expect(b.finish(owner, commands[0].id, {}).accepted).toBe(false);
    expect(b.claim(owner, commands[0].id).allowed).toBe(true);
    expect(b.claim(owner, commands[0].id).allowed).toBe(false);
    b.finish(owner, commands[0].id, { pageId: 'p1' });
    await expect(task).resolves.toEqual({ pageId: 'p1' });
    expect(b.finish(owner, commands[0].id, {}).accepted).toBe(false);
  });
  it('takeover cancels queued operations and rejects late results', async () => {
    const b = new NativeBrowserBridge();
    b.connect(owner);
    const task = b.request('s', 'click', { index: 1 });
    const pending = expect(task).rejects.toThrow('接管');
    const c = b.poll(owner).commands[0];
    b.cancel('s');
    await pending;
    expect(b.claim(owner, c.id).allowed).toBe(false);
    expect(b.finish(owner, c.id, {}).accepted).toBe(false);
  });
  it('a disconnected command times out instead of hanging indefinitely', async () => {
    jest.useFakeTimers();
    const b = new NativeBrowserBridge();
    b.connect(owner);
    const task = b.request('s', 'snapshot');
    const check = expect(task).rejects.toThrow('响应超时');
    jest.advanceTimersByTime(24001);
    await check;
    expect(b.poll(owner).commands).toHaveLength(0);
  });
  it('bounds a short read wait and refuses its late command result', async () => {
    jest.useFakeTimers();
    const bridge = new NativeBrowserBridge();
    bridge.connect(owner);
    const task = bridge.request('s', 'snapshot', { screenshot: false }, 100);
    const check = expect(task).rejects.toThrow('响应超时');
    const command = bridge.poll(owner).commands[0];
    jest.advanceTimersByTime(101);
    await check;
    expect(bridge.claim(owner, command.id).allowed).toBe(false);
    expect(bridge.finish(owner, command.id, {}).accepted).toBe(false);
  });
  it('AI observation cannot be reused, moved across tabs, or acted on after a change', async () => {
    const root = new BuiltInBrowserService(),
      service = root.forSession('s');
    root.native.enabled = true;
    const page = {
      pageId: 'p1',
      documentId: 'doc1',
      url: 'https://example.com/',
      elements: [],
      consoleTail: [],
      viewport: { width: 1000, height: 600 },
      screenshot: '',
      title: 'test',
    };
    const request = jest
      .spyOn(root.native, 'request')
      .mockImplementation(async () => ({ ...page }) as never);
    const first = await service.snapshot();
    await service.assertObservation('p1', first.observationId);
    await expect(service.assertObservation('p1', first.observationId)).rejects.toThrow(
      'expired or consumed',
    );
    const second = await service.snapshot();
    page.documentId = 'doc2';
    await expect(service.assertObservation('p1', second.observationId)).rejects.toThrow(
      'page changed',
    );
    const third = await service.snapshot();
    await expect(service.assertObservation('p2', third.observationId)).rejects.toThrow(
      'expired or consumed',
    );
    request.mockRestore();
  });
});
