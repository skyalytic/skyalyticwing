import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ChatControlRegistry } from '../../ai/chat/chat-control.registry.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDefaultDataDir } from '../utils/web-data.util.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import {
  SchedulerStore,
  stableId,
  type TaskStage,
  type TaskRule,
  type Delivery,
} from './scheduler-store.js';
import type { BackgroundTask } from '../../ai/background/background-task.service.js';
import type { WorkflowRunLog } from '../../workflow/workflow.types.js';

type DeliveryResult = { success: boolean; messageId?: string; error?: string; retryable?: boolean };
type Sender = (delivery: Delivery) => Promise<DeliveryResult>;
type Dispatcher = (input: {
  id: string;
  sessionId: string;
  prompt: string;
  title: string;
  agentId?: string;
}) => { id: string };

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private stores = new Map<string, SchedulerStore>();
  private sender?: Sender;
  private dispatcher?: Dispatcher;
  private timer?: ReturnType<typeof setInterval>;
  private sending = new Map<string, Promise<DeliveryResult>>();
  private busy = false;
  private closed = false;
  private readonly observation = (event: { type: string; data?: Record<string, unknown> }) =>
    this.observe(event);
  constructor(
    private readonly events: EventEmitter2,
    @Optional() private readonly resources?: LocalResourcePolicy,
  ) {
    events.on('runtime.observation', this.observation);
  }
  identity(): string {
    return this.resources?.credentialIdentity() ?? 'local';
  }
  store(identity = this.identity()): SchedulerStore {
    let store = this.stores.get(identity);
    if (!store) {
      store = new SchedulerStore(
        join(getDefaultDataDir(), 'scheduler', stableId(identity) + '.json'),
      );
      this.stores.set(identity, store);
    }
    return store;
  }
  onApplicationBootstrap() {
    this.store();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* Persisted items remain available for inspection. */
      });
    }, 2000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.events.off('runtime.observation', this.observation);
  }
  registerSender(sender: Sender) {
    this.sender = sender;
  }
  registerDispatcher(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }
  snapshot() {
    const data = this.store().snapshot();
    return {
      tasks: Object.values(data.tasks).sort((a, b) => b.updatedAt - a.updatedAt),
      deliveries: Object.values(data.deliveries)
        .map(({ options: _options, ...delivery }) => delivery)
        .sort((a, b) => b.createdAt - a.createdAt),
      rules: Object.values(data.rules),
      admissions: Object.values(data.admissions).sort((a, b) => b.createdAt - a.createdAt),
      notices: data.notices,
    };
  }
  saveRule(rule: Omit<TaskRule, 'revision' | 'nextAt'>, expected: number) {
    const store = this.store();
    const saved = store.saveRule(rule, expected);
    for (const task of Object.values(store.snapshot().tasks)) {
      const grants = [...(task.mandates ?? []), ...(task.mandate ? [task.mandate] : [])];
      if (
        ['working', 'answer', 'review'].includes(task.stage) &&
        grants.some((g) => g.ruleId === rule.id)
      )
        ChatControlRegistry.requestAbort(task.sessionId);
    }
    return saved;
  }
  assertMandate(sessionId: string) {
    const store = this.store();
    const task = store.taskForSession(sessionId);
    const mandates = [...(task?.mandates ?? []), ...(task?.mandate ? [task.mandate] : [])];
    if (mandates.some((m) => !store.permitted(m)))
      throw new Error('Automatic task rule was changed or disabled');
  }
  begin(sessionId: string, turnId: string, text: string) {
    const store = this.store();
    const old = store.taskForSession(sessionId);
    this.assertMandate(sessionId);
    const inputs = [...(old?.inputs ?? [])];
    if (!inputs.some((i) => i.id === turnId)) inputs.push({ id: turnId, text, at: Date.now() });
    const task = store.task({
      ...(old ?? {}),
      id: old?.id ?? 'chat:' + sessionId,
      kind: old?.kind ?? 'chat',
      sourceId: old?.sourceId ?? sessionId,
      sessionId,
      title: old?.title ?? text.slice(0, 120),
      stage: 'working',
      inputs: inputs.slice(-100),
      waits: [],
      detail: '',
      result: '',
      artifacts: [],
    });
    return { id: task.id, identity: this.identity() };
  }
  finish(
    handle: { id: string; identity: string },
    state: string,
    result?: string,
    artifacts?: unknown[],
    error?: string,
  ) {
    const store = this.store(handle.identity);
    const task = store.taskById(handle.id);
    if (!task) return;
    // Background executors supply their own authoritative completion and origin link.
    if (task.kind === 'background' || task.kind === 'automation') return;
    const stage: TaskStage =
      state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'blocked';
    this.record(store, {
      ...task,
      stage,
      waits: [],
      result: result ?? task.result,
      artifacts: artifacts ?? task.artifacts,
      detail: stage === 'blocked' ? error || state : '',
    });
  }
  background(task: BackgroundTask) {
    const identity = task.memoryIdentity ?? this.identity();
    const store = this.store(identity);
    const old = store.snapshot().tasks['background:' + task.id];
    const stage: TaskStage = (
      {
        pending: 'queued',
        running: 'working',
        completed: 'completed',
        cancelled: 'cancelled',
        failed: 'blocked',
        interrupted: 'blocked',
      } as const
    )[task.status];
    this.record(store, {
      ...old,
      id: 'background:' + task.id,
      kind: old?.kind ?? 'background',
      sourceId: task.id,
      sessionId: task.taskSessionId,
      originSessionId: task.sessionId,
      title: task.title,
      stage,
      detail: task.error || task.step,
      result: task.result ?? '',
      artifacts: task.attachments,
      ...(!['queued', 'working'].includes(stage) ? { waits: [] } : {}),
      createdAt: task.createdAt,
    });
  }
  workflow(run: WorkflowRunLog, identity: string) {
    const stage: TaskStage = (
      {
        running: 'working',
        success: 'completed',
        error: 'blocked',
        interrupted: 'blocked',
        cancelled: 'cancelled',
        paused: 'review',
      } as const
    )[run.status];
    this.record(this.store(identity), {
      id: 'workflow:' + run.id,
      kind: 'workflow',
      sourceId: run.workflowId,
      sessionId: run.id,
      originSessionId: '',
      title: run.snapshot.name,
      stage,
      detail: run.error || run.reviewStepId || run.activeStepId || '',
      result: run.stepResults.map((s) => s.output).join('\n\n'),
      artifacts: run.stepResults,
      createdAt: run.startedAt,
    });
  }
  private record(store: SchedulerStore, input: Parameters<SchedulerStore['task']>[0]) {
    const old = store.taskById(input.id);
    const task = store.task(input);
    if (task.stage === 'completed' && old?.stage !== 'completed' && !task.mandate) {
      this.trigger(
        {
          id: task.id + ':' + task.updatedAt,
          source: 'task',
          text: task.title + '\n' + task.result,
          sessionId: task.originSessionId,
        },
        store,
      );
    }
    return task;
  }
  private observe(event: { type: string; data?: Record<string, unknown> }) {
    if (
      !['ask_user_request', 'ask_user_resolved', 'approval_request', 'approval_resolved'].includes(
        event.type,
      )
    )
      return;
    const data = event.data;
    if (!data || typeof data['id'] !== 'string') return;
    const store = this.store();
    const task = Object.values(store.snapshot().tasks).find(
      (t) => t.sessionId === data['sessionId'] || t.waits.some((w) => w.id === data['id']),
    );
    if (!task) return;
    const waiting = event.type.endsWith('_request');
    const waits = task.waits.filter((w) => w.id !== data['id']);
    if (waiting)
      waits.push({
        id: data['id'],
        kind: event.type === 'ask_user_request' ? 'answer' : 'review',
        text: String(data['question'] ?? data['toolName'] ?? ''),
      });
    store.task({
      ...task,
      waits,
      stage: waits.some((w) => w.kind === 'answer')
        ? 'answer'
        : waits.length
          ? 'review'
          : 'working',
    });
  }
  channelAdmission(
    channel: string,
    peer: string,
    id: string,
    text: string,
    sessionId: string,
  ): TaskRule['mode'] | null {
    const store = this.store();
    const matching = Object.values(store.snapshot().rules).filter(
      (r) =>
        r.source === 'channel' &&
        (!r.channel || r.channel === channel) &&
        (!r.peer || r.peer === peer) &&
        (!r.contains || text.includes(r.contains)),
    );
    if (!matching.length) {
      const old = store.snapshot().tasks['chat:' + sessionId];
      if (old?.mandates?.length) store.task({ ...old, mandates: [] });
      return null;
    }
    // The most restrictive matching rule wins; off cannot be bypassed by another rule.
    const mode = matching.some((r) => r.mode === 'off')
      ? 'off'
      : matching.some((r) => r.mode === 'observe')
        ? 'observe'
        : 'auto';
    for (const rule of matching) {
      const admission = store.admit(
        { id: channel + ':' + id, source: 'channel', channel, peer, text, sessionId },
        rule,
      );
      store.change((d) => {
        const a = d.admissions[admission.id]!;
        a.state = mode === 'auto' ? 'dispatched' : 'observed';
        a.reason =
          mode === 'auto'
            ? 'Explicit incoming message admitted'
            : 'Restricted by matching rule: ' + mode;
      });
    }
    if (mode === 'auto')
      store.task({
        id: 'chat:' + sessionId,
        kind: 'chat',
        sourceId: sessionId,
        sessionId,
        title: text.slice(0, 120),
        stage: 'queued',
        mandates: matching.map((r) => ({ ruleId: r.id, revision: r.revision })),
      });
    return mode;
  }
  trigger(
    event: { id: string; source: TaskRule['source']; text: string; sessionId: string },
    store = this.store(),
  ) {
    for (const rule of Object.values(store.snapshot().rules))
      if (rule.source === event.source && (!rule.contains || event.text.includes(rule.contains)))
        store.admit(event, rule);
  }
  async send(
    channel: string,
    peer: string,
    content: string,
    options: Record<string, unknown> = {},
    key: string = randomUUID(),
  ): Promise<DeliveryResult> {
    const identity = this.identity();
    const item = this.store(identity).enqueue(channel, peer, content, options, key);
    const task = Object.values(this.store(identity).snapshot().tasks).find(
      (t) => t.sessionId === options['_taskSessionId'],
    );
    if (task && !item.taskId)
      this.store(identity).change((d) => {
        d.deliveries[item.id]!.taskId = task.id;
      });
    return this.deliver(identity, item.id);
  }
  private deliver(identity: string, id: string): Promise<DeliveryResult> {
    const key = identity + ':' + id;
    const existing = this.sending.get(key);
    if (existing) return existing;
    const operation = this.attempt(identity, id).finally(() => this.sending.delete(key));
    this.sending.set(key, operation);
    return operation;
  }
  private async attempt(identity: string, id: string): Promise<DeliveryResult> {
    const store = this.store(identity);
    const item = store.snapshot().deliveries[id];
    if (!item) return { success: false, error: 'Delivery not found' };
    if (item.state === 'sent')
      return { success: true, ...(item.receipt ? { messageId: item.receipt } : {}) };
    if (
      this.closed ||
      identity !== this.identity() ||
      !this.sender ||
      item.state !== 'queued' ||
      item.nextAt > Date.now()
    )
      return { success: false, error: 'Delivery pending: ' + id };
    const predecessor = Object.values(store.snapshot().deliveries).some(
      (d) =>
        d.id !== id &&
        d.channel === item.channel &&
        d.peer === item.peer &&
        (d.createdAt < item.createdAt ||
          (d.createdAt === item.createdAt &&
            Object.keys(store.snapshot().deliveries).indexOf(d.id) <
              Object.keys(store.snapshot().deliveries).indexOf(id))) &&
        ['queued', 'sending', 'unknown'].includes(d.state),
    );
    if (predecessor) return { success: false, error: 'Waiting for earlier delivery: ' + id };
    store.change((d) => {
      d.deliveries[id]!.state = 'sending';
      d.deliveries[id]!.attempts++;
    });
    let result: DeliveryResult;
    try {
      result = await this.sender(item);
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    store.change((d) => {
      const current = d.deliveries[id]!;
      current.error = result.error ?? '';
      if (result.success) {
        current.state = 'sent';
        if (result.messageId) current.receipt = result.messageId;
      } else if (result.retryable && current.attempts < 8) {
        current.state = 'queued';
        current.nextAt = Date.now() + Math.min(300_000, 2000 * 2 ** current.attempts);
      } else current.state = 'unknown';
    });
    if (result.success && identity === this.identity())
      this.events.emit('delivery.sent', { ...item, ...result });
    return result.success
      ? result
      : { ...result, error: (result.error ?? 'Delivery uncertain') + ' [' + id + ']' };
  }
  settleDelivery(id: string, action: 'retry' | 'sent' | 'cancel', confirmed: boolean) {
    return this.store().change((d) => {
      const item = d.deliveries[id];
      if (!item) throw new Error('Delivery not found');
      if (item.state === 'sending' || item.state === 'sent')
        throw new Error('Delivery is already in flight or sent');
      if (action !== 'cancel' && !confirmed)
        throw new Error('Verify delivery before retrying or marking sent');
      item.state = action === 'sent' ? 'sent' : action === 'retry' ? 'queued' : 'cancelled';
      item.nextAt = Date.now();
      item.error = '';
      return item.id;
    });
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const identity = this.identity();
      const store = this.store(identity);
      for (const rule of Object.values(store.snapshot().rules))
        if (rule.source === 'interval' && rule.nextAt <= Date.now()) {
          store.admit(
            {
              id: 'interval:' + rule.id + ':' + rule.nextAt,
              source: 'interval',
              text: rule.prompt,
              sessionId: 'automation:' + rule.id,
            },
            rule,
          );
          store.change((d) => {
            d.rules[rule.id]!.nextAt = Date.now() + rule.intervalMinutes * 60_000;
          });
        }
      if (this.dispatcher)
        for (const admission of Object.values(store.snapshot().admissions)) {
          if (admission.state !== 'queued' || identity !== this.identity()) continue;
          if (!store.permitted(admission)) {
            store.change((d) => {
              d.admissions[admission.id]!.state = 'blocked';
            });
            continue;
          }
          const rule = store.snapshot().rules[admission.ruleId]!;
          const id = 'rule-' + admission.id;
          if (!store.snapshot().tasks['background:' + id])
            store.task({
              id: 'background:' + id,
              sourceId: id,
              kind: 'automation',
              sessionId: 'bg-task-' + id,
              originSessionId: admission.sessionId,
              title: rule.name,
              stage: 'queued',
              mandate: { ruleId: rule.id, revision: rule.revision },
            });
          try {
            const task = this.dispatcher({
              id,
              sessionId: admission.sessionId,
              title: rule.name,
              prompt:
                rule.prompt +
                (rule.source === 'interval' ? '' : '\n\nInput context:\n' + admission.input),
              ...(rule.agentId ? { agentId: rule.agentId } : {}),
            });
            store.change((d) => {
              d.admissions[admission.id]!.state = 'dispatched';
              d.admissions[admission.id]!.taskId = task.id;
            });
          } catch (error) {
            store.change((d) => {
              d.admissions[admission.id]!.state = 'blocked';
              d.admissions[admission.id]!.reason = String(error);
            });
          }
        }
      const due = Object.values(store.snapshot().deliveries).filter(
        (d) => d.state === 'queued' && d.nextAt <= Date.now(),
      );
      for (let offset = 0; offset < due.length; offset += 3)
        await Promise.all(due.slice(offset, offset + 3).map((d) => this.deliver(identity, d.id)));
    } finally {
      this.busy = false;
    }
  }
}
