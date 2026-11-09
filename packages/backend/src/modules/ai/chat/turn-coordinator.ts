import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import type { AgentLoopEvent } from '../types.js';

type Snapshot = { fingerprint: string; state: 'running' | 'finished'; events: AgentLoopEvent[] };
type Live = {
  fingerprint: string;
  events: AgentLoopEvent[];
  offset: number;
  bytes: number;
  finished: boolean;
  listeners: Set<() => void>;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function save(file: string, data: Snapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Network subscribers do not own execution. A request ID commits once, scoped to account and session. */
export class TurnCoordinator {
  private readonly live = new Map<string, Live>();
  async *run(
    identity: string,
    session: string,
    turn: string,
    payload: unknown,
    producer: () => AsyncGenerator<AgentLoopEvent>,
  ): AsyncGenerator<AgentLoopEvent> {
    if (!turn || turn.length > 200) throw Error('Invalid turn ID');
    const file = join(
      getDefaultDataDir(),
      'turns',
      hash(identity),
      hash(session + '\0' + turn) + '.json',
    );
    const fingerprint = hash(JSON.stringify(payload));
    let current = this.live.get(file);
    if (!current) {
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
        if (saved.fingerprint !== fingerprint) throw Error('Turn ID is bound to another request');
        if (saved.state !== 'finished' || !Array.isArray(saved.events))
          throw Error(
            'Previous turn was interrupted; inspect its recorded actions before starting a new turn',
          );
        yield* saved.events;
        return;
      }
      current = {
        fingerprint,
        events: [],
        offset: 0,
        bytes: 0,
        finished: false,
        listeners: new Set(),
      };
      save(file, { fingerprint, state: 'running', events: [] });
      this.live.set(file, current);
      const run = current;
      void (async () => {
        const durable: AgentLoopEvent[] = [];
        const publish = (event: AgentLoopEvent) => {
          run.events.push(event);
          run.bytes += JSON.stringify(event).length;
          while (run.events.length > 1 && (run.events.length > 512 || run.bytes > 8_000_000)) {
            run.bytes -= JSON.stringify(run.events.shift()).length;
            run.offset++;
          }
          for (const wake of run.listeners) wake();
        };
        try {
          for await (const event of producer()) {
            if (
              (event.type === 'assistant_message' && event.message?.phase !== 'progress') ||
              event.type === 'error' ||
              event.type === 'done'
            )
              durable.push(event);
            publish(event);
          }
          save(file, { fingerprint, state: 'finished', events: durable });
        } catch (error) {
          publish({ type: 'error', error: error instanceof Error ? error.message : String(error) });
          // Keep durable running marker: an exceptional/uncertain outcome must not auto-replay.
        } finally {
          run.finished = true;
          for (const wake of run.listeners) wake();
          this.live.delete(file);
        }
      })();
    }
    if (current.fingerprint !== fingerprint) throw Error('Turn ID is bound to another request');
    let cursor = current.offset;
    while (true) {
      if (cursor < current.offset) throw Error('Replay window expired; reload session history');
      if (cursor < current.offset + current.events.length) {
        yield current.events[cursor++ - current.offset]!;
        continue;
      }
      if (current.finished) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          current!.listeners.delete(wake);
          resolve();
        };
        current!.listeners.add(wake);
      });
    }
  }
}
