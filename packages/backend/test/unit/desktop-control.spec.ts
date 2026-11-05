import 'reflect-metadata';
import { DesktopControlService } from '../../src/extensions/bundled/computer-use/runtime/desktop-control.service';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';

describe('observed desktop workflow', () => {
  let service: DesktopControlService;
  let bridge: any;
  let count: number;
  let title: string;
  const root = { rootRef: '@w1', windowId: 91, pid: 23, title: 'Fixture', bounds: { x: -400, y: 10, width: 300, height: 200 } };
  beforeEach(() => {
    count = 0; title = 'Before';
    bridge = {
      isAvailable: () => true, dispose: jest.fn(),
      listRoots: jest.fn(async () => ({ roots: [root] })),
      look: jest.fn(async () => ({ lookId: `look_${++count}`, capturedAt: Date.now(), timings: { totalMs: count }, outline: { title, ref: `win:look_${count}:@e1` }, window: { framePoints: { x: -400, y: 10, w: 300, h: 200 } } })),
      act: jest.fn(async () => { title = 'Saved'; return { performed: true }; }),
      focusWindow: jest.fn(async () => ({ success: true })),
      waitFor: jest.fn(async () => ({ matched: true })),
    };
    service = new DesktopControlService(bridge);
    service.setInputMode('physical');
  });
  afterEach(() => service.onModuleDestroy());
  async function look(sessionId = 'fixture') {
    expect((await service.execute(sessionId, { action: 'list_windows' })).success).toBe(true);
    const r = await service.execute(sessionId, { action: 'look', rootRef: '@w1', includeImage: false });
    expect(r.success).toBe(true);
    return (r.data as any).lookId as string;
  }
  const act = (lookId: string) => service.execute('fixture', { action: 'act', lookId, kind: 'press', targetRef: 'win:look_1:@e1', expectedText: 'Saved' });
  it('uses real input by default and rejects a stale virtual selection', async () => {
    expect(service.status().inputMode).toBe('physical');
    expect(() => service.setInputMode('virtual' as any)).toThrow('Only physical');
    const id = await look();
    expect((await act(id)).success).toBe(true);
  });
  it('invalidates observations after a recoverable error without disposing the transport', async () => {
    const id = await look(); bridge.dispose.mockClear();
    service.invalidateSky('fixture', true);
    expect(bridge.dispose).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ active: true, phase: 'needs_observation' });
    expect((await act(id)).success).toBe(false);
  });
  it('requires an explicit listed window, never guessing a title', async () => {
    expect((await service.execute('fixture', { action: 'look' })).success).toBe(false);
    expect((await act('invented')).success).toBe(false);
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('releases only its own desktop and invalidates observations across a human wait', async () => {
    const id = await look();
    service.invalidateSky('another-session');
    expect(service.status().active).toBe(true);
    service.invalidateSky('fixture');
    expect(service.status().active).toBe(false);
    expect((await act(id)).success).toBe(false);
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('preflights and observes after each action; consumed observations cannot be replayed', async () => {
    const id = await look();
    const r = await act(id);
    expect(r.success).toBe(true); expect((r.data as any).verification).toBe('matched');
    expect(bridge.look).toHaveBeenCalledTimes(3);
    expect((await act(id)).success).toBe(false); expect(bridge.act).toHaveBeenCalledTimes(1);
  });
  it('rejects another session and expired observations', async () => {
    const id = await look('other'); expect((await act(id)).success).toBe(false);
    ChatControlRegistry.markInactive('other');
    const next = await look();
    const now = Date.now(); const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect((await act(next)).success).toBe(false); clock.mockRestore();
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('detects changed UI or moved/replaced windows before sending input', async () => {
    let id = await look(); title = 'Different page'; expect((await act(id)).success).toBe(false);
    id = await look(); bridge.listRoots.mockResolvedValue({ roots: [{ ...root, pid: 999 }] });
    expect((await act(id)).success).toBe(false); expect(bridge.act).not.toHaveBeenCalled();
  });
  it('rejects coordinates outside the observed window', async () => {
    const lookId = await look();
    expect((await service.execute('fixture', { action: 'act', kind: 'click', lookId, targetX: -400, targetY: 25 })).success).toBe(false);
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('wait_for accepts the listed root even without an initial lookId', async () => {
    await service.execute('fixture', { action: 'list_windows' });
    const result = await service.execute('fixture', { action: 'wait_for', rootRef: '@w1', text: '通讯录' });
    expect(result.success).toBe(true);
    expect(bridge.waitFor).toHaveBeenCalledWith(expect.objectContaining({ rootRef: '@w1', text: '通讯录' }));
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('does not call partial batches successful or blindly run multiple inputs', async () => {
    const id = await look();
    expect((await service.execute('fixture', { action: 'act_batch', actions: [{ lookId: id, action: 'press' }, { lookId: id, action: 'press' }] })).success).toBe(false);
    expect(bridge.act).not.toHaveBeenCalled();
  });
  it('reports native failure and unmet expectations instead of task completion', async () => {
    let id = await look(); bridge.act.mockResolvedValueOnce({ performed: false }); expect((await act(id)).success).toBe(false);
    id = await look(); bridge.act.mockResolvedValueOnce({ performed: true }); expect((await act(id)).success).toBe(false);
    expect(service.status().requiresObservation).toBe(true);
  });
  it('pause interrupts pending requests and invalidates queued calls even after resume', async () => {
    const id = await look();
    let finish!: (value: unknown) => void;
    bridge.act.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = act(id);
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    const queued = act(id);
    service.pause(); service.resume(); finish({ performed: true });
    expect((await running).success).toBe(false); expect((await queued).success).toBe(false);
    expect(bridge.act).toHaveBeenCalledTimes(1); expect(bridge.dispose).toHaveBeenCalled();
    expect((await service.execute('fixture', { action: 'resume' })).success).toBe(false);
  });
  it('chat stop pauses the desktop; post-action capture failure never retries input', async () => {
    const id = await look(); ChatControlRegistry.requestAbort('fixture');
    expect(service.status().paused).toBe(true); expect((await act(id)).success).toBe(false);
    service.resume(); const next = await look();
    const original = bridge.look.getMockImplementation();
    bridge.look.mockImplementationOnce(original).mockRejectedValueOnce(new Error('capture failed'));
    expect((await act(next)).success).toBe(false); expect(bridge.act).toHaveBeenCalledTimes(1);
  });
});
