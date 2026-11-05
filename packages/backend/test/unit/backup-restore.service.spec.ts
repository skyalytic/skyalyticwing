import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupService } from '../../src/modules/core/backup/backup.service.js';
import type { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as LoggerService;

/** SecurityManager mock：路径校验全部放行 */
const securityMock = {
  isPathAllowed: () => true,
  addAllowedPath: () => undefined,
} as unknown as SecurityManagerService;

/**
 * 回归测试：备份恢复 cron 任务格式。
 * cron.service 读取 { jobs: Record<string, job> } 包装格式，
 * 恢复时必须包一层 jobs，否则恢复后 cron 任务全部丢失。
 */
describe('BackupService.restore cron.json 格式（POST /api/backup/restore 后端逻辑）', () => {
  let dataDir: string;
  let backupsDir: string;
  const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'backup-restore-test-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    backupsDir = join(dataDir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('恢复时 cron.json 写入 { jobs } 包装格式，任务不丢失', () => {
    const cronJobs = {
      'job-1': { id: 'job-1', name: 'daily-report', schedule: '0 9 * * *' },
      'job-2': { id: 'job-2', name: 'weekly-clean', schedule: '0 0 * * 0' },
    };
    const backupPath = join(backupsDir, 'backup-cron.json');
    writeFileSync(
      backupPath,
      JSON.stringify({ schemaVersion: 1, createdAt: Date.now(), timestamp: 't', cronJobs }),
      'utf-8',
    );

    const service = new BackupService(loggerMock, securityMock);
    const result = service.restore('backup-cron.json');
    expect(result.success).toBe(true);

    const cronPath = join(dataDir, 'cron.json');
    expect(existsSync(cronPath)).toBe(true);
    const restored = JSON.parse(readFileSync(cronPath, 'utf-8')) as {
      jobs?: Record<string, unknown>;
    };
    expect(restored.jobs).toEqual(cronJobs);
  });

  it('备份中无 cronJobs 时不写 cron.json', () => {
    // 清理上一个用例写入的 cron.json，保证断言隔离
    const cronPath = join(dataDir, 'cron.json');
    if (existsSync(cronPath)) unlinkSync(cronPath);

    const backupPath = join(backupsDir, 'backup-no-cron.json');
    writeFileSync(
      backupPath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: Date.now(),
        timestamp: 't',
        config: { key: 'value' },
      }),
      'utf-8',
    );

    const service = new BackupService(loggerMock, securityMock);
    const result = service.restore('backup-no-cron.json');
    expect(result.success).toBe(true);
    expect(existsSync(cronPath)).toBe(false);
  });

  it('does not claim success or write a partial backup when a workspace file exceeds the legacy format', () => {
    const workspace = join(dataDir, 'workspaces');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(200_000));
    const service = new BackupService(loggerMock, securityMock);
    const before = service.list().map(b => b.name);
    const result = service.create({ includeWorkspace: true });
    expect(result.success).toBe(false);
    expect('error' in result && result.error).toContain('未生成不完整备份');
    expect(service.list().map(b => b.name)).toEqual(before);
  });

  it('reports denied restore writes as a failure instead of claiming all data was restored', () => {
    writeFileSync(join(backupsDir, 'denied.json'), JSON.stringify({ config: { restore: true } }));
    const denied = { ...securityMock, isPathAllowed: () => false } as unknown as SecurityManagerService;
    expect(new BackupService(loggerMock, denied).restore('denied.json').success).toBe(false);
  });
});
