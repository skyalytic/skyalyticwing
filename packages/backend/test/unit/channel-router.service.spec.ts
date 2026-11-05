import 'reflect-metadata';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import { ROUTER_MAX_ROUTES } from '../../src/modules/channels/providers/base.provider.js';

describe('ChannelRouterService', () => {
  let router: ChannelRouterService;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    router = new ChannelRouterService();
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe('route 路由', () => {
    it('同一毫秒内不同用户和线程必须拥有不同的会话 ID', () => {
      const sessions = [
        router.route('feishu', 'alice'),
        router.route('feishu', 'bob'),
        router.route('feishu', 'alice', 'thread-2'),
      ];
      expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(3);
    });

    it('包含冒号的渠道、用户和线程标识不能产生路由键碰撞', () => {
      const first = router.route('a:b', 'c', 'd');
      expect(router.route('a', 'b:c', 'd')).not.toBe(first);
      expect(router.route('a', 'b', 'c:d')).not.toBe(first);
      router.bind('a', 'b:c', 'd', { ...first, sessionId: 'bound' });
      expect(router.route('a:b', 'c', 'd')).toBe(first);
    });

    it('首次路由创建会话并返回路由信息', () => {
      const s = router.route('dingtalk', 'user-1');

      expect(s.sessionId).toMatch(/^ch-dingtalk-[0-9a-f-]{36}$/);
      expect(s.agentId).toBe('main');
      expect(s.conversationId).toBe('user-1');
      expect(s.createdAt).toBe(nowMs);
    });

    it('同一 (channel,from,thread) 三元组返回稳定会话', () => {
      const s1 = router.route('dingtalk', 'user-1', 't1');
      nowMs += 60_000; // 时间推移后仍应命中同一会话
      const s2 = router.route('dingtalk', 'user-1', 't1');

      expect(s2).toBe(s1);
    });

    it('不同 from 或 threadId 路由到不同会话', () => {
      const a = router.route('dingtalk', 'user-1');
      const b = router.route('dingtalk', 'user-2');
      const t = router.route('dingtalk', 'user-1', 'thread-9');

      expect(a).not.toBe(b);
      expect(a).not.toBe(t);
      expect(t.conversationId).toBe('user-1');
    });

    it('threadId 缺省归入 default 线程（与显式 default 等价）', () => {
      const implicit = router.route('wx', 'u1');
      const explicit = router.route('wx', 'u1', 'default');
      expect(implicit).toBe(explicit);
    });

    it('不同渠道同 from 互不干扰', () => {
      const ding = router.route('dingtalk', 'u1');
      const wx = router.route('wechat', 'u1');
      expect(ding).not.toBe(wx);
      expect(ding.sessionId.startsWith('ch-dingtalk-')).toBe(true);
      expect(wx.sessionId.startsWith('ch-wechat-')).toBe(true);
    });

    it('getSession 等价于 route（获取或创建）', () => {
      const s = router.getSession('discord', 'u9', 't1');
      expect(router.getSession('discord', 'u9', 't1')).toBe(s);
    });
  });

  describe('bind 显式绑定', () => {
    it('bind 覆盖指定三元组的会话', () => {
      const auto = router.route('feishu', 'u1');
      const bound = {
        sessionId: 'custom-session',
        agentId: 'agent-x',
        conversationId: 'u1',
        createdAt: 42,
      };

      router.bind('feishu', 'u1', undefined, bound);

      expect(router.getSession('feishu', 'u1')).toBe(bound);
      expect(router.getSession('feishu', 'u1')).not.toBe(auto);
    });

    it('bind 不影响其他三元组', () => {
      const other = router.route('feishu', 'u2');
      router.bind('feishu', 'u1', undefined, {
        sessionId: 'x',
        agentId: 'a',
        conversationId: 'u1',
        createdAt: 1,
      });

      expect(router.getSession('feishu', 'u2')).toBe(other);
    });
  });

  describe('上限淘汰（M-D1 fix）', () => {
    it('超过 ROUTER_MAX_ROUTES 时淘汰最旧条目并保持总量恒定', () => {
      // 填满上限：每个条目 createdAt 递增
      for (let i = 0; i < ROUTER_MAX_ROUTES; i++) {
        nowMs = 1_000_000 + i;
        router.route('ch', `from-${i}`);
      }

      // 新增一条 → 最旧的 from-0 被淘汰
      nowMs = 9_999_999;
      const fresh = router.route('ch', 'from-new');

      expect(fresh.conversationId).toBe('from-new');

      // from-0 被淘汰：重新路由会创建新会话
      nowMs = 9_999_999;
      const recreated = router.route('ch', 'from-0');
      expect(recreated.createdAt).toBe(nowMs);
    });

    it('bind 同样应用上限淘汰', () => {
      for (let i = 0; i < ROUTER_MAX_ROUTES; i++) {
        nowMs = 1_000_000 + i;
        router.route('ch', `from-${i}`);
      }

      nowMs = 9_999_999;
      router.bind('ch', 'from-new', undefined, {
        sessionId: 's',
        agentId: 'a',
        conversationId: 'from-new',
        createdAt: nowMs,
      });

      // 最旧的 from-0 被 bind 淘汰
      nowMs = 9_999_999;
      const recreated = router.route('ch', 'from-0');
      expect(recreated.createdAt).toBe(nowMs);
      expect(recreated.conversationId).toBe('from-0');
    });
  });

  describe('clear', () => {
    it('清空后重新路由创建全新会话', () => {
      const before = router.route('dingtalk', 'u1');
      router.clear();

      nowMs += 1_000;
      const after = router.route('dingtalk', 'u1');
      expect(after).not.toBe(before);
      expect(after.sessionId).not.toBe(before.sessionId);
    });
  });
});
