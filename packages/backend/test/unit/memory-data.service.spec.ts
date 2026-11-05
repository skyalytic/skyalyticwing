import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDataService } from '../../src/modules/memory/memory-data.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as LoggerService;

describe('MemoryDataService', () => {
  let service: MemoryDataService;
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env['SKYALYTICWING_DATA_DIR'];
    dataDir = mkdtempSync(join(tmpdir(), 'memory-data-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    service = new MemoryDataService(loggerMock);
    service.onModuleInit();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previousDataDir;
  });

  describe('deleteKnowledge（DELETE /api/memory/knowledge/:id 后端逻辑）', () => {
    it('删除已存在的知识条目并持久化到 memory.json', () => {
      const added = service.addKnowledge('测试标题', '测试内容', ['tag1']);
      expect(service.listKnowledge()).toHaveLength(1);

      expect(service.deleteKnowledge(added.id)).toBe(true);
      expect(service.listKnowledge()).toHaveLength(0);

      // 持久化验证：memory.json 已同步，新实例重新加载后条目仍为空
      const raw = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf-8')) as {
        knowledge: unknown[];
      };
      expect(raw.knowledge).toHaveLength(0);
      const reloaded = new MemoryDataService(loggerMock);
      reloaded.onModuleInit();
      expect(reloaded.listKnowledge()).toHaveLength(0);
    });

    it('删除不存在的 id 返回 false 且不影响现有条目', () => {
      const added = service.addKnowledge('测试标题', '测试内容');
      expect(service.deleteKnowledge('know-not-exist')).toBe(false);
      expect(service.listKnowledge()).toHaveLength(1);
      expect(service.listKnowledge()[0]!.id).toBe(added.id);
    });
  });
});
