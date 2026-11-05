import 'reflect-metadata';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { documentChangeDetail, documentSnapshot, listDocumentChanges, restoreDocumentChange, trackDocumentMutationSync, rollbackDocumentSession, withDocumentSession } from '../../src/modules/tools/files/document-history.js';
import { watchProjectChanges } from '../../src/modules/tools/files/project-history-watch.js';

describe('persistent document changes', () => {
  let dir: string, project: string, old: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wing-history-')); project = join(dir, 'project'); mkdirSync(project); old = process.env['SKYALYTICWING_DATA_DIR']; process.env['SKYALYTICWING_DATA_DIR'] = join(dir, 'data'); });
  afterEach(() => { if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = old; rmSync(dir, { recursive: true, force: true }); });
  it('text diffs, undo, redo and persisted snapshot download', () => {
    const file = join(project, '方案.txt'); writeFileSync(file, '原文\n');
    trackDocumentMutationSync(file, () => writeFileSync(file, '新内容\n第二行\n'));
    const c = listDocumentChanges(project)[0]!;
    expect(documentChangeDetail(c.id)).toMatchObject({ added: 2, removed: 1, compatible: true });
    expect(readFileSync(documentSnapshot(c.id, 'before').path, 'utf8')).toBe('原文\n');
    restoreDocumentChange(c.id); expect(readFileSync(file, 'utf8')).toBe('原文\n');
    expect(listDocumentChanges(project)[0]!.state).toBe('undone');
    restoreDocumentChange(c.id); expect(readFileSync(file, 'utf8')).toBe('新内容\n第二行\n');
  });
  it('binary snapshots are byte exact; no fabricated line diff', () => {
    const file = join(project, '演示.ppt'); const original = Buffer.from([0, 1, 255, 3]); writeFileSync(file, original);
    trackDocumentMutationSync(file, () => writeFileSync(file, Buffer.from([0, 8, 250])));
    const c = listDocumentChanges(project)[0]!;
    expect(documentChangeDetail(c.id)).toMatchObject({ binary: true, diff: '' });
    restoreDocumentChange(c.id); expect(readFileSync(file)).toEqual(original);
  });
  it('creation and deletion can be undone and redone', () => {
    const file = join(project, 'new.txt'); trackDocumentMutationSync(file, () => writeFileSync(file, 'created'));
    const c = listDocumentChanges(project)[0]!; restoreDocumentChange(c.id); expect(documentChangeDetail(c.id).compatible).toBe(true); restoreDocumentChange(c.id);
    trackDocumentMutationSync(file, () => unlinkSync(file)); const deleted = listDocumentChanges(project).find(c => !c.after)!;
    restoreDocumentChange(deleted.id); expect(readFileSync(file, 'utf8')).toBe('created');
  });
  it('later and external edits prevent overwrite; unchanged writes add no history', () => {
    const file = join(project, 'note.txt'); writeFileSync(file, 'original');
    trackDocumentMutationSync(file, () => writeFileSync(file, 'original')); expect(listDocumentChanges(project)).toHaveLength(0);
    trackDocumentMutationSync(file, () => writeFileSync(file, 'wing'));
    const c = listDocumentChanges(project)[0]!; writeFileSync(file, 'external');
    expect(() => restoreDocumentChange(c.id)).toThrow('后续修改'); expect(readFileSync(file, 'utf8')).toBe('external');
    expect(documentChangeDetail(c.id).compatible).toBe(false);
  });
  it('terminal workspace watcher captures external writes and skips dependency folders', async () => {
    const file = join(project, 'terminal.txt'); writeFileSync(file, 'before'); mkdirSync(join(project, 'node_modules'));
    const tracking = watchProjectChanges(project);
    try {
      writeFileSync(file, 'after'); writeFileSync(join(project, 'node_modules', 'ignored.txt'), 'ignore');
      await new Promise(r => setTimeout(r, 450));
      const changes = listDocumentChanges(project); expect(changes).toHaveLength(1); restoreDocumentChange(changes[0]!.id);
      expect(readFileSync(file, 'utf8')).toBe('before');
    } finally { tracking.close(); }
  });
  it('three rounds roll back together to before round one; external changes abort the whole batch', async () => {
    const file = join(project, 'rounds.txt'), other = join(project, 'other.txt'); writeFileSync(file, 'before round one'); writeFileSync(other, 'other original');
    const start = Date.now();
    for (const value of ['round one', 'round two', 'round three']) withDocumentSession('conversation', () => trackDocumentMutationSync(file, () => writeFileSync(file, value)));
    withDocumentSession('conversation', () => trackDocumentMutationSync(other, () => writeFileSync(other, 'changed')));
    writeFileSync(other, 'external edit');
    await expect(rollbackDocumentSession('conversation', start, () => true)).rejects.toThrow('对话之外');
    expect(readFileSync(file, 'utf8')).toBe('round three');
    writeFileSync(other, 'changed');
    await rollbackDocumentSession('conversation', start, () => true);
    expect(readFileSync(file, 'utf8')).toBe('before round one'); expect(readFileSync(other, 'utf8')).toBe('other original');
    expect(listDocumentChanges(project).every(c => c.state === 'undone')).toBe(true);
  });
  it('an oversized baseline file cannot be mistaken for a new file after it shrinks', async () => {
    const file = join(project, 'large.txt'); writeFileSync(file, 'existing'); truncateSync(file, 33 * 1024 * 1024);
    const tracking = watchProjectChanges(project);
    try {
      writeFileSync(file, 'existing but smaller');
      await new Promise(r => setTimeout(r, 450));
      expect(tracking.warning).not.toContain('超出部分不记录');
      const changes=listDocumentChanges(project);expect(changes).toHaveLength(1);
      expect(changes[0]!.before?.size).toBe(33*1024*1024);
      restoreDocumentChange(changes[0]!.id);expect(readFileSync(file).length).toBe(33*1024*1024);
    } finally { tracking.close(); }
  }, 30000);
});
