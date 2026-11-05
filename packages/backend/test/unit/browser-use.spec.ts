import 'reflect-metadata';
import { BuiltInBrowserService, type BrowserSnapshot } from '../../src/modules/browser/browser.service';
import { sameBrowserTarget, browserConditionMatches, BrowserObservationError } from '../../src/modules/browser/browser-observation';
import { createBuiltinBrowserTools } from '../../src/extensions/bundled/browser/tools/builtin-browser';

function frame(): BrowserSnapshot {
  return { pageId: 'p1', documentId: 'doc1', url: 'https://fixture.test', title: 'Fixture',
    viewport: { width: 800, height: 600 }, screenshot: '', consoleTail: [], markedAt: Date.now(), readyState: 'complete', pageText: '加载中',
    elements: [
      { index: 1, tag: 'input', text: '文宇', hint: '搜索', rect: { x: 10, y: 10, w: 180, h: 30 } },
      { index: 2, tag: 'button', text: '提交', rect: { x: 200, y: 10, w: 80, h: 30 } },
    ] };
}
function nativeFixture() {
  const service = new BuiltInBrowserService();
  let current = frame();
  const request = jest.fn(async (_session: string, op: string, args: any) => op === 'snapshot' ? structuredClone(current) : {});
  Object.defineProperty(service, 'native', { value: { enabled: true, request, cancel: jest.fn() } });
  return { service, request, update: (f: (s: BrowserSnapshot) => void) => f(current) };
}
describe('Browser Use target, wait and delivery contracts', () => {
  it('does not infer that an element disappeared from a truncated list', () => {
    const observed = frame();
    observed.elements = [];
    observed.elementsTruncated = true;
    expect(browserConditionMatches(observed, { condition: 'element', index: 1, state: 'hidden' })).toBe(false);
    observed.elementsTruncated = false;
    expect(browserConditionMatches(observed, { condition: 'element', index: 1, state: 'hidden' })).toBe(true);
  });
  it('ignores unrelated labels but rejects target edits, focus changes, navigation and moved coordinates', () => {
    const before = frame(), after = structuredClone(before);
    after.elements[1]!.text = '广告更新';
    expect(sameBrowserTarget(before, after, { index: 1 })).toBe(true);
    expect(sameBrowserTarget(before, after, { x: 10, y: 10 })).toBe(false);
    after.elements[0]!.text = '另一个人';
    expect(sameBrowserTarget(before, after, { index: 1 })).toBe(false);
    before.activeElement = before.elements[0]; after.activeElement = after.elements[1];
    expect(sameBrowserTarget(before, after, { action: 'type' })).toBe(false);
    after.documentId = 'doc2';
    expect(sameBrowserTarget(before, after, { index: 2 })).toBe(false);
  });
  it('validates a single-use target without recapturing a screenshot', async () => {
    const { service, request, update } = nativeFixture();
    const observed = await service.snapshot();
    update(s => { s.elements[1]!.text = '计时器变化'; });
    await service.assertObservation('p1', observed.observationId, { index: 1 });
    expect(request.mock.calls.at(-1)?.[2]).toMatchObject({ screenshot: false, waitForLoad: false });
    await expect(service.assertObservation('p1', observed.observationId, { index: 1 })).rejects.toThrow('consumed');
  });
  it('allows reading element details before input, but rejects invented element waits', async () => {
    const { service, update } = nativeFixture();
    const observed = await service.snapshot();
    await service.assertObservation('p1', observed.observationId, { action: 'element', index: 1 });
    await service.assertObservation('p1', observed.observationId, { action: 'fill', index: 1 });
    await expect(service.waitFor('p1', { condition: 'element', index: 999, state: 'hidden' })).rejects.toThrow('recent snapshot');
    const next = await service.snapshot();
    update(s => { s.elements = s.elements.filter(e => e.index !== 1); });
    expect((await service.waitFor('p1', { condition: 'element', index: 1, state: 'hidden', observationId: next.observationId })).matched).toBe(true);
  });
  it('polls actual text, returns fresh references, and times out without any input', async () => {
    const { service, request, update } = nativeFixture();
    const timer = setTimeout(() => update(s => { s.pageText = '联系人 文宇'; }), 20);
    try {
      const result = await service.waitFor('p1', { condition: 'text', text: '联系人 文宇', timeoutMs: 500 });
      expect(result.matched).toBe(true);
      expect(result.snapshot.observationId).toBeTruthy();
      expect((await service.waitFor('p1', { condition: 'url', url: 'https://other.test', timeoutMs: 0 })).timedOut).toBe(true);
      expect(request.mock.calls.every(c => c[1] === 'snapshot')).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it('cancellation and uninstall stop waits and do not close user-owned tabs', async () => {
    const { service, request } = nativeFixture();
    const controller = new AbortController();
    const work = service.runOperation('agent', () => service.waitFor('p1', { condition: 'text', text: 'never' }), false, { signal: controller.signal });
    controller.abort();
    await expect(work).rejects.toThrow('cancelled');
    const next = service.runOperation('agent', async () => { service.stopAgentOperations(); await service.snapshot(); });
    await expect(next).rejects.toThrow('cancelled');
    expect(request.mock.calls.every(c => c[1] !== 'close')).toBe(true);
  });
  it('keeps a delivered receipt when observation fails, with no replay', async () => {
    const { service, request } = nativeFixture();
    jest.spyOn(service, 'snapshot').mockRejectedValue(new Error('capture failed'));
    const failure = await service.action('p1', 'click', { index: 2 }).catch(e => e);
    expect(failure).toBeInstanceOf(BrowserObservationError);
    expect(failure.inputReceipt).toEqual({ outcome: 'delivered', replay: false });
    expect(request.mock.calls).toHaveLength(1);
  });
  it('also preserves delivery when a file was uploaded before observation failed', async () => {
    const { service, request } = nativeFixture();
    jest.spyOn(service, 'snapshot').mockRejectedValue(new Error('capture failed'));
    const failure = await service.upload('p1', 1, 'sample.txt', 'text/plain', 'aGk=').catch(e => e);
    expect(failure).toBeInstanceOf(BrowserObservationError);
    expect(failure.inputReceipt).toEqual({ outcome: 'delivered', replay: false });
    expect(request.mock.calls).toHaveLength(1);
  });
  it('does not silently launch a hidden browser when a desktop host is not ready', async () => {
    const saved = process.env['WING_DESKTOP_SURFACES'];
    process.env['WING_DESKTOP_SURFACES'] = '1';
    try { await expect(new BuiltInBrowserService().navigate('https://fixture.test')).rejects.toThrow('不会另开隐藏浏览器'); }
    finally { if (saved === undefined) delete process.env['WING_DESKTOP_SURFACES']; else process.env['WING_DESKTOP_SURFACES'] = saved; }
  });
  it('exposes DOM waits and screenshots through the existing installable tool', async () => {
    const { service } = nativeFixture();
    const root = { forSession: () => service };
    const tool = createBuiltinBrowserTools((() => root) as any)[0]!;
    const result = await tool.execute({ action: 'wait_for', pageId: 'p1', condition: 'text', text: '文宇' }, { sessionId: 's' } as any);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ matched: true, browserObservation: { pageId: 'p1' } });
    expect(result.data).not.toHaveProperty('browserScreenshot');
  });
});
