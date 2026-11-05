import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@skyalyticwing/shared';
import { SessionService } from '../../src/modules/session/session.service.js';
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

describe('SessionService', () => {
  let service: SessionService;
  let dataDir: string;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), 'sessionsvc-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    service = new SessionService(loggerMock);
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    dateNowSpy.mockRestore();
    delete process.env['SKYALYTICWING_DATA_DIR'];
  });

  describe('会话 CRUD', () => {
    it('createSession 返回 SessionInfo（默认标题 + UUID id）', () => {
      const info = service.createSession();

      expect(info.id).toMatch(/[0-9a-f-]{36}/);
      expect(info.title).toBe('New chat');
      expect(info.messageCount).toBe(0);
      expect(info.createdAt).toBe(nowMs);

      const item = service.getSession(info.id);
      expect(item).toBeDefined();
      expect(item?.messages).toEqual([]);
    });

    it('uses the first user prompt as title and preserves custom names', () => {
      const session = service.createSession();
      service.addMessage(session.id, { ...msg(1), content: '  Review   this project  ' });
      expect(service.getSession(session.id)?.title).toBe('Review this project');
      service.updateSessionMeta(session.id, {title:'My saved task'});
      service.addMessage(session.id, msg(2));
      expect(service.getSession(session.id)?.title).toBe('My saved task');
      const custom = service.createSession('Explicit name');
      service.addMessage(custom.id,msg(3));
      expect(service.getSession(custom.id)?.title).toBe('Explicit name');
    });
    it('createSession 支持自定义标题', () => {
      expect(service.createSession('调试会话').title).toBe('调试会话');
    });

    it('getSession 不存在返回 undefined', () => {
      expect(service.getSession('no-such')).toBeUndefined();
    });

    it('listSessions 按更新时间倒序', () => {
      const s1 = service.createSession('older');
      nowMs += 1_000;
      const s2 = service.createSession('newer');
      nowMs += 1_000;
      const s3 = service.createSession('newest');

      expect(service.listSessions().map((s) => s.id)).toEqual([s3.id, s2.id, s1.id]);
    });

    it('deleteSession 删除后不可获取且不再列出', () => {
      const info = service.createSession();
      service.addMessage(info.id, msg(1));

      service.deleteSession(info.id);

      expect(service.getSession(info.id)).toBeUndefined();
      expect(service.listSessions().map((s) => s.id)).not.toContain(info.id);
      expect(service.getMessages(info.id)).toEqual([]);
    });

    it('deleteSession 不存在的 id 不抛错不落盘', () => {
      expect(() => service.deleteSession('ghost')).not.toThrow();
    });
  });

  describe('deleteAllSessions', () => {
    it('批量删除并返回删除数量', () => {
      const a = service.createSession();
      const b = service.createSession();

      expect(service.deleteAllSessions()).toBe(2);
      expect(service.listSessions()).toHaveLength(0);
      expect(service.getSession(a.id)).toBeUndefined();
      expect(service.getSession(b.id)).toBeUndefined();
    });

    it('keepIds 保留指定会话', () => {
      const a = service.createSession('keep-me');
      const b = service.createSession('drop-me');

      expect(service.deleteAllSessions([a.id])).toBe(1);
      expect(service.listSessions().map((s) => s.id)).toEqual([a.id]);
      expect(service.getSession(b.id)).toBeUndefined();
    });
  });

  describe('消息读写', () => {
    it('addMessage 追加消息并更新 messageCount / updatedAt', () => {
      const info = service.createSession();
      service.addMessage(info.id, msg(1));
      nowMs += 500;
      service.addMessage(info.id, msg(2));

      const messages = service.getMessages(info.id);
      expect(messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);

      const listed = service.listSessions().find((s) => s.id === info.id);
      expect(listed?.messageCount).toBe(2);
      expect(listed?.updatedAt).toBe(nowMs);
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

      expect(service.getMessages(sid, 2).map((m) => m.id)).toEqual(['m-3', 'm-4']);
    });

    it('getMessages 不存在的会话返回空数组', () => {
      expect(service.getMessages('no-such')).toEqual([]);
    });

    it('replaceMessages 整体替换消息（压缩场景）', () => {
      const info = service.createSession();
      service.addMessage(info.id, msg(1));
      service.addMessage(info.id, msg(2));

      const ok = service.replaceMessages(info.id, [msg(99)]);

      expect(ok).toBe(true);
      expect(service.getMessages(info.id).map((m) => m.id)).toEqual(['m-99']);
    });

    it('replaceMessages 会话不存在返回 false', () => {
      expect(service.replaceMessages('ghost', [])).toBe(false);
    });
  });

  describe('完整历史保留', () => {
    it('超过 500 条仍保留最旧消息并能从磁盘恢复', async () => {
      const sid = 'cap-test';
      for (let i = 0; i < 505; i++) service.addMessage(sid, msg(i));

      const messages = service.getMessages(sid);
      expect(messages).toHaveLength(505);
      expect(messages[0]?.id).toBe('m-0');
      expect(messages[504]?.id).toBe('m-504');
      await service.flush();
      const reloaded = new SessionService(loggerMock); reloaded.onModuleInit();
      expect(reloaded.getMessages(sid)).toEqual(messages);
      await reloaded.onModuleDestroy();
    });

    it('恰好 500 条时不裁剪', () => {
      const sid = 'exact-500';
      for (let i = 0; i < 500; i++) service.addMessage(sid, msg(i));

      expect(service.getMessages(sid)).toHaveLength(500);
      expect(service.getMessages(sid)[0]?.id).toBe('m-0');
    });
  });

  describe('updateSessionMeta', () => {
    it('更新 title/model/agent/pinned 并体现在 listSessions', () => {
      const info = service.createSession();
      nowMs += 1_000;

      service.updateSessionMeta(info.id, {
        title: '新标题',
        model: 'gpt-4o',
        agent: 'coder',
        pinned: true,
      });

      const item = service.getSession(info.id);
      expect(item).toMatchObject({
        title: '新标题',
        model: 'gpt-4o',
        agent: 'coder',
        pinned: true,
      });
      expect(item?.updatedAt).toBe(nowMs);

      const listed = service.listSessions()[0];
      expect(listed?.model).toBe('gpt-4o');
      expect(listed?.agent).toBe('coder');
    });

    it('会话不存在时静默返回', () => {
      expect(() => service.updateSessionMeta('ghost', { title: 'x' })).not.toThrow();
    });
  });

  describe('持久化', () => {
    it('会话数据写入 sessions.json（防抖 500ms 后落盘）', async () => {
      const info = service.createSession('persist-me');
      service.addMessage(info.id, msg(1));

      // 持久化为 500ms 防抖异步写盘（P0 性能修复：每条消息同步 writeFileSync
      // 全量 sessions.json 会冻结事件循环），此处等待防抖触发 + 写盘完成
      await service.flush();

      const file = join(dataDir, 'sessions.json');
      expect(existsSync(file)).toBe(true);

      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<
        string,
        { title: string; messages: ChatMessage[] }
      >;
      expect(raw[info.id]?.title).toBe('persist-me');
      expect(raw[info.id]?.messages).toHaveLength(1);
    });

    it('新实例 onModuleInit 从 sessions.json 恢复数据', async () => {
      const info = service.createSession('restore-me');
      service.addMessage(info.id, msg(1));
      service.addMessage(info.id, msg(2));

      // 等待防抖落盘后再用新实例恢复（同上：异步持久化语义）
      await service.flush();

      const revived = new SessionService(loggerMock);
      revived.onModuleInit();

      expect(revived.getSession(info.id)?.title).toBe('restore-me');
      expect(revived.getMessages(info.id).map((m) => m.id)).toEqual(['m-1', 'm-2']);
      expect(revived.listSessions()[0]?.messageCount).toBe(2);
    });

    it('损坏会话且缺少备份时保留原文件，继续启动并持久化新会话', async () => {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(join(dataDir, 'sessions.json'), 'not-json{{', 'utf-8');

      const revived = new SessionService(loggerMock);
      expect(() => revived.onModuleInit()).not.toThrow();
      expect(revived.listSessions()).toHaveLength(0);
      expect(loggerMock.warn).toHaveBeenCalled();
      const recovery = revived.getRecoveryNotice()!;
      expect(readFileSync(join(recovery.archiveDirectory, 'sessions.json'), 'utf8')).toBe('not-json{{');
      const created = revived.createSession('after recovery');
      await revived.flush();
      const next = new SessionService(loggerMock);
      next.onModuleInit();
      expect(next.getSession(created.id)?.title).toBe('after recovery');
      expect(next.getRecoveryNotice()?.archiveDirectory).toBe(recovery.archiveDirectory);
      expect(readFileSync(join(recovery.archiveDirectory, 'sessions.json'), 'utf8')).toBe('not-json{{');
    });

    it('兼容 UTF-8 BOM 会话文件，不错误触发恢复', async () => {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      const created = service.createSession('BOM history');
      await service.flush();
      const file = join(dataDir, 'sessions.json');
      writeFileSync(file, '\uFEFF' + readFileSync(file, 'utf8'));
      const revived = new SessionService(loggerMock);
      revived.onModuleInit();
      expect(revived.getSession(created.id)?.title).toBe('BOM history');
      expect(revived.getRecoveryNotice()).toBeNull();
    });
  });
});
