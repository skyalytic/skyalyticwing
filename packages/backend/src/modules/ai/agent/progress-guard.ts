import { createHash } from 'node:crypto';

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(
          ([key]) =>
            !['timestamp', 'durationMs', 'lookId', 'observationId', 'screenshotId'].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? '';
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

/** IDs prevent duplicate dispatch; outcome fingerprints catch alternating no-progress loops. */
export class ProgressGuard {
  private readonly ids = new Set<string>();
  private readonly recent: string[] = [];
  before(id: string): void {
    if (!id || this.ids.has(id))
      throw Error('Duplicate tool call ID; earlier operation was not replayed');
    this.ids.add(id);
  }
  after(name: string, args: unknown, result: unknown): void {
    const fingerprint = digest({ name, args, result });
    this.recent.push(fingerprint);
    if (this.recent.length > 16) this.recent.shift();
    // Require repeated contiguous cycles, not simply several reads of the same
    // file separated by useful, different work.
    for (let size = 1; size <= 4; size++) {
      if (this.recent.length < size * 4) continue;
      const tail = this.recent.slice(-size * 4);
      if (tail.every((value, index) => value === tail[index % size]))
        throw Error(
          'Repeated operations produced no new evidence; inspect the recorded result before continuing',
        );
    }
  }
}
