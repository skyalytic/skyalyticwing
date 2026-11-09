import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type TaskStage =
  'queued' | 'working' | 'answer' | 'review' | 'blocked' | 'completed' | 'cancelled';
export interface ScheduledTask {
  id: string;
  kind: 'chat' | 'background' | 'workflow' | 'automation';
  sourceId: string;
  sessionId: string;
  originSessionId: string;
  title: string;
  stage: TaskStage;
  detail: string;
  result: string;
  artifacts: unknown[];
  createdAt: number;
  updatedAt: number;
  inputs: Array<{ id: string; text: string; at: number }>;
  history: Array<{ stage: TaskStage; detail: string; at: number }>;
  waits: Array<{ id: string; kind: 'answer' | 'review'; text: string }>;
  mandate?: { ruleId: string; revision: number };
  mandates?: Array<{ ruleId: string; revision: number }>;
}
export interface Delivery {
  taskId?: string;
  id: string;
  key: string;
  channel: string;
  peer: string;
  content: string;
  options: Record<string, unknown>;
  state: 'queued' | 'sending' | 'sent' | 'unknown' | 'cancelled';
  attempts: number;
  nextAt: number;
  createdAt: number;
  error: string;
  receipt?: string;
}
export interface TaskRule {
  id: string;
  revision: number;
  name: string;
  source: 'channel' | 'interval' | 'task';
  mode: 'off' | 'observe' | 'auto';
  channel: string;
  peer: string;
  contains: string;
  prompt: string;
  agentId: string;
  intervalMinutes: number;
  nextAt: number;
}
export interface Admission {
  id: string;
  eventId: string;
  ruleId: string;
  revision: number;
  mode: TaskRule['mode'];
  reason: string;
  input: string;
  sessionId: string;
  createdAt: number;
  state: 'observed' | 'queued' | 'dispatched' | 'blocked';
  taskId?: string;
}
export interface PromptRevision {
  revision: number;
  text: string;
  template: string;
  reason: string;
  at: number;
}
export interface PromptDocument {
  id: string;
  revisions: PromptRevision[];
  template: string;
  pendingTemplate?: string;
}
interface Data {
  version: 1;
  tasks: Record<string, ScheduledTask>;
  deliveries: Record<string, Delivery>;
  rules: Record<string, TaskRule>;
  admissions: Record<string, Admission>;
  prompts: Record<string, PromptDocument>;
  notices: Array<{
    id: string;
    taskId: string;
    stage: TaskStage;
    title: string;
    sessionId: string;
    read: boolean;
    at: number;
  }>;
}
const empty = (): Data => ({
  version: 1,
  tasks: {},
  deliveries: {},
  rules: {},
  admissions: {},
  prompts: {},
  notices: [],
});
export const stableId = (value: string) => createHash('sha256').update(value).digest('hex');
export class RevisionConflict extends Error {}

