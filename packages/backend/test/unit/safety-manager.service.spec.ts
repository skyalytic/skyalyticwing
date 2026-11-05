import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SafetyManagerService,
  IterationBudget,
  ToolGuardrailController,
  CredentialPool,
  FailoverReason,
} from '../../src/modules/core/security/safety-manager.service.js';

describe('SafetyManagerService', () => {
  let service: SafetyManagerService;

  beforeEach(() => {
    service = new SafetyManagerService();
  });

  // =========================================================================
  // 1. ErrorClassifier
  // =========================================================================
  describe('classifyApiError - 错误分类', () => {
    it('402 / 账单模式 → billing（换 Key，不重试）', () => {
      const r = service.classifyApiError({ message: 'please top up your credits', status: 402 }, 'openai', 'gpt-4');
      expect(r.reason).toBe(FailoverReason.billing);
      expect(r.retryable).toBe(false);
      expect(r.should_rotate_credential).toBe(true);
      expect(r.should_fallback).toBe(true);
      expect(r.is_auth).toBe(false);
      expect(r.status_code).toBe(402);
      expect(r.provider).toBe('openai');
      expect(r.model).toBe('gpt-4');
      expect(r.error_context.raw).toContain('credits');
    });

    it('余额耗尽消息（无状态码）→ billing', () => {
      const r = service.classifyApiError({ message: 'You exceeded your current quota' });
      expect(r.reason).toBe(FailoverReason.billing);
      expect(r.status_code).toBe(0);
    });

    it('上下文溢出 → context_overflow（需压缩）', () => {
      const r = service.classifyApiError({ message: 'context length exceeded' });
      expect(r.reason).toBe(FailoverReason.context_overflow);
      expect(r.should_compress).toBe(true);
      expect(r.retryable).toBe(false);
    });

    it('400 + token 关键字 → context_overflow', () => {
      const r = service.classifyApiError({ message: 'unknown token issue', status: 400 });
      expect(r.reason).toBe(FailoverReason.context_overflow);
      expect(r.status_code).toBe(400);
    });

    it('中文上下文溢出模式（上下文长度）→ context_overflow', () => {
      const r = service.classifyApiError({ message: '请求超过最大长度限制' });
      expect(r.reason).toBe(FailoverReason.context_overflow);
    });

    it('404 / 模型不存在 → model_not_found（换模型）', () => {
      expect(service.classifyApiError({ message: 'x', status: 404 }).reason).toBe(FailoverReason.model_not_found);
      expect(service.classifyApiError({ message: 'model not found: foo' }).reason).toBe(FailoverReason.model_not_found);
      expect(service.classifyApiError({ message: 'x', status: 404 }).should_fallback).toBe(true);
    });

    it('内容策略拒绝 → content_policy_blocked', () => {
      const r = service.classifyApiError({ message: 'flagged as sensitive content' });
      expect(r.reason).toBe(FailoverReason.content_policy_blocked);
      expect(r.retryable).toBe(false);
    });

    it('413 / payload 太大 → payload_too_large', () => {
      expect(service.classifyApiError({ message: 'x', status: 413 }).reason).toBe(FailoverReason.payload_too_large);
      const r = service.classifyApiError({ message: 'request entity too large' });
      expect(r.reason).toBe(FailoverReason.payload_too_large);
      expect(r.should_compress).toBe(true);
    });

    it('429 + 过载文案 → overloaded（backoff 5000，不换 Key）', () => {
      const r = service.classifyApiError({ message: 'service is temporarily overloaded', status: 429 });
      expect(r.reason).toBe(FailoverReason.overloaded);
      expect(r.retryable).toBe(true);
      expect(r.backoffMs).toBe(5000);
      expect(r.should_rotate_credential).toBe(false);
    });

    it('429 + upstream 文案 → upstream_rate_limit（backoff 3000，可降级）', () => {
      const r = service.classifyApiError({ message: 'upstream provider rate', status: 429 });
      expect(r.reason).toBe(FailoverReason.upstream_rate_limit);
      expect(r.backoffMs).toBe(3000);
      expect(r.should_fallback).toBe(true);
    });

    it('429 普通 → rate_limit（backoff 2000，换 Key）', () => {
      const r = service.classifyApiError({ message: 'too many requests', status: 429 });
      expect(r.reason).toBe(FailoverReason.rate_limit);
      expect(r.backoffMs).toBe(2000);
      expect(r.should_rotate_credential).toBe(true);
    });

    it('503 / 过载文案 → overloaded', () => {
      expect(service.classifyApiError({ message: 'x', status: 503 }).reason).toBe(FailoverReason.overloaded);
      expect(service.classifyApiError({ message: 'server is overloaded' }).reason).toBe(FailoverReason.overloaded);
    });

    it('401 → auth（is_auth，换 Key）', () => {
      const r = service.classifyApiError({ message: 'x', status: 401 });
      expect(r.reason).toBe(FailoverReason.auth);
      expect(r.is_auth).toBe(true);
      expect(r.should_rotate_credential).toBe(true);
      expect(r.retryable).toBe(false);
    });

    it('403 + 永久关键字 → auth_permanent', () => {
      const r = service.classifyApiError({ message: 'api key permanently disabled', status: 403 });
      expect(r.reason).toBe(FailoverReason.auth_permanent);
      expect(r.is_auth).toBe(true);
      expect(r.should_fallback).toBe(true);
    });

    it('认证失败文案 → auth', () => {
      expect(service.classifyApiError({ message: 'invalid api key' }).reason).toBe(FailoverReason.auth);
      expect(service.classifyApiError({ message: 'Unauthorized access' }).reason).toBe(FailoverReason.auth);
    });

    it('SSL 证书错误 → ssl_cert_verification', () => {
      const r = service.classifyApiError({ message: 'certificate verify failed' });
      expect(r.reason).toBe(FailoverReason.ssl_cert_verification);
      expect(r.retryable).toBe(false);
    });

    it('超时 → timeout（默认 408，可重试）', () => {
      const r = service.classifyApiError({ message: 'request timeout after 30s' });
      expect(r.reason).toBe(FailoverReason.timeout);
      expect(r.status_code).toBe(408);
      expect(r.retryable).toBe(true);
      expect(r.backoffMs).toBe(1000);
      expect(service.classifyApiError({ message: 'ETIMEDOUT' }).reason).toBe(FailoverReason.timeout);
    });

    it('5xx → server_error（backoff 3000）', () => {
      const r = service.classifyApiError({ message: 'internal error', status: 500 });
      expect(r.reason).toBe(FailoverReason.server_error);
      expect(r.retryable).toBe(true);
      expect(r.backoffMs).toBe(3000);
    });

    it('5xx + 格式错误关键字 → format_error', () => {
      const r = service.classifyApiError({ message: 'unknown parameter: foo', status: 502 });
      expect(r.reason).toBe(FailoverReason.format_error);
      expect(r.retryable).toBe(false);
    });

    it('400 格式错误 → format_error', () => {
      expect(service.classifyApiError({ message: 'bad request', status: 400 }).reason).toBe(FailoverReason.format_error);
      expect(service.classifyApiError({ message: 'invalid_request_error' }).reason).toBe(FailoverReason.format_error);
    });

    it('400 + thinking/signature → thinking_signature（可重试）', () => {
      const r = service.classifyApiError({ message: 'thinking signature mismatch', status: 400 });
      expect(r.reason).toBe(FailoverReason.thinking_signature);
      expect(r.retryable).toBe(true);
    });

    it('未知错误 → unknown（兜底 500）', () => {
      const r = service.classifyApiError({ message: 'mysterious failure' });
      expect(r.reason).toBe(FailoverReason.unknown);
      expect(r.status_code).toBe(500);
    });

    it('接受字符串 / Error 实例 / statusCode 字段', () => {
      expect(service.classifyApiError('boom').reason).toBe(FailoverReason.unknown);
      const err = new Error('rate limit hit');
      (err as unknown as { status: number }).status = 429;
      expect(service.classifyApiError(err).reason).toBe(FailoverReason.rate_limit);
      expect(service.classifyApiError({ message: 'x', statusCode: 429 }).reason).toBe(FailoverReason.rate_limit);
    });

    it('空对象消息回退为字符串形式', () => {
      const r = service.classifyApiError({} as Error);
      expect(r.message).toBe('[object Object]');
      expect(r.reason).toBe(FailoverReason.unknown);
    });
  });

  // =========================================================================
  // 2. IterationBudget
  // =========================================================================
  describe('IterationBudget - 迭代预算', () => {
    it('consume 到达上限后返回 false', () => {
      const b = new IterationBudget(3);
      expect(b.consume()).toBe(true);
      expect(b.consume()).toBe(true);
      expect(b.consume()).toBe(true);
      expect(b.consume()).toBe(false);
      expect(b.used).toBe(3);
      expect(b.remaining).toBe(0);
    });

    it('refund 归还一次预算，不低于 0', () => {
      const b = new IterationBudget(2);
      b.consume();
      b.consume();
      b.refund();
      expect(b.used).toBe(1);
      b.refund();
      b.refund();
      expect(b.used).toBe(0);
    });

    it('reset 清零已用次数', () => {
      const b = new IterationBudget(2);
      b.consume();
      b.reset();
      expect(b.used).toBe(0);
      expect(b.consume()).toBe(true);
    });

    it('toJSON 输出统计，lock 对齐接口', () => {
      const b = new IterationBudget(10);
      b.consume();
      expect(b.toJSON()).toEqual({ maxTotal: 10, used: 1, remaining: 9 });
      expect(b.lock).toBe(false);
      expect(b.consume()).toBe(true);
    });

    it('createParentBudget / createSubagentBudget 工厂默认值', () => {
      const parent = service.createParentBudget();
      const sub = service.createSubagentBudget();
      expect(parent.toJSON().maxTotal).toBe(90);
      expect(sub.toJSON().maxTotal).toBe(50);
      expect(service.createParentBudget(5).toJSON().maxTotal).toBe(5);
      expect(service.DEFAULT_PARENT_MAX).toBe(90);
      expect(service.DEFAULT_SUBAGENT_MAX).toBe(50);
    });
  });

  // =========================================================================
  // 3. ToolGuardrails
  // =========================================================================
  describe('ToolGuardrailController - 工具护栏', () => {
    it('同 args 连续调用 N 次 → doom_loop_same_args 拒绝', () => {
      const c = service.createToolGuardrailController();
      expect(c.beforeCall('s1', 'a1', 'read_file', { path: 'x' }).allow).toBe(true);
      c.afterCall('s1', 'a1', 'read_file', { path: 'x' }, true, 100);
      c.afterCall('s1', 'a1', 'read_file', { path: 'x' }, true, 100);
      c.afterCall('s1', 'a1', 'read_file', { path: 'x' }, true, 100);
      const r = c.beforeCall('s1', 'a1', 'read_file', { path: 'x' });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('doom_loop_same_args');
      expect(r.warning).toContain('read_file');
    });

    it('可变字段（timestamp 等）不绕过循环检测（L-B5）', () => {
      const c = service.createToolGuardrailController();
      for (let i = 0; i < 3; i++) {
        c.afterCall('s', 'a', 'tool', { cmd: 'ls', timestamp: i, nonce: 'n' + i, savePath: '/tmp/' + i }, true, 50);
      }
      const r = c.beforeCall('s', 'a', 'tool', { cmd: 'ls', timestamp: 99, nonce: 'zz', savePath: '/tmp/9' });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('doom_loop_same_args');
    });

    it('同工具连续失败 N 次 → repeated_failure 拒绝', () => {
      const c = service.createToolGuardrailController();
      for (let i = 0; i < 5; i++) {
        c.afterCall('s2', 'a', 'flaky', { i }, false, 0);
      }
      const r = c.beforeCall('s2', 'a', 'flaky', { i: 99 });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('repeated_failure');
    });

    it('中间成功一次会重置连续失败计数', () => {
      const c = service.createToolGuardrailController();
      for (let i = 0; i < 4; i++) c.afterCall('s', 'a', 't', { i }, false, 0);
      c.afterCall('s', 'a', 't', { ok: 1 }, true, 100);
      for (let i = 0; i < 3; i++) c.afterCall('s', 'a', 't', { f: i }, false, 0);
      // 连续失败仅 3 次（< 5），且 args 各不相同
      expect(c.beforeCall('s', 'a', 't', { z: 1 }).allow).toBe(true);
    });

    it('无进展 N 次 → no_progress 拒绝（M-B9）', () => {
      const c = service.createToolGuardrailController({ maxNoProgress: 3 });
      for (let i = 0; i < 3; i++) c.afterCall('s', 'a', 't', { i }, true, 0);
      const r = c.beforeCall('s', 'a', 't', { next: 1 });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('no_progress');
      const np = c.checkNoProgress('s', 'a');
      expect(np.detected).toBe(true);
      expect(np.count).toBe(3);
      expect(np.warning).toContain('3');
    });

    it('有输出会重置无进展计数，checkNoProgress 未达阈值返回 false', () => {
      const c = service.createToolGuardrailController();
      c.afterCall('s', 'a', 't', { i: 1 }, true, 5); // <10 也算无进展
      expect(c.checkNoProgress('s', 'a')).toEqual({ detected: false, count: 1 });
      c.afterCall('s', 'a', 't', { i: 2 }, true, 500);
      expect(c.checkNoProgress('s', 'a')).toEqual({ detected: false, count: 0 });
    });

    it('窗口过期后历史被清理', async () => {
      const c = service.createToolGuardrailController({ windowMs: 5 });
      c.afterCall('s', 'a', 't', { p: 1 }, false, 0);
      await new Promise((r) => setTimeout(r, 15));
      // 失败记录已过期，不再阻断
      expect(c.beforeCall('s', 'a', 't', { p: 1 }).allow).toBe(true);
    });

    it('stats 返回统计与最近 5 条记录', () => {
      const c = service.createToolGuardrailController();
      for (let i = 0; i < 7; i++) c.afterCall('sx', 'ax', 't', { i }, true, 100);
      const st = c.stats('sx', 'ax');
      expect(st.totalCalls).toBe(7);
      expect(st.recent).toHaveLength(5);
      expect(st.noProgressCount).toBe(0);
      expect(c.stats('none', 'none').totalCalls).toBe(0);
    });

    it('clear 支持全量 / 按 session / 按 session+agent 清理（M-B8）', () => {
      const c = service.createToolGuardrailController();
      c.afterCall('s1', 'a1', 't', {}, true, 1);
      c.afterCall('s1', 'a2', 't', {}, true, 1);
      c.afterCall('s2', 'a1', 't', {}, true, 1);
      c.clear('s1', 'a1');
      expect(c.stats('s1', 'a1').totalCalls).toBe(0);
      expect(c.stats('s1', 'a2').totalCalls).toBe(1);
      c.clear('s1');
      expect(c.stats('s1', 'a2').totalCalls).toBe(0);
      expect(c.stats('s2', 'a1').totalCalls).toBe(1);
      c.clear();
      expect(c.stats('s2', 'a1').totalCalls).toBe(0);
    });
  });

  // =========================================================================
  // 4. Trajectory
  // =========================================================================
  describe('Trajectory - 轨迹记录', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'safety-traj-'));
    });

    it('未设置目录时保存为 no-op', () => {
      expect(() => service.saveTrajectory([{ a: 1 }], 'gpt', true)).not.toThrow();
    });

    it('setTrajectoryDir 创建目录并写入 JSONL（单行紧凑）', () => {
      service.setTrajectoryDir(dir);
      service.saveTrajectory([{ role: 'user' }], 'gpt-4', true);
      const fp = join(dir, 'trajectory_samples.jsonl');
      expect(existsSync(fp)).toBe(true);
      const lines = readFileSync(fp, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.model).toBe('gpt-4');
      expect(entry.completed).toBe(true);
      expect(entry.conversations).toEqual([{ role: 'user' }]);
      expect(entry.timestamp).toBeTruthy();
    });

    it('失败轨迹写入 failed_trajectories.jsonl，支持自定义文件名', () => {
      service.setTrajectoryDir(dir);
      service.saveTrajectory([], 'm', false);
      expect(existsSync(join(dir, 'failed_trajectories.jsonl'))).toBe(true);
      service.saveTrajectory([], 'm', true, 'custom.jsonl');
      expect(existsSync(join(dir, 'custom.jsonl'))).toBe(true);
    });

    it('超过 10MB 时轮转旧文件（L-B10）', () => {
      service.setTrajectoryDir(dir);
      const fp = join(dir, 'trajectory_samples.jsonl');
      writeFileSync(fp, Buffer.alloc(10 * 1024 * 1024 + 1, 97));
      service.saveTrajectory([1], 'm', true);
      expect(existsSync(fp + '.1')).toBe(true);
      // 轮转后当前文件被重建且很小
      expect(statSync(fp).size).toBeLessThan(1024);
      // 再次超过会继续轮转 .1 -> .2
      writeFileSync(fp, Buffer.alloc(10 * 1024 * 1024 + 1, 98));
      service.saveTrajectory([2], 'm', true);
      expect(existsSync(fp + '.2')).toBe(true);
    });

    it('写入失败静默忽略（目标为目录）', () => {
      service.setTrajectoryDir(dir);
      mkdirSync(join(dir, 'trajectory_samples.jsonl'));
      expect(() => service.saveTrajectory([1], 'm', true)).not.toThrow();
    });

    it('setTrajectoryDir 创建失败仅告警（父路径为文件）', () => {
      const fileBase = join(dir, 'afile');
      writeFileSync(fileBase, 'x');
      expect(() => service.setTrajectoryDir(join(fileBase, 'sub'))).not.toThrow();
    });
  });

  describe('Scratchpad 转换', () => {
    it('convertScratchpadToThink 替换标记，无标记原样返回', () => {
      expect(service.convertScratchpadToThink('<REASONING_SCRATCHPAD>hi</REASONING_SCRATCHPAD>')).toBe('<think>hi</think>');
      expect(service.convertScratchpadToThink('plain')).toBe('plain');
      expect(service.convertScratchpadToThink('')).toBe('');
    });

    it('hasIncompleteScratchpad 检测未闭合标记', () => {
      expect(service.hasIncompleteScratchpad('<REASONING_SCRATCHPAD>abc')).toBe(true);
      expect(service.hasIncompleteScratchpad('<REASONING_SCRATCHPAD>abc</REASONING_SCRATCHPAD>')).toBe(false);
      expect(service.hasIncompleteScratchpad('')).toBe(false);
      expect(service.hasIncompleteScratchpad('no markers')).toBe(false);
    });
  });

  // =========================================================================
  // 5. ToolOutputLimits
  // =========================================================================
  describe('ToolOutputLimits - 输出截断', () => {
    it('默认限制值与缓存行为', () => {
      const l1 = service.getToolOutputLimits();
      expect(l1).toEqual({
        max_bytes: 50000,
        max_lines: 2000,
        max_line_length: 2000,
        max_tool_result_chars: 30000,
      });
      expect(service.getToolOutputLimits()).toBe(l1); // 缓存同一对象
      service.resetToolOutputLimitsCache();
      expect(service.getToolOutputLimits()).not.toBe(l1);
      expect(service.getMaxBytes()).toBe(50000);
      expect(service.getMaxLines()).toBe(2000);
      expect(service.getMaxLineLength()).toBe(2000);
      expect(service.getMaxToolResultChars()).toBe(30000);
    });

    it('truncateOutput 保留头尾并标注原始长度', () => {
      expect(service.truncateOutput('')).toBe('');
      expect(service.truncateOutput('short')).toBe('short');
      const long = 'A'.repeat(60) + 'MID' + 'B'.repeat(50); // 113 字符 > max 100
      const out = service.truncateOutput(long, 100);
      expect(out).toContain('[已截断，原始长度: 113 字符]');
      expect(out.startsWith('A'.repeat(60))).toBe(true);
      expect(out.endsWith('B'.repeat(30))).toBe(true);
      expect(out.length).toBeLessThan(long.length + 60);
    });

    it('truncateLines 按行截断', () => {
      expect(service.truncateLines('')).toBe('');
      expect(service.truncateLines('a\nb')).toBe('a\nb');
      const out = service.truncateLines('l1\nl2\nl3\nl4', 2);
      expect(out).toBe('l1\nl2\n... [已截断，共 4 行，保留前 2 行]');
    });

    it('truncateLongLines 按行长度截断', () => {
      expect(service.truncateLongLines('')).toBe('');
      expect(service.truncateLongLines('ok')).toBe('ok');
      const out = service.truncateLongLines('abcdefghij', 5);
      expect(out).toBe('abcde ... [行长度截断，原始: 10 字符]');
    });
  });

  // =========================================================================
  // 6. CredentialPool
  // =========================================================================
  describe('CredentialPool - 凭证池', () => {
    it('构建/轮换/耗尽/恢复', () => {
      const pool = new CredentialPool(['k1', 'k2']);
      expect(pool.size()).toBe(2);
      expect(pool.current()).toBe('k1');
      pool.add('k1'); // 去重
      expect(pool.size()).toBe(2);
      expect(pool.next()).toBe('k2');
      expect(pool.next()).toBe('k1');
      pool.markExhausted('k1', 'billing');
      expect(pool.next()).toBe('k2'); // k1 被跳过
      pool.markExhausted('k2', 'billing');
      expect(pool.next()).toBeNull(); // 全部耗尽
      expect(pool.availableCount()).toBe(0);
      expect(pool.toJSON()).toEqual({ total: 2, available: 0, currentIdx: 1, exhausted: 2 });
      pool.remove('k1'); // 同时清除耗尽记录
      expect(pool.size()).toBe(1);
      expect(pool.availableCount()).toBe(0); // k2 仍耗尽
    });

    it('空池 next 返回 null，markExhausted 空参安全', () => {
      const pool = new CredentialPool();
      expect(pool.next()).toBeNull();
      expect(pool.current()).toBeNull();
      pool.markExhausted('');
      expect(pool.size()).toBe(0);
    });

    it('冷却期过后 Key 恢复可用', () => {
      const spy = jest.spyOn(Date, 'now');
      const t0 = 1_700_000_000_000;
      spy.mockReturnValue(t0);
      try {
        const pool = new CredentialPool(['a', 'b']);
        pool.markExhausted('a', 'rate_limit');
        expect(pool.availableCount()).toBe(1);
        spy.mockReturnValue(t0 + 61_000); // 超过 60s 冷却
        expect(pool.availableCount()).toBe(2);
        expect(pool.next()).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
    });

    it('buildPoolFromConfig 解析逗号分隔多 Key', () => {
      const cfg = { providers: { openai: { apiKey: ' k1 , k2 ,,k3' }, single: { apiKey: 'only-one' }, nokey: {} } };
      const pool = service.buildPoolFromConfig(cfg as never, 'openai');
      expect(pool).not.toBeNull();
      expect(pool!.size()).toBe(3);
      expect(service.buildPoolFromConfig(cfg as never, 'single')).toBeNull();
      expect(service.buildPoolFromConfig(cfg as never, 'nokey')).toBeNull();
      expect(service.buildPoolFromConfig(cfg as never, 'missing')).toBeNull();
      expect(service.buildPoolFromConfig(null, 'openai')).toBeNull();
      expect(service.buildPoolFromConfig(cfg as never, '')).toBeNull();
    });
  });

  // =========================================================================
  // 7. FuzzyMatch
  // =========================================================================
  describe('FuzzyMatch - 模糊匹配', () => {
    it('精确匹配直接命中', () => {
      const r = service.fuzzyFind('hello world foo', 'world');
      expect(r).toEqual({ found: true, match: 'world', start: 6, distance: 0, exact: true });
    });

    it('容忍 20% 编辑距离内的模糊匹配', () => {
      const text = 'ABCDEFGH suffix';
      const r = service.fuzzyFind(text, 'ABCXEFGH'); // 1 处差异 / 8 字符
      expect(r.found).toBe(true);
      expect(r.exact).toBe(false);
      expect(r.distance).toBe(1);
      expect(r.start).toBe(0);
    });

    it('超出阈值不匹配', () => {
      const r = service.fuzzyFind('XXXXXXXX', 'abcdefgh');
      expect(r.found).toBe(false);
      expect(r.start).toBe(-1);
    });

    it('pattern 比文本长 / 空输入 不匹配', () => {
      expect(service.fuzzyFind('short', 'much longer pattern').found).toBe(false);
      expect(service.fuzzyFind('', 'x')).toEqual({ found: false, match: '', start: -1, distance: 0 });
      expect(service.fuzzyFind('x', '')).toEqual({ found: false, match: '', start: -1, distance: 0 });
    });

    it('自定义 maxDist 放宽阈值', () => {
      const r = service.fuzzyFind('XXXXXXXX', 'XXXXXXXX', 5);
      expect(r.found).toBe(true);
    });

    it('similarity 计算相似度', () => {
      expect(service.similarity('abc', 'abc')).toBe(1);
      expect(service.similarity('', '')).toBe(1);
      expect(service.similarity('', 'a')).toBe(0);
      expect(service.similarity('abc', 'abd')).toBeCloseTo(2 / 3, 5);
      expect(service.similarity('abc', 'xyz')).toBe(0);
    });
  });

  // =========================================================================
  // 8. PatchParser
  // =========================================================================
  describe('PatchParser - 补丁解析与应用', () => {
    it('解析空 diff 返回空数组', () => {
      expect(service.parseUnifiedDiff('')).toEqual([]);
    });

    it('解析 hunk 头（含默认 count）与 add/del/ctx 行', () => {
      const diff = [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,3 @@',
        ' line1',
        '-line2',
        '+LINE2',
        ' line3',
        '@@ -5 +5 @@',
        ' ctxline',
      ].join('\n');
      const hunks = service.parseUnifiedDiff(diff);
      expect(hunks).toHaveLength(2);
      expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, oldCount: 3, newCount: 3 });
      expect(hunks[0].lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'ctx']);
      expect(hunks[0].lines[0]).toMatchObject({ content: 'line1', oldLine: 1, newLine: 1 });
      expect(hunks[0].lines[1]).toMatchObject({ type: 'del', content: 'line2', oldLine: 2 });
      expect(hunks[0].lines[2]).toMatchObject({ type: 'add', content: 'LINE2', newLine: 2 });
      expect(hunks[1]).toMatchObject({ oldStart: 5, newStart: 5, oldCount: 1, newCount: 1 });
    });

    it('hunk 头前的杂散行被忽略，\\ No newline 标记上一行', () => {
      const diff = ['stray line', '@@ -1 +1 @@', ' only', '\\ No newline at end of file'].join('\n');
      const hunks = service.parseUnifiedDiff(diff);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].lines[0].noNewline).toBe(true);
    });

    it('applyHunks 应用删除/新增/上下文', () => {
      const hunks = service.parseUnifiedDiff(['@@ -2,2 +2,2 @@', ' l2', '-l3', '+L3'].join('\n'));
      const out = service.applyHunks('l1\nl2\nl3\nl4\nl5', hunks);
      expect(out).toBe('l1\nl2\nL3\nl4\nl5');
    });

    it('applyHunks 行号偏移时在 ±4 范围内模糊定位', () => {
      // 声明 oldStart=4，但真实内容在行 2（offset -2），仍应命中
      const hunks = service.parseUnifiedDiff(['@@ -4,2 +4,2 @@', ' l2', '-OLD3', '+NEW3'].join('\n'));
      const out = service.applyHunks('l1\nl2\nOLD3\nl4\nl5', hunks);
      expect(out).toBe('l1\nl2\nNEW3\nl4\nl5');
    });

    it('无法匹配的 hunk 被跳过，文本不变', () => {
      const hunks = service.parseUnifiedDiff(['@@ -1,1 +1,1 @@', '-zzz', '+yyy'].join('\n'));
      expect(service.applyHunks('aaa\nbbb', hunks)).toBe('aaa\nbbb');
    });

    it('oldStart 为 0 时钳制到行首，纯新增 hunk 可应用', () => {
      const hunks = service.parseUnifiedDiff(['@@ -0,0 +1,1 @@', '+brand'].join('\n'));
      expect(service.applyHunks('x\ny', hunks)).toBe('brand\nx\ny');
    });

    it('空文本或空 hunks 原样返回', () => {
      expect(service.applyHunks('', [{ oldStart: 1, newStart: 1, oldCount: 0, newCount: 0, lines: [] }])).toBe('');
      expect(service.applyHunks('abc', [])).toBe('abc');
    });

    it('多个 hunk 依序全部应用', () => {
      const hunks = service.parseUnifiedDiff(
        ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -3,1 +3,1 @@', '-c', '+C'].join('\n'),
      );
      expect(service.applyHunks('a\nb\nc\nd', hunks)).toBe('A\nb\nC\nd');
    });
  });

  // =========================================================================
  // 9. PromptCaching
  // =========================================================================
  describe('PromptCaching - 提示词缓存', () => {
    it('空消息列表原样返回', () => {
      expect(service.applyAnthropicCacheControl([])).toEqual([]);
    });

    it('标记最近 3 条消息，前文不动，且不修改原始数组', () => {
      const messages = [
        { role: 'user', content: 'm0' },
        { role: 'user', content: 'm1' },
        { role: 'user', content: [{ type: 'text', text: 'm2' }] },
        { role: 'user', content: 'm3' },
        { role: 'user', content: [{ type: 'text', text: 'b1' }, { type: 'text', text: 'b2' }] },
      ];
      const out = service.applyAnthropicCacheControl(messages);
      // 前 2 条未标记
      expect(out[0]['content']).toBe('m0');
      expect(out[1]['content']).toBe('m1');
      // 字符串内容转数组并标记
      const c3 = out[3]['content'] as Array<{ type: string; text: string; cache_control?: { type: string } }>;
      expect(Array.isArray(c3)).toBe(true);
      expect(c3[0].cache_control).toEqual({ type: 'ephemeral' });
      // 多模态内容标记最后一个 block
      const c4 = out[4]['content'] as Array<{ cache_control?: { type: string } }>;
      expect(c4[0].cache_control).toBeUndefined();
      expect(c4[1].cache_control).toEqual({ type: 'ephemeral' });
      // 深拷贝：原始数组未被修改
      expect(messages[3].content).toBe('m3');
      expect(Array.isArray(messages[4].content)).toBe(true);
      expect((messages[4].content as Array<unknown>)[1]).not.toHaveProperty('cache_control');
    });

    it('少于 3 条消息时全部标记，非字符串/数组内容不动', () => {
      const out = service.applyAnthropicCacheControl([
        { role: 'user', content: 42 },
        { role: 'user', content: 'x' },
      ]);
      expect(out[0]['content']).toBe(42);
      const c1 = out[1]['content'] as Array<{ cache_control?: unknown }>;
      expect(c1[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('applySystemCacheControl 三种输入形态', () => {
      expect(service.applySystemCacheControl(null)).toBeNull();
      expect(service.applySystemCacheControl('')).toBe('');
      const str = service.applySystemCacheControl('SYS');
      expect(str).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
      const blocks = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never[];
      const arr = service.applySystemCacheControl(blocks) as Array<{ cache_control?: unknown }>;
      expect(arr[0].cache_control).toBeUndefined();
      expect(arr[1].cache_control).toEqual({ type: 'ephemeral' });
      expect(service.applySystemCacheControl([])).toEqual([]);
    });
  });

  // =========================================================================
  // 10. VerifyHooks
  // =========================================================================
  describe('VerifyHooks - 完成验证钩子', () => {
    it('默认钩子：声明完成但未调用工具 → 疑似幻觉', () => {
      const r = service.runVerifyHooks({ text: '任务已完成，浏览器已打开' }, { toolsCalled: 0 });
      expect(r.passed).toBe(false);
      expect(r.failures[0].name).toBe('tool_executed_check');
      expect(r.failures[0].msg).toContain('幻觉');
      expect(r.suggestions).toHaveLength(1);
    });

    it('默认钩子：调用了工具或纯文本无完成词 → 通过', () => {
      expect(service.runVerifyHooks({ text: '任务已完成' }, { toolsCalled: 3 }).passed).toBe(true);
      expect(service.runVerifyHooks({ text: 'just chatting' }, { toolsCalled: 0 }).passed).toBe(true);
      expect(service.runVerifyHooks({ text: 'done deal' }, {}).passed).toBe(false); // 无 toolsCalled 字段
    });

    it('addVerifyHook 校验钩子结构', () => {
      service.addVerifyHook(null as never);
      service.addVerifyHook({ name: '', check: () => ({ passed: true }) } as never);
      service.addVerifyHook({ name: 'nocheck' } as never);
      const before = service.runVerifyHooks({ text: 'x' }, { toolsCalled: 1 }).failures.length;
      expect(before).toBe(0);
      service.addVerifyHook({ name: 'always-fail', check: () => ({ passed: false, msg: 'nope', hint: 'try harder' }) } as never);
      const r = service.runVerifyHooks({ text: 'x' }, { toolsCalled: 1 });
      expect(r.passed).toBe(false);
      expect(r.failures.some((f) => f.name === 'always-fail' && f.msg === 'nope')).toBe(true);
      expect(r.suggestions).toContain('try harder');
    });

    it('钩子抛异常记为验证异常', () => {
      service.clearVerifyHooks();
      service.addVerifyHook({
        name: 'boom',
        check: () => {
          throw new Error('hook crashed');
        },
      } as never);
      const r = service.runVerifyHooks({}, {});
      expect(r.passed).toBe(false);
      expect(r.failures[0].msg).toBe('验证异常: hook crashed');
    });

    it('clearVerifyHooks 后全部通过；onModuleDestroy 清理钩子', () => {
      service.clearVerifyHooks();
      expect(service.runVerifyHooks({ text: '已完成' }, {})).toEqual({ passed: true, failures: [], suggestions: [] });
      service.onModuleInit();
      service.onModuleDestroy();
      expect(service.runVerifyHooks({ text: '已完成' }, {}).passed).toBe(true);
      expect(service.MAX_VERIFY_ATTEMPTS).toBe(3);
    });
  });

  // =========================================================================
  // 11. Redact
  // =========================================================================
  describe('Redact - 日志脱敏', () => {
    it('isSensitiveKey 识别敏感字段（大小写不敏感）', () => {
      expect(service.isSensitiveKey('password')).toBe(true);
      expect(service.isSensitiveKey('API_KEY')).toBe(true);
      expect(service.isSensitiveKey('Authorization')).toBe(true);
      expect(service.isSensitiveKey('name')).toBe(false);
      expect(service.isSensitiveKey('')).toBe(false);
    });

    it('redactString 覆盖各类敏感形态', () => {
      expect(service.redactString('key=sk-abcdef0123456789abcdef01')).toBe('key=sk-***REDACTED***');
      expect(service.redactString('Bearer abcdefghijklmnopqrstuvwxyz1234')).toBe('Bearer ***REDACTED***');
      expect(service.redactString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV')).toContain('***JWT_REDACTED***');
      expect(service.redactString('mail: alice@example.com')).toBe('mail: ***EMAIL***');
      expect(service.redactString('card 4111 1111 1111 1111')).toBe('card ***CARD***');
      expect(service.redactString('')).toBe('');
    });

    it('redactObject 递归脱敏敏感字段与字符串', () => {
      const obj = {
        user: 'bob',
        password: 'hunter2',
        nested: { token: 'abc', note: 'call sk-abcdef0123456789abcdef01 now' },
        arr: [{ apiKey: 'k' }, 'plain'],
        n: 1,
        nil: null,
      };
      const out = service.redactObject(obj) as Record<string, unknown>;
      expect(out['user']).toBe('bob');
      expect(out['password']).toBe('***REDACTED***');
      const nested = out['nested'] as Record<string, unknown>;
      expect(nested['token']).toBe('***REDACTED***');
      expect(nested['note']).toContain('***REDACTED***');
      const arr = out['arr'] as unknown[];
      expect((arr[0] as Record<string, unknown>)['apiKey']).toBe('***REDACTED***');
      expect(arr[1]).toBe('plain');
      expect(out['n']).toBe(1);
      expect(out['nil']).toBeNull();
      // 原对象不被修改
      expect(obj.password).toBe('hunter2');
    });

    it('redactObject 处理循环引用与超深嵌套（L-B6）', () => {
      const cyc: Record<string, unknown> = { name: 'x' };
      cyc['self'] = cyc;
      const out = service.redactObject(cyc) as Record<string, unknown>;
      expect(out['name']).toBe('x');
      expect(out['self']).toBe('[Circular]');

      const deep = { a: { a: { a: { a: { a: { a: { a: 'sk-abcdef0123456789abcdef01' } } } } } } };
      const outDeep = service.redactObject(deep) as never;
      expect(JSON.stringify(outDeep)).toContain('sk-abcdef0123456789abcdef01'); // 深度 >5 不再递归
    });

    it('maskApiKey 按长度分档脱敏（L-B7）', () => {
      expect(service.maskApiKey('')).toBe('');
      expect(service.maskApiKey('ab')).toBe('*');
      expect(service.maskApiKey('abc')).toBe('a*c');
      expect(service.maskApiKey('12345678')).toBe('1******8');
      expect(service.maskApiKey('123456789')).toBe('***');
      expect(service.maskApiKey('1234567890')).toBe('***');
      expect(service.maskApiKey('sk-abcdefghijklmnop1234')).toBe('sk-abc***1234');
    });
  });
});
