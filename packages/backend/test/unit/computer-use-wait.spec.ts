import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { activate } from '../../src/extensions/bundled/computer-use';
import { AskUserService } from '../../src/modules/tools/executor/ask-user.service';
import { DesktopControlService } from '../../src/modules/automation/desktop-control.service';

describe('tool-owned human completion wait', () => {
  let service: AskUserService, desktop: any, extension: ReturnType<typeof activate>;
  beforeEach(() => {
    service = new AskUserService(new EventEmitter2(), { broadcast: jest.fn() } as any, { info: jest.fn() } as any);
    desktop = { invalidateSky: jest.fn(), release: jest.fn() };
    extension = activate({ resolve: (type: any) => type === AskUserService ? service : type === DesktopControlService ? desktop : undefined } as any);
  });
  afterEach(async () => { service.onModuleDestroy(); await extension.dispose?.(); jest.useRealTimers(); });
  const context = (sessionId = 'one', signal = new AbortController().signal) => ({ sessionId, signal } as any);
  function wait(args: object, ctx = context()) { return extension.tools.find(t => t.name === 'computer_use_confirm')!.execute(args, ctx); }
  it('waits beyond ten minutes and resumes only on a human reply, without granting send approval', async () => {
    jest.useFakeTimers(); let resolved = false;
    const task = wait({ question: '请完成手机验证，完成后确认', purpose: 'user_step' }).then(r => { resolved = true; return r; });
    expect(desktop.invalidateSky).toHaveBeenCalledWith('one');
    await jest.advanceTimersByTimeAsync(600_000);
    expect(resolved).toBe(false); expect(service.listPending()).toHaveLength(1);
    expect(service.listPending()[0]!.options).toEqual([]);
    service.respond(service.listPending()[0]!.id, ['好了']);
    expect((await task).data).toMatchObject({ answered: true, answer: ['好了'], approved: false, requiresObservation: true });
    expect(desktop.invalidateSky).toHaveBeenCalledTimes(2);
    expect(service.listPending()).toHaveLength(0);
  });
  it('keeps action confirmation separate, with no approval on cancel or arbitrary text', async () => {
    for (const [answer, approved] of [[['确认'], true], [['取消'], false], [['还没完成'], null]] as const) {
      const task = wait({ question: '发送这条消息？' });
      service.respond(service.listPending()[0]!.id, [...answer]);
      expect((await task).data).toMatchObject({ purpose: 'action_confirmation', approved, requiresObservation: true });
    }
  });
  it.each(['好了', '已登录', '还没有，请等一下', '我需要换一个账号'])('preserves free reply %s without inventing completion or approval', async answer => {
    const task = wait({ question: '完成后回复好了', purpose: 'user_step' });
    expect(service.listPending()[0]!.options).toEqual([]);
    service.respond(service.listPending()[0]!.id, [answer]);
    const data = (await task).data;
    expect(data).toMatchObject({ answered: true, answer: [answer], approved: false, requiresObservation: true });
    expect(data).not.toHaveProperty('completed');
  });
  it('stops a pending user step without disturbing another conversation and rejects a late reply', async () => {
    const abort = new AbortController();
    const task = wait({ question: 'First', purpose: 'user_step' }, context('one', abort.signal));
    const other = wait({ question: 'Second', purpose: 'user_step' }, context('two'));
    const id = service.listPending()[0]!.id; abort.abort();
    expect((await task).data).toMatchObject({ answered: false, approved: false });
    expect(service.respond(id, ['确认'])).toBe(false);
    expect(service.listPending().map(r => r.sessionId)).toEqual(['two']);
    service.respond(service.listPending()[0]!.id, []);
    expect((await other).data).toMatchObject({ answered: false, approved: false });
  });
});
