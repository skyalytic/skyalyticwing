import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AuditRecord {
  id: string;
  at: string;
  tool: string;
  sessionId?: string;
  decision: string;
  policyVersion: string;
  durationMs?: number;
  success?: boolean;
}

/** Metadata only: never writes tool arguments, outputs or credentials. */
export class AuditJournal {
  constructor(private readonly dir: string) {}
  private file(): string {
    return join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  }
  append(event: Omit<AuditRecord, 'id' | 'at'>): void {
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(this.file(), 'a', 0o600);
    try {
      appendFileSync(
        fd,
        JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...event }) + '\n',
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  recent(limit = 100): AuditRecord[] {
    let fd: number;
    try {
      fd = openSync(this.file(), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - 1024 * 1024);
      const data = Buffer.alloc(size - start);
      readSync(fd, data, 0, data.length, start);
      const lines = data.toString('utf8').split('\n');
      if (start) lines.shift();
      return lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditRecord];
          } catch {
            return [];
          }
        })
        .slice(-Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, 1000)));
    } finally {
      closeSync(fd);
    }
  }
}
