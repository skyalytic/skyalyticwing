import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@skyalyticwing/shared';
import { SessionStoreService } from '../../src/modules/session/session-store.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

const msg = (i: number): ChatMessage => ({
  id: `m-${i}`,
  role: 'user',
  content: `message ${i}`,
  timestamp: 1_700_000_000_000 + i,
});

/** 等待 persist() 的写入锁队列落盘 */
const flushWrites = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SessionStoreService', () => {
  let service: SessionStoreService;
  let dataDir: string;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), 'sessionstore-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    service = new SessionStoreService(loggerMock);
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    service.onModuleInit();
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    delete process.env['SKYALYTICWING_DATA_DIR'];
  });

  describe('会话 CRUD', () => {
    it('createSession 返回 SessionInfo（默认标题）', () => {
      const info = service.createSession();

      expect(info.id).toBeTruthy();
      expect(info.title).toMatch(/^Session /);
      expect(info.messageCount).toBe(0);
      expect(info.createdAt).toBe(nowMs);
      expect(info.updatedAt).toBe(nowMs);

      const item = service.getSession(info.id);
      expect(item).toBeDefined();
      expect(item?.messages).toEqual([]);
    });

    it('createSession 支持自定义标题', () => {
      const info = service.createSession('调试会话');
      expect(info.title).toBe('调试会话');
    });

    it('getSession 不存在返回 undefined', () => {
      expect(service.getSession('no-such-session')).toBeUndefined();
    });

    it('listSessions 按更新时间倒序排列', () => {
      const s1 = service.createSession('older');
      nowMs += 1_000;
      const s2 = service.createSession('newer');
      nowMs += 1_000;
      const s3 = service.createSession('newest');

      const list = service.listSessions();
      expect(list.map((s) => s.id)).toEqual([s3.id, s2.id, s1.id]);
    });

    it('deleteSession 删除后不可获取', () => {
      const info = service.createSession();
      service.addMessage(info.id, msg(1));

      service.deleteSession(info.id);

      expect(service.getSession(info.id)).toBeUndefined();
      expect(service.listSessions().map((s) => s.id)).not.toContain(info.id);
      expect(service.getMessages(info.id)).toEqual([]);
    });
  });

  describe('消息读写', () => {
    it('addMessage 向已有会话追加消息', () => {
      const info = service.createSession();
      service.addMessage(info.id, msg(1));
      service.addMessage(info.id, msg(2));

      const messages = service.getMessages(info.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe('m-1');
      expect(messages[1]?.id).toBe('m-2');
      expect(service.listSessions()[0]?.messageCount).toBe(2);
    });

    it('addMessage 对不存在的会话自动创建', () => {
      service.addMessage('auto-created', msg(1));

      const item = service.getSession('auto-created');
      expect(item).toBeDefined();
      expect(service.getMessages('auto-created')).toHaveLength(1);
    });

    it('getMessages 支持 limit 截取最新消息', () => {
      const sid = 'limit-test';
      for (let i = 0; i < 5; i++) service.addMessage(sid, msg(i));

      const lastTwo = service.getMessages(sid, 2);
      expect(lastTwo.map((m) => m.id)).toEqual(['m-3', 'm-4']);
    });

    it('getMessages 不存在的会话返回空数组', () => {
      expect(service.getMessages('no-such')).toEqual([]);
    });
  });

  describe('完整历史保留', () => {
    it('超过 500 条仍保留最旧消息并能从磁盘恢复', async () => {
      const sid = 'cap-test';
      for (let i = 0; i < 505; i++) {
        service.addMessage(sid, msg(i));
      }

      const messages = service.getMessages(sid);
      expect(messages).toHaveLength(505);
      expect(messages[0]?.id).toBe('m-0');
      expect(messages[504]?.id).toBe('m-504');
      await flushWrites();
      const reloaded = new SessionStoreService(loggerMock); reloaded.onModuleInit();
      expect(reloaded.getMessages(sid)).toEqual(messages);
    });

    it('恰好 500 条时不裁剪', () => {
      const sid = 'exact-500';
      for (let i = 0; i < 500; i++) {
        service.addMessage(sid, msg(i));
      }
      expect(service.getMessages(sid)).toHaveLength(500);
      expect(service.getMessages(sid)[0]?.id).toBe('m-0');
    });
  });

  describe('持久化', () => {
    it('会话数据持久化到 sessions.json', async () => {
      const info = service.createSession('persist-me');
      service.addMessage(info.id, msg(1));
      await flushWrites();

      const filePath = join(dataDir, 'sessions.json');
      expect(existsSync(filePath)).toBe(true);

      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<
        string,
        { title: string; messages: ChatMessage[] }
      >;
      expect(raw[info.id]).toBeDefined();
      expect(raw[info.id]?.title).toBe('persist-me');
      expect(raw[info.id]?.messages).toHaveLength(1);
    });
  });
});
