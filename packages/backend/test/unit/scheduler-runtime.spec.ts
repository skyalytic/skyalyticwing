import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SchedulerStore,
  RevisionConflict,
  type TaskRule,
} from '../../src/modules/core/scheduler/scheduler-store.js';
import { SchedulerService } from '../../src/modules/core/scheduler/scheduler.service.js';
import { SchedulerController } from '../../src/modules/core/scheduler/scheduler.controller.js';
import { WebSocketService } from '../../src/modules/core/websocket/websocket.service.js';
import { AgentService } from '../../src/modules/ai/agent/agent.service.js';
import { BackgroundTaskService } from '../../src/modules/ai/background/background-task.service.js';
import { InboxService } from '../../src/modules/channels/inbox.service.js';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry.js';

describe('durable task scheduling and supervision', () => {
  let dir: string, service: SchedulerService, events: EventEmitter2, identity: string;
  const original = process.env['SKYALYTICWING_DATA_DIR'];
  const policy = { credentialIdentity: () => identity } as any;
  const rule = (
    id: string,
    mode: TaskRule['mode'] = 'auto',
    source: TaskRule['source'] = 'interval',
  ) =>
    service.store().saveRule(
      {
        id,
        name: id,
        source,
        mode,
        channel: '',
        peer: '',
        contains: '',
        prompt: 'Check the report',
        agentId: '',
        intervalMinutes: 1,
      },
      0,
    );
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wing-scheduler-test-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
    identity = 'local';
    events = new EventEmitter2();
    service = new SchedulerService(events, policy);
  });
  afterEach(() => {
    service.onModuleDestroy();
    if (original === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = original;
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !dir.includes('wing-scheduler-test-'))
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  });
  it('stops active waits when their granting rule changes', () => {
    const configured = rule('stop', 'auto', 'channel');
    service.channelAdmission('feishu', 'alice', 'm', 'work', 'pending');
    service.begin('pending', 't', 'work');
    const stopped = jest.fn();
    const unsubscribe = ChatControlRegistry.onAbort(stopped);
    try {
      service.saveRule({ ...configured, mode: 'off' }, configured.revision);
      expect(stopped).toHaveBeenCalledWith('pending');
    } finally {
      unsubscribe();
      ChatControlRegistry.clearAbort('pending');
    }
  });
  it('keeps delivery receipts linked to the originating task', async () => {
    const task = service.begin('s', 't', 'work');
    service.registerSender(async () => ({ success: true, messageId: 'receipt' }));
    await service.send('test', 'alice', 'result', { _taskSessionId: 's' }, 'linked');
    expect(service.snapshot().deliveries[0]).toMatchObject({ taskId: task.id, receipt: 'receipt' });
  });
  it('preserves the actionable failure reason', () => {
    const task = service.begin('s', 't', 'work');
    service.finish(task, 'failed', '', [], 'Remote host disconnected');
    expect(service.snapshot().tasks[0]?.detail).toBe('Remote host disconnected');
  });
  it('keeps inputs and results linked through follow-ups, with no routine chat notifications', () => {
    const first = service.begin('chat', 'turn1', 'Build a report');
    service.finish(first, 'completed', 'result', [{ path: '/report' }]);
    expect(service.snapshot().notices).toEqual([]);
    const second = service.begin('chat', 'turn2', 'Change the title');
    expect(second.id).toBe(first.id);
    service.finish(second, 'completed', 'updated');
    expect(service.snapshot().tasks[0]).toMatchObject({
      result: 'updated',
      stage: 'completed',
      inputs: [{ id: 'turn1' }, { id: 'turn2' }],
    });
  });
  it('captures questions without a connected browser, resolves each wait and coalesces notices', () => {
    service.begin('chat', 'turn', 'task');
    const ws = new WebSocketService(events);
    const request = {
      type: 'ask_user_request',
      data: { id: 'q', sessionId: 'chat', question: 'Which file?' },
    } as any;
    ws.broadcast(request);
    ws.broadcast(request);
    expect(service.snapshot().tasks[0]?.stage).toBe('answer');
    expect(service.snapshot().notices).toHaveLength(1);
    ws.broadcast({
      type: 'approval_request',
      data: { id: 'a', sessionId: 'chat', toolName: 'shell' },
    } as any);
    ws.broadcast({ type: 'ask_user_resolved', data: { id: 'q', sessionId: 'chat' } } as any);
    expect(service.snapshot().tasks[0]?.stage).toBe('review');
    ws.broadcast({ type: 'approval_resolved', data: { id: 'a' } } as any);
    expect(service.snapshot().tasks[0]?.stage).toBe('working');
  });
  it('scopes tasks, queue and prompt history to the current credential identity', () => {
    service.begin('s', 't', 'private');
    service.store().prompt('agent', 'private prompt');
    identity = 'another-account';
    expect(service.snapshot().tasks).toEqual([]);
    expect(service.store().snapshot().prompts).toEqual({});
    identity = 'local';
    expect(service.snapshot().tasks).toHaveLength(1);
  });
  it('marks interrupted tasks and in-flight deliveries unknown after restart without replay', async () => {
    service.begin('s', 't', 'task');
    const item = service.store().enqueue('test', 'alice', 'hello', {}, '1');
    service.store().change((d) => {
      d.deliveries[item.id]!.state = 'sending';
    });
    const restarted = new SchedulerService(new EventEmitter2(), policy);
    const sender = jest.fn();
    restarted.registerSender(sender);
    await restarted.tick();
    expect(sender).not.toHaveBeenCalled();
    expect(restarted.snapshot().tasks[0]?.stage).toBe('blocked');
    expect(restarted.snapshot().deliveries[0]?.state).toBe('unknown');
    restarted.onModuleDestroy();
  });
  it('deduplicates concurrent sends and preserves successful receipts', async () => {
    let finish!: (r: any) => void;
    const sender = jest.fn(
      () =>
        new Promise<any>((r) => {
          finish = r;
        }),
    );
    service.registerSender(sender);
    const first = service.send('test', 'alice', 'hello', {}, 'key');
    const second = service.send('test', 'alice', 'hello', {}, 'key');
    expect(sender).toHaveBeenCalledTimes(1);
    finish({ success: true, messageId: 'receipt' });
    await Promise.all([first, second]);
    expect(await service.send('test', 'alice', 'hello', {}, 'key')).toMatchObject({
      success: true,
      messageId: 'receipt',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    await expect(service.send('test', 'alice', 'different', {}, 'key')).rejects.toThrow(
      'different content',
    );
  });
  it('only retries proven pre-delivery failures, blocks followers after an uncertain effect', async () => {
    const sender = jest
      .fn()
      .mockResolvedValueOnce({ success: false, retryable: true, error: 'offline' })
      .mockResolvedValueOnce({ success: true, messageId: 'ok' })
      .mockRejectedValueOnce(new Error('socket reset'));
    service.registerSender(sender);
    await service.send('test', 'alice', 'one', {}, 'one');
    const first = service.snapshot().deliveries[0]!;
    expect(first.state).toBe('queued');
    service.store().change((d) => {
      d.deliveries[first.id]!.nextAt = 0;
    });
    await service.tick();
    expect(service.snapshot().deliveries[0]?.state).toBe('sent');
    await service.send('test', 'alice', 'two', {}, 'two');
    await service.send('test', 'alice', 'three', {}, 'three');
    expect(sender).toHaveBeenCalledTimes(3);
    await service.tick();
    expect(sender).toHaveBeenCalledTimes(3);
    const unknown = service.snapshot().deliveries.find((d) => d.state === 'unknown')!;
    expect(() => service.settleDelivery(unknown.id, 'retry', false)).toThrow('Verify');
    service.settleDelivery(unknown.id, 'cancel', false);
    sender.mockResolvedValue({ success: true });
    await service.tick();
    expect(sender).toHaveBeenCalledTimes(4);
  });
  it('uses immutable delivery options and keeps private routing tokens out of API snapshots', async () => {
    const options = { contextToken: 'private' };
    service.registerSender(async () => ({ success: false, retryable: true }));
    await service.send('x', 'alice', 'hi', options, 'key');
    options.contextToken = 'changed';
    expect(JSON.stringify(service.snapshot())).not.toContain('private');
    expect(Object.values(service.store().snapshot().deliveries)[0]?.options).toEqual({
      contextToken: 'private',
    });
  });
  it('reconciles inbox confirmation when a previously queued draft is eventually delivered', async () => {
    const inbox = new InboxService(service);
    inbox.onModuleInit();
    inbox.receive('c', 'm', 'alice', 'question', Date.now());
    const draft = inbox.draft('c:m', 'answer');
    service.registerSender(async () => ({ success: false, retryable: true }));
    await inbox.send(draft.id, 'answer', async () => {
      const result = await service.send('c', 'alice', 'answer', {}, 'draft:' + draft.id);
      if (!result.success) throw new Error('queued');
    });
    expect(inbox.list().drafts[0]?.status).toBe('unknown');
    const delivery = service.snapshot().deliveries[0]!;
    service.store().change((d) => {
      d.deliveries[delivery.id]!.nextAt = 0;
    });
    service.registerSender(async () => ({ success: true }));
    await service.tick();
    expect(inbox.list().drafts[0]?.status).toBe('sent');
  });
  it('records observe/off decisions without launching, executes automatic interval admissions once', async () => {
    rule('observe', 'observe');
    rule('off', 'off');
    rule('auto');
    service.store().change((d) => {
      for (const r of Object.values(d.rules)) r.nextAt = 0;
    });
    const dispatch = jest.fn((input) => ({ id: input.id }));
    service.registerDispatcher(dispatch);
    await service.tick();
    await service.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      service
        .snapshot()
        .admissions.map((a) => a.mode)
        .sort(),
    ).toEqual(['auto', 'observe', 'off']);
  });
  it('revalidates rules on dispatch, resume and subsequent tool execution', async () => {
    const initial = rule('rule');
    service.trigger({ id: 'event', source: 'interval', text: 'input', sessionId: 's' });
    service.store().saveRule({ ...initial, mode: 'off' }, initial.revision);
    const dispatch = jest.fn();
    service.registerDispatcher(dispatch);
    await service.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.snapshot().admissions[0]?.state).toBe('blocked');
    const active = rule('active');
    service.store().task({
      id: 'background:b',
      kind: 'automation',
      sourceId: 'b',
      sessionId: 's',
      title: 'task',
      stage: 'queued',
      mandate: { ruleId: active.id, revision: active.revision },
    });
    service.begin('s', 'turn', 'work');
    service.store().saveRule({ ...active, mode: 'off' }, active.revision);
    expect(() => service.assertMandate('s')).toThrow('changed or disabled');
    expect(() => service.begin('s', 'again', 'resume')).toThrow();
  });
  it('does not amplify automatic completion into another automatic task', async () => {
    rule('completion', 'auto', 'task');
    service.store().task({
      id: 'background:b',
      kind: 'automation',
      sourceId: 'b',
      sessionId: 'bg-task-b',
      title: 'task',
      stage: 'working',
      mandate: { ruleId: 'completion', revision: 1 },
    });
    service.background({
      id: 'b',
      taskSessionId: 'bg-task-b',
      sessionId: 'origin',
      title: 'task',
      status: 'completed',
      result: 'done',
      attachments: [],
      error: null,
      step: '',
      createdAt: Date.now(),
      prompt: 'work',
    });
    expect(service.snapshot().admissions).toHaveLength(0);
  });
  it('restrictive channel rules win and admission reasons are auditable', () => {
    rule('allow', 'auto', 'channel');
    rule('observe', 'observe', 'channel');
    expect(service.channelAdmission('feishu', 'alice', 'm', 'hello', 'session')).toBe('observe');
    expect(service.snapshot().admissions).toHaveLength(2);
    expect(service.snapshot().admissions.every((a) => a.state === 'observed')).toBe(true);
    rule('off', 'off', 'channel');
    expect(service.channelAdmission('feishu', 'alice', 'm2', 'hello', 'session')).toBe('off');
  });
  it('revalidates every matching channel rule during execution', () => {
    rule('one', 'auto', 'channel');
    const second = rule('two', 'auto', 'channel');
    expect(service.channelAdmission('feishu', 'alice', 'm', 'work', 'session')).toBe('auto');
    service.begin('session', 't', 'work');
    service.store().saveRule({ ...second, mode: 'off' }, second.revision);
    expect(() => service.assertMandate('session')).toThrow('changed or disabled');
  });
  it('recovers a dispatch receipt without resetting an already completed task', async () => {
    const configured = rule('task');
    const admission = service
      .store()
      .admit({ id: 'event', source: 'interval', text: 'work', sessionId: 'origin' }, configured);
    const id = 'rule-' + admission.id;
    service.store().task({
      id: 'background:' + id,
      sourceId: id,
      kind: 'automation',
      sessionId: 'bg-task-' + id,
      title: 'task',
      stage: 'completed',
      result: 'done',
      mandate: { ruleId: configured.id, revision: configured.revision },
    });
    service.registerDispatcher((input) => ({ id: input.id }));
    await service.tick();
    expect(service.snapshot().tasks[0]).toMatchObject({ stage: 'completed', result: 'done' });
    expect(service.snapshot().admissions[0]?.state).toBe('dispatched');
  });
  it('rejects reserved object keys before mutating durable records', () => {
    expect(() => rule('__proto__')).toThrow('Invalid rule ID');
    expect(() => service.store().prompt('__proto__', 'override')).toThrow('Invalid prompt ID');
    expect(service.snapshot().rules).toHaveLength(0);
  });
  it('keeps prompt history, rejects stale saves, upgrades untouched defaults and preserves custom edits', () => {
    const store = service.store();
    store.prompt('untouched', 'old', 'old');
    store.upgradePrompt('untouched', 'new');
    expect(store.snapshot().prompts['untouched']?.revisions.at(-1)?.text).toBe('new');
    store.prompt('custom', 'old', 'old');
    store.savePrompt('custom', 'my edit', 1);
    store.upgradePrompt('custom', 'new');
    expect(store.snapshot().prompts['custom']).toMatchObject({ pendingTemplate: 'new' });
    expect(() => store.savePrompt('custom', 'stale', 1)).toThrow(RevisionConflict);
    store.resolveTemplate('custom', 'merged', 2);
    expect(store.snapshot().prompts['custom']).not.toHaveProperty('pendingTemplate');
    expect(store.snapshot().prompts['custom']?.revisions).toHaveLength(3);
  });
  it('uses the prompt revision in actual agent resolution and guards the original editor too', () => {
    const agents = new AgentService(undefined, service);
    agents.onModuleInit();
    const originalAgent = agents.getAgent('agent');
    service.store().savePrompt('agent', 'versioned instruction', originalAgent.promptRevision!);
    expect(agents.getAgent('agent').systemPrompt).toBe('versioned instruction');
    expect(() =>
      agents.updateAgent('agent', {
        systemPrompt: 'stale',
        promptRevision: originalAgent.promptRevision,
      }),
    ).toThrow(RevisionConflict);
    const current = agents.getAgent('agent');
    agents.updateAgent('agent', {
      systemPrompt: 'new edit',
      promptRevision: current.promptRevision,
    });
    expect(agents.getAgent('agent').systemPrompt).toBe('new edit');
  });
  it('rejects invalid rule bodies and stale revisions through the controller', () => {
    const controller = new SchedulerController(service, {} as any);
    expect(() => controller.saveRule({ mode: 'auto' })).toThrow();
    const initial = rule('r');
    expect(() => controller.saveRule({ ...initial, expectedRevision: 0 })).toThrow();
  });
  it('fails closed on corrupt state instead of discarding tasks', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{broken');
    expect(() => new SchedulerStore(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
  it('integrates a real background executor, original-session link and restart identity', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() } as any;
    const ws = { broadcast: jest.fn(), broadcastToSession: jest.fn() } as any;
    const engine = {
      async *run() {
        yield { type: 'assistant_message', content: 'done' };
      },
    } as any;
    const background = new BackgroundTaskService(engine, ws, logger, undefined, policy, service);
    background.onModuleInit();
    background.onApplicationBootstrap();
    const task = background.submit({ sessionId: 'origin', prompt: 'work' });
    await new Promise((r) => setImmediate(r));
    expect(service.snapshot().tasks.find((t) => t.sourceId === task.id)).toMatchObject({
      stage: 'completed',
      result: 'done',
      originSessionId: 'origin',
    });
    const restarted = new BackgroundTaskService(engine, ws, logger, undefined, policy, service);
    restarted.onModuleInit();
    expect(restarted.get(task.id)?.memoryIdentity).toBe('local');
  });
});
