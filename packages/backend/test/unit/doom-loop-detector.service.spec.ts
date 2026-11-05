import 'reflect-metadata';
import { DoomLoopDetectorService } from '../../src/modules/session/doom-loop-detector.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

describe('DoomLoopDetectorService', () => {
  let service: DoomLoopDetectorService;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DoomLoopDetectorService(loggerMock);
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe('trackToolCall - 相同 args 哈希阈值', () => {
    it('相同调用前 2 次不触发（阈值 3）', () => {
      const args = { path: '/a.txt' };
      const r1 = service.trackToolCall('s1', 'file_read', args);
      const r2 = service.trackToolCall('s1', 'file_read', args);

      expect(r1).toEqual({ detected: false, count: 1 });
      expect(r2).toEqual({ detected: false, count: 2 });
    });

    it('第 3 次相同调用触发 doom loop', () => {
      const args = { path: '/a.txt' };
      service.trackToolCall('s1', 'file_read', args);
      service.trackToolCall('s1', 'file_read', args);
      const r3 = service.trackToolCall('s1', 'file_read', args);

      expect(r3.detected).toBe(true);
      expect(r3.count).toBe(3);
      expect(r3.tool).toBe('file_read');
      expect(loggerMock.warn).toHaveBeenCalled();
      expect(service.checkDoomLoop('s1')).toBe(true);
    });

    it('不同 args 打断连续计数', () => {
      service.trackToolCall('s1', 'file_read', { path: '/a.txt' });
      service.trackToolCall('s1', 'file_read', { path: '/a.txt' });
      service.trackToolCall('s1', 'file_read', { path: '/b.txt' });
      const r4 = service.trackToolCall('s1', 'file_read', { path: '/a.txt' });

      expect(r4.detected).toBe(false);
      expect(r4.count).toBe(1);
    });

    it('args 键顺序不同视为不同调用（JSON 序列化哈希）', () => {
      service.trackToolCall('s1', 'tool', { a: 1, b: 2 });
      service.trackToolCall('s1', 'tool', { a: 1, b: 2 });
      const r3 = service.trackToolCall('s1', 'tool', { b: 2, a: 1 });

      expect(r3.detected).toBe(false);
      expect(r3.count).toBe(1);
    });

    it('不同工具名打断连续计数', () => {
      service.trackToolCall('s1', 'file_read', {});
      service.trackToolCall('s1', 'file_read', {});
      const r3 = service.trackToolCall('s1', 'file_write', {});
      expect(r3.detected).toBe(false);
      expect(r3.count).toBe(1);
    });
  });

  describe('trackToolCall - 60s 时间窗口', () => {
    it('超出 60s 窗口的旧调用被清理，不触发', () => {
      service.trackToolCall('s1', 'file_read', { p: 1 });
      service.trackToolCall('s1', 'file_read', { p: 1 });
      // 推进到窗口外（60_001ms）
      nowMs += 60_001;
      const r3 = service.trackToolCall('s1', 'file_read', { p: 1 });

      expect(r3.detected).toBe(false);
      expect(r3.count).toBe(1);
    });

    it('窗口边界内（<60s）的调用仍计入', () => {
      service.trackToolCall('s1', 'file_read', { p: 1 });
      service.trackToolCall('s1', 'file_read', { p: 1 });
      // 推进 59_999ms，仍在 60s 窗口内
      nowMs += 59_999;
      const r3 = service.trackToolCall('s1', 'file_read', { p: 1 });

      expect(r3.detected).toBe(true);
      expect(r3.count).toBe(3);
    });

    it('窗口外重置后可重新累积触发', () => {
      service.trackToolCall('s1', 'file_read', { p: 1 });
      service.trackToolCall('s1', 'file_read', { p: 1 });
      nowMs += 120_000; // 完全出窗
      service.trackToolCall('s1', 'file_read', { p: 1 });
      service.trackToolCall('s1', 'file_read', { p: 1 });
      const r5 = service.trackToolCall('s1', 'file_read', { p: 1 });

      expect(r5.detected).toBe(true);
      expect(r5.count).toBe(3);
    });
  });

  describe('会话隔离与状态管理', () => {
    it('会话之间相互隔离', () => {
      for (let i = 0; i < 3; i++) {
        service.trackToolCall('s1', 'file_read', { p: 1 });
      }
      expect(service.checkDoomLoop('s1')).toBe(true);
      expect(service.checkDoomLoop('s2')).toBe(false);

      const r = service.trackToolCall('s2', 'file_read', { p: 1 });
      expect(r.detected).toBe(false);
      expect(r.count).toBe(1);
    });

    it('空 sessionId 归入 default 会话', () => {
      for (let i = 0; i < 3; i++) {
        service.trackToolCall('', 'file_read', { p: 1 });
      }
      expect(service.checkDoomLoop('')).toBe(true);
      expect(service.checkDoomLoop('default')).toBe(true);
    });

    it('clearDoomLoop 清除检测状态', () => {
      for (let i = 0; i < 3; i++) {
        service.trackToolCall('s1', 'file_read', { p: 1 });
      }
      expect(service.checkDoomLoop('s1')).toBe(true);

      service.clearDoomLoop('s1');
      expect(service.checkDoomLoop('s1')).toBe(false);

      // 清除后重新从 1 开始计数
      const r = service.trackToolCall('s1', 'file_read', { p: 1 });
      expect(r.count).toBe(1);
      expect(r.detected).toBe(false);
    });

    it('未触发过的会话 checkDoomLoop 返回 false', () => {
      expect(service.checkDoomLoop('never-seen')).toBe(false);
    });
  });

  describe('getDoomLoopConfig', () => {
    it('返回默认配置（阈值 3 / 窗口 60s）', () => {
      const config = service.getDoomLoopConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxConsecutiveCalls).toBe(3);
      expect(config.timeWindowMs).toBe(60_000);
      expect(config.cooldownMs).toBe(5_000);
    });

    it('返回配置副本（修改不影响内部状态）', () => {
      const config = service.getDoomLoopConfig();
      config.maxConsecutiveCalls = 99;
      expect(service.getDoomLoopConfig().maxConsecutiveCalls).toBe(3);
    });
  });
});