/** One synchronous commit precedes each effect. Never replace corrupt data with an empty queue. */
export class SchedulerStore {
  private data: Data;
  constructor(private readonly file: string) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Data) : empty();
    if (
      this.data.version !== 1 ||
      !['tasks', 'deliveries', 'rules', 'admissions', 'prompts'].every((k) => {
        const v = (this.data as unknown as Record<string, unknown>)[k];
        return v && typeof v === 'object' && !Array.isArray(v);
      }) ||
      !Array.isArray(this.data.notices)
    )
      throw new Error('Invalid scheduler storage');
    this.change((d) => {
      for (const task of Object.values(d.tasks))
        if (['working', 'answer', 'review'].includes(task.stage)) {
          task.stage = 'blocked';
          task.waits = [];
          task.detail = 'Execution interrupted; resume from its original task';
          task.history.push({ stage: task.stage, detail: task.detail, at: Date.now() });
        }
      for (const delivery of Object.values(d.deliveries))
        if (delivery.state === 'sending') {
          delivery.state = 'unknown';
          delivery.error = 'Delivery interrupted; verify the recipient before retrying';
        }
    });
  }
  taskById(id: string): ScheduledTask | undefined {
    return structuredClone(this.data.tasks[id]);
  }
  taskForSession(sessionId: string): ScheduledTask | undefined {
    return structuredClone(
      Object.values(this.data.tasks).find(
        (t) => t.sessionId === sessionId && t.kind !== 'workflow',
      ),
    );
  }
  attentionCount(): number {
    return (
      Object.values(this.data.tasks).filter((t) =>
        ['answer', 'review', 'blocked'].includes(t.stage),
      ).length + Object.values(this.data.deliveries).filter((d) => d.state === 'unknown').length
    );
  }
  snapshot(): Data {
    return structuredClone(this.data);
  }
  change<T>(fn: (draft: Data) => T): T {
    const next = structuredClone(this.data);
    const result = fn(next);
    const json = JSON.stringify(next);
    if (json === JSON.stringify(this.data) && existsSync(this.file)) return structuredClone(result);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, json);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
      this.data = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return structuredClone(result);
  }
  task(
    input: Pick<ScheduledTask, 'id' | 'kind' | 'sourceId' | 'sessionId' | 'title' | 'stage'> &
      Partial<ScheduledTask>,
  ): ScheduledTask {
    return this.change((d) => {
      const old = d.tasks[input.id];
      const now = Date.now();
      const defaults = {
        originSessionId: input.sessionId,
        detail: '',
        result: '',
        artifacts: [],
        createdAt: now,
        updatedAt: now,
        inputs: [],
        history: [],
        waits: [],
      };
      const task: ScheduledTask = Object.assign(defaults, old, input);
      if (task.waits.length && ['working', 'queued'].includes(task.stage))
        task.stage = task.waits.some((w) => w.kind === 'answer') ? 'answer' : 'review';
      if (task.stage !== old?.stage || task.detail !== old?.detail) {
        task.updatedAt = now;
        task.history.push({ stage: task.stage, detail: task.detail, at: now });
        task.history = task.history.slice(-200);
      }
      d.tasks[task.id] = task;
      if (
        !(task.kind === 'chat' && task.stage === 'completed') &&
        task.stage !== old?.stage &&
        ['answer', 'review', 'blocked', 'completed'].includes(task.stage)
      ) {
        d.notices.push({
          id: randomUUID(),
          taskId: task.id,
          stage: task.stage,
          title: task.title,
          sessionId: task.originSessionId,
          read: false,
          at: now,
        });
        d.notices = d.notices.slice(-500);
      }
      return task;
    });
  }
  enqueue(
    channel: string,
    peer: string,
    content: string,
    options: Record<string, unknown>,
    key: string,
  ): Delivery {
    return this.change((d) => {
      const id = stableId(channel + '\0' + key);
      const old = d.deliveries[id];
      if (old) {
        if (
          old.peer !== peer ||
          old.content !== content ||
          JSON.stringify(old.options) !== JSON.stringify(options)
        )
          throw new Error('Delivery key was already used for different content');
        return old;
      }
      return (d.deliveries[id] = {
        id,
        key,
        channel,
        peer,
        content,
        options,
        state: 'queued',
        attempts: 0,
        nextAt: Date.now(),
        createdAt: Date.now(),
        error: '',
      });
    });
  }
  saveRule(rule: Omit<TaskRule, 'revision' | 'nextAt'>, expected: number): TaskRule {
    return this.change((d) => {
      if (['__proto__', 'prototype', 'constructor'].includes(rule.id))
        throw new Error('Invalid rule ID');
      const old = Object.hasOwn(d.rules, rule.id) ? d.rules[rule.id] : undefined;
      if ((old?.revision ?? 0) !== expected)
        throw new RevisionConflict('Rule changed; reload before saving');
      const next = {
        ...rule,
        revision: expected + 1,
        nextAt: Date.now() + rule.intervalMinutes * 60_000,
      };
      d.rules[rule.id] = next;
      for (const admission of Object.values(d.admissions))
        if (admission.ruleId === rule.id && admission.state === 'queued') {
          admission.state = 'blocked';
          admission.reason = 'Rule changed after admission';
        }
      return next;
    });
  }
  admit(
    event: {
      id: string;
      source: TaskRule['source'];
      channel?: string;
      peer?: string;
      text: string;
      sessionId: string;
    },
    rule: TaskRule,
  ): Admission {
    return this.change((d) => {
      const id = stableId(rule.id + '\0' + event.id);
      if (d.admissions[id]) return d.admissions[id]!;
      const current = d.rules[rule.id];
      const valid = current?.revision === rule.revision;
      const mode = valid ? rule.mode : 'off';
      return (d.admissions[id] = {
        id,
        eventId: event.id,
        ruleId: rule.id,
        revision: rule.revision,
        mode,
        reason: !valid
          ? 'Rule changed'
          : mode === 'off'
            ? 'Rule disabled'
            : mode === 'observe'
              ? 'Observe only'
              : 'Matched configured rule',
        input: event.text,
        sessionId: event.sessionId,
        createdAt: Date.now(),
        state: mode === 'auto' ? 'queued' : 'observed',
      });
    });
  }
  permitted(mandate: { ruleId: string; revision: number }): boolean {
    const rule = this.data.rules[mandate.ruleId];
    return rule?.mode === 'auto' && rule.revision === mandate.revision;
  }
  prompt(id: string, initial: string, template = ''): PromptDocument {
    if (['__proto__', 'prototype', 'constructor'].includes(id))
      throw new Error('Invalid prompt ID');
    if (!Object.hasOwn(this.data.prompts, id))
      this.change((d) => {
        d.prompts[id] = {
          id,
          template,
          revisions: [{ revision: 1, text: initial, template, reason: 'initial', at: Date.now() }],
        };
      });
    return structuredClone(this.data.prompts[id]!);
  }
  savePrompt(id: string, text: string, expected: number, reason = 'edit'): PromptDocument {
    return this.change((d) => {
      const doc = d.prompts[id];
      if (!doc || doc.revisions.at(-1)?.revision !== expected)
        throw new RevisionConflict('Prompt changed; reload before saving');
      doc.revisions.push({
        revision: expected + 1,
        text,
        template: doc.template,
        reason,
        at: Date.now(),
      });
      return doc;
    });
  }
  upgradePrompt(id: string, template: string): PromptDocument {
    if (this.data.prompts[id]?.template === template)
      return structuredClone(this.data.prompts[id]!);
    return this.change((d) => {
      const doc = d.prompts[id];
      if (!doc) throw new Error('Prompt not found');
      if (doc.template === template) return doc;
      const current = doc.revisions.at(-1)!;
      if (current.text === doc.template) {
        doc.template = template;
        delete doc.pendingTemplate;
        doc.revisions.push({
          revision: current.revision + 1,
          text: template,
          template,
          reason: 'template upgrade',
          at: Date.now(),
        });
      } else doc.pendingTemplate = template;
      return doc;
    });
  }
  resolveTemplate(id: string, text: string, expected: number): PromptDocument {
    return this.change((d) => {
      const doc = d.prompts[id];
      if (!doc || doc.revisions.at(-1)?.revision !== expected)
        throw new RevisionConflict('Prompt changed; reload before saving');
      if (doc.pendingTemplate === undefined) throw new Error('No pending template');
      doc.template = doc.pendingTemplate;
      delete doc.pendingTemplate;
      doc.revisions.push({
        revision: expected + 1,
        text,
        template: doc.template,
        reason: 'template merge',
        at: Date.now(),
      });
      return doc;
    });
  }
}
