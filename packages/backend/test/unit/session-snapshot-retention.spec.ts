import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../../src/modules/session/session.service';
import { SessionSnapshotService } from '../../src/modules/session/session-snapshot.service';

it('restores every message from a snapshot beyond both old 100/500-message boundaries', async () => {
  const previous = process.env['SKYALYTICWING_DATA_DIR'];
  const dir = mkdtempSync(join(tmpdir(), 'wing-snapshot-audit-'));
  process.env['SKYALYTICWING_DATA_DIR'] = dir;
  const logger: any = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
  const sessions = new SessionService(logger); sessions.onModuleInit();
  try {
    const id = sessions.createSession().id;
    for (let i = 0; i < 600; i++) sessions.addMessage(id, { id: String(i), role: 'user', content: 'message ' + i, timestamp: i });
    const snapshots = new SessionSnapshotService(sessions, logger);
    expect(snapshots.saveSession(id)).toBe(true);
    sessions.replaceMessages(id, []);
    expect(snapshots.restoreSession(id)?.messages.length).toBe(600);
    expect(sessions.getMessages(id)[0]?.id).toBe('0');
    await sessions.flush();
  } finally {
    await sessions.onModuleDestroy();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
