import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveWebDataDir } from '../../core/utils/web-data.util.js';

export type RunState = 'completed' | 'interrupted' | 'cancelled' | 'failed' | 'paused';
type Event = { type: string; at: number; [key: string]: unknown };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function directory(identity: string) {
  return join(resolveWebDataDir(), 'run-journal', hash(identity));
}

/** Append-before-execute journal. An unfinished step is UNKNOWN, never safe to replay automatically. */
export class RunJournal {
  private static active = new Set<string>();
  readonly id = randomUUID();
  private readonly path: string;
  constructor(identity: string, sessionId: string, task: string) {
    const root = directory(identity);
    mkdirSync(root, { recursive: true });
    this.path = join(root, this.id + '.jsonl');
    appendFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    this.append('start', { sessionId, taskHash: hash(task), pid: process.pid });
    RunJournal.active.add(this.id);
  }
  append(type: string, data: Record<string, unknown> = {}) {
    const fd = openSync(this.path, 'a');
    try {
      const bytes = Buffer.from(JSON.stringify({ ...data, type, at: Date.now() }) + '\n');
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  toolStarted(callId: string, name: string, args: unknown) {
    this.append('tool-start', { callId, name, argsHash: hash(JSON.stringify(args) ?? '') });
  }
  toolFinished(
    callId: string,
    result: { success: boolean; output?: string; data?: unknown; error?: string },
  ) {
    this.append('tool-result', {
      callId,
      success: result.success,
      resultHash: hash(JSON.stringify(result)),
      ...(typeof (result.data as { outputPath?: unknown })?.outputPath === 'string'
        ? { outputPath: (result.data as { outputPath: string }).outputPath }
        : {}),
    });
  }
  finish(state: RunState) {
    try {
      this.append('end', { state });
    } finally {
      RunJournal.active.delete(this.id);
    }
  }
  static list(identity: string, sessionId: string) {
    const root = directory(identity);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => /^[a-f0-9-]+\.jsonl$/.test(name))
      .flatMap((name) => {
        const lines = readFileSync(join(root, name), 'utf8').split('\n');
        // Only a final partial write can be ignored; corruption in the middle is surfaced.
        const events: Event[] = lines
          .slice(0, -1)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (events[0]?.['sessionId'] !== sessionId) return [];
        const pending = new Map<string, string>();
        for (const event of events) {
          if (event.type === 'tool-start')
            pending.set(String(event['callId']), String(event['name']));
          if (event.type === 'tool-result') pending.delete(String(event['callId']));
        }
        const last = events.at(-1);
        return [
          {
            id: name.slice(0, -6),
            startedAt: events[0]!.at,
            state:
              last?.type === 'end'
                ? last['state']
                : RunJournal.active.has(name.slice(0, -6))
                  ? 'running'
                  : 'interrupted',
            uncertainTools: [...pending].map(([callId, name]) => ({
              callId,
              name,
              state: 'unknown',
            })),
            events,
          },
        ];
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }
}
