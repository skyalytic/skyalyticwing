import 'reflect-metadata';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileRollbackError,
  recordFileCheckpoint,
  rollbackFileCheckpoints,
} from '../../src/modules/tools/files/checkpoint-store.js';
import { FilesController } from '../../src/modules/tools/files/files.controller.js';
import { HttpException } from '@nestjs/common';

describe('file checkpoint recovery', () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'sky-checkpoint-audit-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('失败保留检查点；补回目录后能够重试恢复', async () => {
    const target = join(dir, 'missing', 'file.txt');
    recordFileCheckpoint(dir, target, 'original', 'new');
    await expect(rollbackFileCheckpoints(dir, 0)).rejects.toBeInstanceOf(FileRollbackError);
    const checkpoint = join(dir, 'checkpoints', readdirSync(join(dir, 'checkpoints'))[0]!);
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toHaveLength(1);
    mkdirSync(join(dir, 'missing'));
    writeFileSync(target, 'new');
    await expect(rollbackFileCheckpoints(dir, 0)).resolves.toEqual([target]);
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual([]);
  });

  it('同会话并发回滚串行且不会重复消费检查点', async () => {
    const target = join(dir, 'file.txt');
    writeFileSync(target, 'new');
    recordFileCheckpoint(dir, target, 'old', 'new');
    const results = await Promise.all([
      rollbackFileCheckpoints(dir, 0),
      rollbackFileCheckpoints(dir, 0),
    ]);
    expect(results).toEqual([[target], []]);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('部分失败返回 HTTP 409 和成功/失败明细，其他文件仍能恢复', async () => {
    const good = join(dir, 'good.txt');
    const bad = join(dir, 'missing', 'bad.txt');
    recordFileCheckpoint(dir, good, 'good original', 'new');
    writeFileSync(good, 'new');
    recordFileCheckpoint(dir, bad, 'bad original', 'new');
    const controller = new FilesController({} as any);
    try {
      await controller.rollback({ sessionId: dir, sinceTs: 0 });
      throw new Error('expected partial failure');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(409);
      expect((err as HttpException).getResponse()).toMatchObject({
        success: false,
        restored: [good],
        failed: [bad],
      });
    }
    expect(readFileSync(good, 'utf8')).toBe('good original');
  });
});
