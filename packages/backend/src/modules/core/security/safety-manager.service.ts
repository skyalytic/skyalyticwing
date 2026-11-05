import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ===========================================================================
// SafetyManagerService - SkyalyticWing 安全与可靠性增强模块
//
// 按职责拆分恢复、预算、验证和脱敏，供工具循环统一调用：
//   - ErrorClassifier  结构化 API 错误分类与恢复策略
//   - IterationBudget  线程安全迭代预算，防止无限循环
//   - ToolGuardrails   三种循环检测（同 args/同工具/无进展）
//   - Trajectory       执行轨迹记录到 JSONL，用于调试
//   - ToolOutputLimits (Hermes)    可配置的工具输出截断限制
//   - CredentialPool   多 API Key 轮换池
//   - FuzzyMatch       模糊匹配，提升 file_edit 容错
//   - PatchParser      补丁解析，增强 apply_patch
//   - PromptCaching    Anthropic 提示词缓存控制
//   - VerifyHooks      任务完成前的验证钩子
//   - Redact           日志脱敏，防止敏感信息泄露
//
// 错误恢复、执行预算及输出校验在同一服务内共享配置。
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. ErrorClassifier — 类型定义与错误模式
// ---------------------------------------------------------------------------

/** 故障转移原因枚举 */
export const FailoverReason = {
  auth: 'auth',
  auth_permanent: 'auth_permanent',
  billing: 'billing',
  rate_limit: 'rate_limit',
  upstream_rate_limit: 'upstream_rate_limit',
  overloaded: 'overloaded',
  server_error: 'server_error',
  timeout: 'timeout',
  ssl_cert_verification: 'ssl_cert_verification',
  context_overflow: 'context_overflow',
  payload_too_large: 'payload_too_large',
  model_not_found: 'model_not_found',
  provider_policy_blocked: 'provider_policy_blocked',
  content_policy_blocked: 'content_policy_blocked',
  format_error: 'format_error',
  thinking_signature: 'thinking_signature',
  unknown: 'unknown',
} as const;

export type FailoverReasonType = (typeof FailoverReason)[keyof typeof FailoverReason];

/** 分类后的错误信息 */
export interface ClassifiedError {
  reason: FailoverReasonType;
  status_code: number;
  provider: string;
  model: string;
  message: string;
  error_context: { raw: string; status: number; provider: string; model: string };
  retryable: boolean;
  should_compress: boolean;
  should_rotate_credential: boolean;
  should_fallback: boolean;
  backoffMs: number;
  is_auth: boolean;
}

/** 账单/余额耗尽模式（不可恢复，必须换 Key） */
const BILLING_PATTERNS = [
  'insufficient credits', 'insufficient_quota', 'insufficient balance',
  'credit balance', 'credits exhausted', 'no usable credits',
  'top up your credits', 'payment required', 'billing hard limit',
  'exceeded your current quota', 'account is deactivated',
  'plan does not include', 'out of extra usage', 'out of funds',
  'run out of funds', 'balance_depleted', 'model_not_supported_on_free_tier',
  'not available on the free tier',
];

/** 限流模式 */
export const RATE_LIMIT_PATTERNS = [
  'rate limit', 'rate_limit', 'too many requests', 'throttled',
  'requests per minute', 'tokens per minute', 'try again in',
  'please retry after', 'resource_exhausted', 'rate increased too quickly',
  'throttlingexception', 'too many concurrent requests',
  'servicequotaexceededexception',
];

/** 服务过载模式 */
const OVERLOADED_PATTERNS = [
  'overloaded', 'temporarily overloaded', 'service is temporarily overloaded',
  'server is overloaded', 'server overloaded', 'service overloaded',
  'upstream overloaded', 'currently overloaded', 'at capacity',
  'over capacity',
];

/** 上下文溢出模式 */
const CONTEXT_OVERFLOW_PATTERNS = [
  'context length', 'context size', 'maximum context', 'token limit',
  'too many tokens', 'reduce the length', 'exceeds the limit',
  'context window', 'prompt is too long', 'prompt exceeds max length',
  'max_tokens', 'maximum number of tokens',
  'exceeds the max_model_len', 'max_model_len', 'prompt length',
  'input is too long', 'maximum model length',
  'context length exceeded', 'truncating input',
  'slot context', 'n_ctx_slot',
  '超过最大长度', '上下文长度',
];

/** 模型不存在模式 */
const MODEL_NOT_FOUND_PATTERNS = [
  'is not a valid model', 'invalid model', 'model not found',
  'model_not_found', 'does not exist', 'no such model',
  'unknown model', 'unsupported model',
  'no endpoints found that support tool use',
];

/** 认证失败模式 */
const AUTH_PATTERNS = [
  'invalid api key', 'invalid_api_key', 'incorrect api key',
  'authentication failed', 'unauthorized', 'not authorized',
  'api key is invalid', 'api_key_invalid', 'key is invalid',
];

/** SSL 证书错误模式 */
const SSL_CERT_PATTERNS = [
  'certificate', 'ssl_cert', 'self-signed', 'unable to verify',
  'certificate verify failed', 'cert verify failed',
];

/** 内容策略拒绝模式 */
const CONTENT_POLICY_PATTERNS = [
  'content policy', 'content_filter', 'safety filter',
  'content filter result', 'policy violation', 'unsafe content',
  'flagged as sensitive',
];

/** Payload 太大模式 */
const PAYLOAD_TOO_LARGE_PATTERNS = [
  'request entity too large', 'payload too large', 'error code: 413',
];

/** 格式错误模式 */
const FORMAT_ERROR_PATTERNS = [
  'unknown parameter', 'unsupported parameter',
  'unrecognized request argument', 'invalid_request_error',
  'unknown_parameter', 'unsupported_parameter',
  'bad request',
];

/** 永久性认证失败关键字（403 + 这些词 → auth_permanent） */
const AUTH_PERMANENT_KEYWORDS = [
  'permanent', 'permanently', 'disabled', 'revoked', 'suspended',
  'banned', 'terminated', 'inactive',
];

// ---------------------------------------------------------------------------
// 2. IterationBudget — 迭代预算
// ---------------------------------------------------------------------------

/** 线程安全迭代预算，防止无限循环。parent 默认 90，subagent 默认 50 */
export class IterationBudget {
  private maxTotal: number;
  private _used = 0;
  // JS 单线程，无需真正加锁；保留 _lock 字段仅为对齐接口
  private _lock = false;

  constructor(maxTotal?: number) {
    this.maxTotal = maxTotal || 90;
  }

  consume(): boolean {
    // JS 单线程，无需真正加锁；_lock 仅为接口对齐保留
    this._lock = true;
    try {
      if (this._used >= this.maxTotal) return false;
      this._used++;
      return true;
    } finally {
      this._lock = false;
    }
  }

  refund(): void {
    if (this._used > 0) this._used--;
  }

  reset(): void {
    this._used = 0;
  }

  toJSON(): { maxTotal: number; used: number; remaining: number } {
    return { maxTotal: this.maxTotal, used: this._used, remaining: this.remaining };
  }

  get used(): number {
    return this._used;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this._used);
  }

  /** 保留 _lock 字段仅为对齐接口（JS 单线程无需真正加锁） */
  get lock(): boolean {
    return this._lock;
  }
}

/** parent 默认最大迭代数 */
const DEFAULT_PARENT_MAX = 90;
/** subagent 默认最大迭代数 */
const DEFAULT_SUBAGENT_MAX = 50;

// ---------------------------------------------------------------------------
// 3. ToolGuardrails — 工具调用护栏
// ---------------------------------------------------------------------------

/** 工具调用记录条目 */
interface ToolCallEntry {
  tool: string;
  argsHash: string;
  success: boolean;
  ts: number;
  outLen: number;
}

/** beforeCall 返回值 */
export interface BeforeCallResult {
  allow: boolean;
  reason?: string;
  warning?: string;
}

/** checkNoProgress 返回值 */
export interface NoProgressResult {
  detected: boolean;
  count: number;
  warning?: string;
}

/** 工具护栏统计 */
export interface GuardrailStats {
  totalCalls: number;
  noProgressCount: number;
  recent: ToolCallEntry[];
}

/**
 * ToolGuardrailController — 工具调用护栏
 * 三种循环检测：
 *   a) 同工具同参数连续 N 次（doom_loop_same_args）
 *   b) 同工具连续失败 N 次（repeated_failure）
 *   c) 无进展检测：连续 N 次调用工具但输出未增长（no_progress）
 */
export class ToolGuardrailController {
  maxSameCall: number;          // 同 args 连续调用阈值
  maxSameToolFail: number;      // 同工具连续失败阈值
  maxNoProgress: number;        // 无进展阈值
  windowMs: number;             // 时间窗口（毫秒）
  private _calls: Record<string, ToolCallEntry[]> = {};
  private _lastMsgLen: Record<string, number> = {};
  private _noProgressCount: Record<string, number> = {};

  constructor(opts?: {
    maxSameCall?: number;
    maxSameToolFail?: number;
    maxNoProgress?: number;
    windowMs?: number;
  }) {
    const o = opts || {};
    this.maxSameCall = o.maxSameCall || 3;
    this.maxSameToolFail = o.maxSameToolFail || 5;
    this.maxNoProgress = o.maxNoProgress || 8;
    this.windowMs = o.windowMs || 60000;
  }

  private _key(sessionId?: string, agentId?: string): string {
    return (sessionId || 'default') + '::' + (agentId || 'main');
  }

  private _argsHash(args: unknown): string {
    try {
      const cleanArgs = JSON.parse(JSON.stringify(args || {}));
      // 移除所有可变/动态字段，避免循环检测被绕过。
      // 原来仅移除 savePath，但 timestamp/createdAt/requestId/ts/nonce/uuid/seed
      // 等也是每次调用都变化的字段，攻击者可借此让每次 args hash 都不同。
      const mutableKeys = [
        'savePath', 'timestamp', 'createdAt', 'updatedAt', 'requestId',
        'request_id', 'traceId', 'trace_id', 'ts', 'nonce', 'uuid',
        'seed', 'iteration', 'attempt', 'retryCount',
      ];
      for (const k of mutableKeys) {
        if (cleanArgs[k] !== undefined) delete cleanArgs[k];
      }
      return createHash('sha256').update(JSON.stringify(cleanArgs)).digest('hex').substring(0, 16);
    } catch {
      return 'err';
    }
  }

  /** 调用前检查 */
  beforeCall(sessionId: string | undefined, agentId: string | undefined, toolName: string, args: unknown): BeforeCallResult {
    const key = this._key(sessionId, agentId);
    if (!this._calls[key]) this._calls[key] = [];

    const now = Date.now();
    const arr = this._calls[key];
    // 清理过期记录
    this._calls[key] = arr.filter((e) => now - e.ts < this.windowMs);
    const current = this._calls[key];

    // 检查 a) 同 args 连续调用
    const argsHash = this._argsHash(args);
    let sameCount = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i].tool === toolName && current[i].argsHash === argsHash) sameCount++;
      else break;
    }
    if (sameCount >= this.maxSameCall) {
      return {
        allow: false,
        reason: 'doom_loop_same_args',
        warning: '工具 ' + toolName + ' 已用相同参数连续调用 ' + sameCount + ' 次，疑似死循环。请改变参数或换思路。',
      };
    }

    // 检查 b) 同工具连续失败
    let failCount = 0;
    for (let j = current.length - 1; j >= 0; j--) {
      if (current[j].tool === toolName && current[j].success === false) failCount++;
      else if (current[j].tool === toolName) break;
      else break;
    }
    if (failCount >= this.maxSameToolFail) {
      return {
        allow: false,
        reason: 'repeated_failure',
        warning: '工具 ' + toolName + ' 已连续失败 ' + failCount + ' 次。请停止重试，分析失败原因或换工具。',
      };
    }

    // 在 beforeCall 中接入 maxNoProgress 检查 — 之前 checkNoProgress
    // 仅作为查询接口存在，调用方未集成到决策流。现在 beforeCall 自动检查无进展计数，
    // 超阈值时直接 deny，避免 agent 持续无产出地消耗迭代预算。
    const npCnt = this._noProgressCount[key] || 0;
    if (npCnt >= this.maxNoProgress) {
      return {
        allow: false,
        reason: 'no_progress',
        warning: '已连续 ' + npCnt + ' 次工具调用无有效输出。请检查任务状态或换方法。',
      };
    }

    return { allow: true };
  }

  /** 调用后记录 */
  afterCall(sessionId: string | undefined, agentId: string | undefined, toolName: string, args: unknown, success: boolean, outputLen?: number): void {
    const key = this._key(sessionId, agentId);
    if (!this._calls[key]) this._calls[key] = [];
    this._calls[key].push({
      tool: toolName,
      argsHash: this._argsHash(args),
      success,
      ts: Date.now(),
      outLen: outputLen || 0,
    });

    // 无进展检测：如果输出长度持续为 0 或非常小，计数
    if (!outputLen || outputLen < 10) {
      this._noProgressCount[key] = (this._noProgressCount[key] || 0) + 1;
    } else {
      this._noProgressCount[key] = 0;
    }
  }

  /** 检查无进展 */
  checkNoProgress(sessionId: string | undefined, agentId: string | undefined): NoProgressResult {
    const key = this._key(sessionId, agentId);
    const cnt = this._noProgressCount[key] || 0;
    if (cnt >= this.maxNoProgress) {
      return {
        detected: true,
        count: cnt,
        warning: '已连续 ' + cnt + ' 次工具调用无有效输出。请检查任务状态或换方法。',
      };
    }
    return { detected: false, count: cnt };
  }

  /** 清理会话记录 */
  clear(sessionId?: string, agentId?: string): void {
    // session 结束时清理 _calls/_noProgressCount/_lastMsgLen 中对应条目，
    // 避免长生命周期进程中 session 累积导致内存泄漏。
    if (sessionId === undefined && agentId === undefined) {
      // 全部清理
      this._calls = {};
      this._noProgressCount = {};
      this._lastMsgLen = {};
      return;
    }
    if (agentId === undefined) {
      // 按 sessionId 前缀清理所有 agent
      const prefix = (sessionId || 'default') + '::';
      const keys = Object.keys(this._calls);
      for (const k of keys) {
        if (k.indexOf(prefix) === 0) {
          delete this._calls[k];
          delete this._noProgressCount[k];
          delete this._lastMsgLen[k];
        }
      }
      return;
    }
    const key = this._key(sessionId, agentId);
    delete this._calls[key];
    delete this._noProgressCount[key];
    delete this._lastMsgLen[key];
  }

  /** 获取统计 */
  stats(sessionId: string | undefined, agentId: string | undefined): GuardrailStats {
    const key = this._key(sessionId, agentId);
    const arr = this._calls[key] || [];
    return {
      totalCalls: arr.length,
      noProgressCount: this._noProgressCount[key] || 0,
      recent: arr.slice(-5),
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Trajectory — 轨迹记录类型
// ---------------------------------------------------------------------------

/** 轨迹条目 */
interface TrajectoryEntry {
  conversations: unknown[];
  timestamp: string;
  model: string;
  completed: boolean;
}

// ---------------------------------------------------------------------------
// 5. ToolOutputLimits — 工具输出截断常量
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 50000;        // terminal output cap
const DEFAULT_MAX_LINES = 2000;         // file_read pagination cap
const DEFAULT_MAX_LINE_LENGTH = 2000;   // per-line length cap
const DEFAULT_MAX_TOOL_RESULT_CHARS = 30000;  // tool message in conversation

/** 工具输出限制 */
export interface ToolOutputLimits {
  max_bytes: number;
  max_lines: number;
  max_line_length: number;
  max_tool_result_chars: number;
}

// ---------------------------------------------------------------------------
// 6. CredentialPool — 凭证池
// ---------------------------------------------------------------------------

/** 凭证耗尽记录 */
interface ExhaustedEntry {
  reason: string;
  at: number;
}

/** 凭证池状态 */
export interface CredentialPoolStats {
  total: number;
  available: number;
  currentIdx: number;
  exhausted: number;
}

/**
 * CredentialPool — 多 API Key 轮换池
 * 当某 Key 触发 billing/rate_limit/auth 错误时自动切换
 */
export class CredentialPool {
  private _keys: string[];
  private _idx = 0;
  private _exhausted: Record<string, ExhaustedEntry> = {};
  private _cooldownMs = 60 * 1000;  // 默认冷却 60 秒

  constructor(keys?: string[]) {
    this._keys = Array.isArray(keys) ? keys.filter(Boolean) : [];
  }

  add(key: string): void {
    if (key && this._keys.indexOf(key) < 0) this._keys.push(key);
  }

  remove(key: string): void {
    const i = this._keys.indexOf(key);
    if (i >= 0) this._keys.splice(i, 1);
    delete this._exhausted[key];
  }

  current(): string | null {
    return this._keys[this._idx] || null;
  }

  next(): string | null {
    if (this._keys.length === 0) return null;
    // 清理已过冷却期的 Key
    const now = Date.now();
    for (const k of Object.keys(this._exhausted)) {
      if (now - this._exhausted[k].at > this._cooldownMs) {
        delete this._exhausted[k];
      }
    }
    // 寻找下一个可用 Key
    for (let i = 0; i < this._keys.length; i++) {
      this._idx = (this._idx + 1) % this._keys.length;
      if (!this._exhausted[this._keys[this._idx]]) {
        return this._keys[this._idx];
      }
    }
    return null;  // 全部耗尽
  }

  markExhausted(key: string, reason?: string): void {
    if (!key) return;
    this._exhausted[key] = { reason: reason || 'unknown', at: Date.now() };
  }

  size(): number {
    return this._keys.length;
  }

  availableCount(): number {
    const now = Date.now();
    let cnt = 0;
    for (const k of this._keys) {
      if (!this._exhausted[k] || now - this._exhausted[k].at > this._cooldownMs) cnt++;
    }
    return cnt;
  }

  toJSON(): CredentialPoolStats {
    return {
      total: this._keys.length,
      available: this.availableCount(),
      currentIdx: this._idx,
      exhausted: Object.keys(this._exhausted).length,
    };
  }
}

// ---------------------------------------------------------------------------
// 7. FuzzyMatch — 模糊匹配类型
// ---------------------------------------------------------------------------

/** 模糊查找结果 */
export interface FuzzyFindResult {
  found: boolean;
  match: string;
  start: number;
  distance: number;
  exact?: boolean;
}

// ---------------------------------------------------------------------------
// 8. PatchParser — 补丁解析类型
// ---------------------------------------------------------------------------

/** 补丁行类型 */
export type PatchLineType = 'add' | 'del' | 'ctx';

/** 补丁行 */
export interface PatchLine {
  type: PatchLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
}

/** 补丁 hunk */
export interface PatchHunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: PatchLine[];
}

// ---------------------------------------------------------------------------
// 9. PromptCaching — 提示词缓存类型
// ---------------------------------------------------------------------------

/** 缓存控制标记 */
interface CacheControl {
  type: 'ephemeral';
}

/** 带缓存控制的内容块 */
interface CacheContentBlock {
  type: string;
  text?: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 10. VerifyHooks — 验证钩子类型
// ---------------------------------------------------------------------------

/** 验证钩子检查函数返回值 */
interface VerifyCheckResult {
  passed: boolean;
  msg?: string;
  hint?: string;
}

/** 验证钩子 */
interface VerifyHook {
  name: string;
  check: (result: unknown, ctx: unknown) => VerifyCheckResult;
}

/** 验证结果 */
export interface VerifyResult {
  passed: boolean;
  failures: { name: string; msg: string }[];
  suggestions: string[];
}

/** 任务结果（用于验证） */
interface TaskResult {
  text?: string;
  toolCalls?: unknown[];
  [key: string]: unknown;
}

/** 验证上下文 */
interface VerifyContext {
  sessionId?: string;
  task?: string;
  toolsCalled?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 11. Redact — 脱敏常量
// ---------------------------------------------------------------------------

/** 敏感字段名（小写匹配） */
const SENSITIVE_KEYS = [
  'apikey', 'api_key', 'password', 'passwd', 'pwd',
  'token', 'access_token', 'refresh_token', 'auth_token',
  'secret', 'client_secret', 'private_key',
  'authorization', 'cookie', 'session_id', 'sessionid',
  'ssn', 'credit_card', 'cardnumber', 'cvv',
];

/** 敏感内容正则模式 */
const SENSITIVE_PATTERNS: { re: RegExp; replacement: string }[] = [
  // API Key 形态（sk-xxx, sk-ant-xxx 等）
  { re: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: 'sk-***REDACTED***' },
  { re: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: 'sk-ant-***REDACTED***' },
  // Bearer token
  { re: /Bearer\s+[a-zA-Z0-9_.\-:/+=]{20,}/g, replacement: 'Bearer ***REDACTED***' },
  // JWT
  { re: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, replacement: '***JWT_REDACTED***' },
  // 邮箱
  { re: /[\w.-]+@[\w.-]+\.\w{2,}/g, replacement: '***EMAIL***' },
  // 信用卡号（16 位）
  { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '***CARD***' },
];

// ===========================================================================
// SafetyManagerService — 主服务
// ===========================================================================

/**
 * SafetyManagerService - 运行时安全与可靠性增强服务
 *
 * 独立于 SecurityManager，提供：
 *   - API 错误分类与恢复策略
 *   - 迭代预算控制（防无限循环）
 *   - 工具调用护栏（doom loop 检测）
 *   - 执行轨迹记录
 *   - 工具输出截断
 *   - API Key 轮换池
 *   - 模糊匹配（file_edit 容错）
 *   - 补丁解析（apply_patch 增强）
 *   - Anthropic 提示词缓存
 *   - 任务完成验证钩子
 *   - 日志脱敏
 */
@Injectable()
export class SafetyManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyManagerService.name);

  // Trajectory 状态
  private trajectoryDir: string | null = null;

  // ToolOutputLimits 缓存
  private cachedLimits: ToolOutputLimits | null = null;

  // VerifyHooks 状态
  private verifyHooks: VerifyHook[] = [];
  private readonly maxVerifyAttempts = 3;

  constructor() {
    // 注册默认验证钩子：检查 AI 是否真的调用了工具（避免"假干活"）
    // 用户曾反馈："让它干活是假干活，比如打开浏览器做了某个操作，它跟你说做了。实际没有做！"
    this.verifyHooks.push({
      name: 'tool_executed_check',
      check: this.defaultVerifyToolExecuted.bind(this),
    });
  }

  onModuleInit(): void {
    this.logger.debug('SafetyManagerService 已初始化');
  }

  onModuleDestroy(): void {
    // 清理验证钩子
    this.verifyHooks = [];
  }

  // =========================================================================
  // 1. ErrorClassifier — 结构化 API 错误分类与恢复策略
  //    对齐 hermes-agent/agent/error_classifier.py
  // =========================================================================

  /** 匹配文本中是否包含任一模式，返回首个匹配的模式或 null */
  private matchAny(text: string, patterns: string[]): string | null {
    const lower = (text || '').toLowerCase();
    for (const p of patterns) {
      if (lower.indexOf(p) >= 0) return p;
    }
    return null;
  }

  /** 构造分类错误对象 */
  private mkError(
    reason: FailoverReasonType,
    status: number,
    provider: string,
    model: string,
    message: string,
    errorContext: { raw: string; status: number; provider: string; model: string },
    hints: {
      retryable?: boolean;
      shouldCompress?: boolean;
      shouldRotateCredential?: boolean;
      shouldFallback?: boolean;
      backoffMs?: number;
    },
  ): ClassifiedError {
    return {
      reason,
      status_code: status,
      provider,
      model,
      message,
      error_context: errorContext,
      retryable: !!hints.retryable,
      should_compress: !!hints.shouldCompress,
      should_rotate_credential: !!hints.shouldRotateCredential,
      should_fallback: !!hints.shouldFallback,
      backoffMs: hints.backoffMs || 0,
      is_auth: reason === FailoverReason.auth || reason === FailoverReason.auth_permanent,
    };
  }

  /**
   * 分类 API 错误，返回结构化的故障转移决策
   * 替换 start.cjs 中简陋的 classifyAIError()
   */
  classifyApiError(error: { message?: string; status?: number; statusCode?: number } | Error | string, provider?: string, model?: string): ClassifiedError {
    const err = error as { message?: string; status?: number; statusCode?: number };
    const msg = (err && err.message) || String(error || '');
    const status = (err && (err.status || err.statusCode)) || 0;
    const ctx = { raw: msg, status, provider: provider || '', model: model || '' };

    // 优先级 1: 账单/余额耗尽（不可恢复，必须换 Key）
    if (status === 402 || this.matchAny(msg, BILLING_PATTERNS)) {
      return this.mkError(FailoverReason.billing, status, provider || '', model || '', msg, ctx, {
        retryable: false, shouldRotateCredential: true, shouldFallback: true,
      });
    }

    // 优先级 2: 上下文溢出（需要压缩，不要重试同一请求）
    if (this.matchAny(msg, CONTEXT_OVERFLOW_PATTERNS) ||
        (status === 400 && this.matchAny(msg, ['context', 'token']))) {
      return this.mkError(FailoverReason.context_overflow, status, provider || '', model || '', msg, ctx, {
        retryable: false, shouldCompress: true,
      });
    }

    // 优先级 3: 模型不存在（必须换模型）
    if (status === 404 || this.matchAny(msg, MODEL_NOT_FOUND_PATTERNS)) {
      return this.mkError(FailoverReason.model_not_found, status, provider || '', model || '', msg, ctx, {
        retryable: false, shouldFallback: true,
      });
    }

    // 优先级 4: 内容策略拒绝（同请求重试无用）
    if (this.matchAny(msg, CONTENT_POLICY_PATTERNS)) {
      return this.mkError(FailoverReason.content_policy_blocked, status, provider || '', model || '', msg, ctx, {
        retryable: false,
      });
    }

    // 优先级 5: Payload 太大（需要压缩 payload）
    if (status === 413 || this.matchAny(msg, PAYLOAD_TOO_LARGE_PATTERNS)) {
      return this.mkError(FailoverReason.payload_too_large, status, provider || '', model || '', msg, ctx, {
        retryable: false, shouldCompress: true,
      });
    }

    // 优先级 6: 429 — 区分 rate_limit / upstream_overloaded
    if (status === 429) {
      // 服务端过载（不是用户限流），不要轮换 Key
      if (this.matchAny(msg, OVERLOADED_PATTERNS)) {
        return this.mkError(FailoverReason.overloaded, status, provider || '', model || '', msg, ctx, {
          retryable: true, backoffMs: 5000,
        });
      }
      // 用户级限流，可以轮换 Key
      if (this.matchAny(msg, ['upstream', 'provider rate'])) {
        return this.mkError(FailoverReason.upstream_rate_limit, status, provider || '', model || '', msg, ctx, {
          retryable: true, backoffMs: 3000, shouldFallback: true,
        });
      }
      return this.mkError(FailoverReason.rate_limit, status, provider || '', model || '', msg, ctx, {
        retryable: true, backoffMs: 2000, shouldRotateCredential: true,
      });
    }

    // 优先级 7: 503 — 服务过载
    if (status === 503 || this.matchAny(msg, OVERLOADED_PATTERNS)) {
      return this.mkError(FailoverReason.overloaded, status, provider || '', model || '', msg, ctx, {
        retryable: true, backoffMs: 5000,
      });
    }

    // 优先级 8: 401/403 — 认证失败
    // 区分 auth（暂时性，可换 Key 重试）与 auth_permanent（永久性，所有 Key 都无效）。
    //   - 403 且消息含 "permanent"/"disabled"/"revoked"/"suspended" → auth_permanent
    //   - 其他 401/403 → auth
    // 之前 FailoverReason.auth_permanent 定义了但永不返回，是不可达分支。
    if (status === 401 || status === 403 || this.matchAny(msg, AUTH_PATTERNS)) {
      const permAuth = (status === 403) && !!this.matchAny(msg, AUTH_PERMANENT_KEYWORDS);
      if (permAuth) {
        return this.mkError(FailoverReason.auth_permanent, status, provider || '', model || '', msg, ctx, {
          retryable: false, shouldRotateCredential: true, shouldFallback: true,
        });
      }
      return this.mkError(FailoverReason.auth, status, provider || '', model || '', msg, ctx, {
        retryable: false, shouldRotateCredential: true,
      });
    }

    // 优先级 9: SSL 证书
    if (this.matchAny(msg, SSL_CERT_PATTERNS)) {
      return this.mkError(FailoverReason.ssl_cert_verification, status, provider || '', model || '', msg, ctx, {
        retryable: false,
      });
    }

    // 优先级 10: 超时
    if (this.matchAny(msg, ['timeout', 'timed out', 'etimedout', 'esockettimedout'])) {
      return this.mkError(FailoverReason.timeout, status || 408, provider || '', model || '', msg, ctx, {
        retryable: true, backoffMs: 1000,
      });
    }

    // 优先级 11: 5xx 服务器错误
    if (status >= 500) {
      // 但如果 body 含请求校验关键字，归类为 format_error
      if (this.matchAny(msg, FORMAT_ERROR_PATTERNS)) {
        return this.mkError(FailoverReason.format_error, status, provider || '', model || '', msg, ctx, {
          retryable: false,
        });
      }
      return this.mkError(FailoverReason.server_error, status, provider || '', model || '', msg, ctx, {
        retryable: true, backoffMs: 3000,
      });
    }

    // 优先级 12: 400 格式错误
    if (status === 400 || this.matchAny(msg, FORMAT_ERROR_PATTERNS)) {
      // thinking signature 错误（Anthropic）
      if (this.matchAny(msg, ['thinking', 'signature'])) {
        return this.mkError(FailoverReason.thinking_signature, status, provider || '', model || '', msg, ctx, {
          retryable: true, backoffMs: 0,
        });
      }
      return this.mkError(FailoverReason.format_error, status, provider || '', model || '', msg, ctx, {
        retryable: false,
      });
    }

    // 兜底
    return this.mkError(FailoverReason.unknown, status || 500, provider || '', model || '', msg, ctx, {
      retryable: false,
    });
  }

  // =========================================================================
  // 2. IterationBudget — 工厂方法
  // =========================================================================

  /** 创建 parent 迭代预算（默认 90） */
  createParentBudget(maxIter?: number): IterationBudget {
    return new IterationBudget(maxIter || DEFAULT_PARENT_MAX);
  }

  /** 创建 subagent 迭代预算（默认 50） */
  createSubagentBudget(maxIter?: number): IterationBudget {
    return new IterationBudget(maxIter || DEFAULT_SUBAGENT_MAX);
  }

  // =========================================================================
  // 3. ToolGuardrails — 工厂方法
  // =========================================================================

  /** 创建工具护栏控制器 */
  createToolGuardrailController(opts?: {
    maxSameCall?: number;
    maxSameToolFail?: number;
    maxNoProgress?: number;
    windowMs?: number;
  }): ToolGuardrailController {
    return new ToolGuardrailController(opts);
  }

  // =========================================================================
  // 4. Trajectory — 执行轨迹记录
  //    对齐 hermes-agent/agent/trajectory.py
  //    保存到 trajectory_samples.jsonl（成功）/ failed_trajectories.jsonl（失败）
  // =========================================================================

  /** 设置轨迹目录 */
  setTrajectoryDir(dir: string): void {
    this.trajectoryDir = dir;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.logger.warn(`创建轨迹目录失败: ${dir} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 保存轨迹到 JSONL 文件 */
  saveTrajectory(trajectory: unknown[], model: string, completed: boolean, filename?: string): void {
    if (!this.trajectoryDir) return;
    if (!filename) {
      filename = completed ? 'trajectory_samples.jsonl' : 'failed_trajectories.jsonl';
    }
    const entry: TrajectoryEntry = {
      conversations: trajectory || [],
      timestamp: new Date().toISOString(),
      model: model || '',
      completed: !!completed,
    };
    try {
      const fp = join(this.trajectoryDir, filename);
      // JSONL 规范要求每行一个 JSON 对象，不能用多行缩进（JSON.stringify
      //   的第三参 2 会插入换行+缩进，破坏 JSONL 格式，导致下游流式解析失败）。
      //   改为单行紧凑 JSON + 单个 \n 分隔。
      // 限制单文件最大 10MB，超过时轮转为 .1/.2 后缀，避免磁盘耗尽。
      const MAX_TRAJ_BYTES = 10 * 1024 * 1024;
      try {
        if (existsSync(fp)) {
          const fstat = statSync(fp);
          if (fstat.size > MAX_TRAJ_BYTES) {
            // 简单轮转：旧 .2 删除，.1 -> .2，当前 -> .1
            try { unlinkSync(fp + '.2'); } catch { /* ignore */ }
            try { if (existsSync(fp + '.1')) renameSync(fp + '.1', fp + '.2'); } catch { /* ignore */ }
            try { renameSync(fp, fp + '.1'); } catch { /* ignore */ }
          }
        }
      } catch {
        /* ignore stat errors */
      }
      appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      // 静默失败，轨迹记录不能影响主流程
      this.logger.debug(`保存轨迹失败（静默忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 将 scratchpad 标记转换为 think 标记 */
  convertScratchpadToThink(content: string): string {
    if (!content || content.indexOf('<REASONING_SCRATCHPAD>') < 0) return content;
    return content.replace(/<REASONING_SCRATCHPAD>/g, '<think>').replace(/<\/REASONING_SCRATCHPAD>/g, '</think>');
  }

  /** 检查是否有未闭合的 scratchpad */
  hasIncompleteScratchpad(content: string): boolean {
    if (!content) return false;
    return content.indexOf('<REASONING_SCRATCHPAD>') >= 0 && content.indexOf('</REASONING_SCRATCHPAD>') < 0;
  }

  // =========================================================================
  // 5. ToolOutputLimits — 可配置工具输出截断
  //    对齐 hermes-agent/tools/tool_output_limits.py
  // =========================================================================

  /** 获取工具输出限制（带缓存） */
  getToolOutputLimits(): ToolOutputLimits {
    if (this.cachedLimits) return this.cachedLimits;
    this.cachedLimits = {
      max_bytes: DEFAULT_MAX_BYTES,
      max_lines: DEFAULT_MAX_LINES,
      max_line_length: DEFAULT_MAX_LINE_LENGTH,
      max_tool_result_chars: DEFAULT_MAX_TOOL_RESULT_CHARS,
    };
    return this.cachedLimits;
  }

  /** 重置工具输出限制缓存 */
  resetToolOutputLimitsCache(): void {
    this.cachedLimits = null;
  }

  getMaxBytes(): number {
    return this.getToolOutputLimits().max_bytes;
  }

  getMaxLines(): number {
    return this.getToolOutputLimits().max_lines;
  }

  getMaxLineLength(): number {
    return this.getToolOutputLimits().max_line_length;
  }

  getMaxToolResultChars(): number {
    return this.getToolOutputLimits().max_tool_result_chars;
  }

  /** 截断工具输出（保留头尾） */
  truncateOutput(text: string, maxChars?: number): string {
    if (!text) return '';
    const s = String(text);
    const max = maxChars || this.getMaxToolResultChars();
    if (s.length <= max) return s;
    const headLen = Math.floor(max * 0.6);
    const tailLen = Math.floor(max * 0.3);
    return s.substring(0, headLen) +
      '\n\n... [已截断，原始长度: ' + s.length + ' 字符] ...\n\n' +
      s.substring(s.length - tailLen);
  }

  /** 按行截断 */
  truncateLines(text: string, maxLines?: number): string {
    if (!text) return '';
    const lines = String(text).split('\n');
    const max = maxLines || this.getMaxLines();
    if (lines.length <= max) return text;
    return lines.slice(0, max).join('\n') + '\n... [已截断，共 ' + lines.length + ' 行，保留前 ' + max + ' 行]';
  }

  /** 按行长度截断 */
  truncateLongLines(text: string, maxLineLen?: number): string {
    if (!text) return '';
    const max = maxLineLen || this.getMaxLineLength();
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > max) {
        lines[i] = lines[i].substring(0, max) + ' ... [行长度截断，原始: ' + lines[i].length + ' 字符]';
      }
    }
    return lines.join('\n');
  }

  // =========================================================================
  // 6. CredentialPool — 凭证池工厂方法
  // =========================================================================

  /** 从配置构建凭证池（每个 provider 可有多个 Key，逗号分隔） */
  buildPoolFromConfig(configStore: { providers?: Record<string, { apiKey?: string }> } | null, providerId: string): CredentialPool | null {
    if (!configStore || !configStore.providers || !providerId) return null;
    const p = configStore.providers[providerId];
    if (!p || !p.apiKey) return null;
    const keys = String(p.apiKey).split(',').map((s) => s.trim()).filter(Boolean);
    if (keys.length <= 1) return null;
    return new CredentialPool(keys);
  }

  // =========================================================================
  // 7. FuzzyMatch — 模糊匹配
  //    对齐 hermes-agent/tools/fuzzy_match.py
  //    用于 file_edit 容错：当 old_string 找不到精确匹配时，寻找最相似片段
  // =========================================================================

  /** Levenshtein 距离（带最大值剪枝，超过 maxDist 直接返回 maxDist+1） */
  private levenshtein(a: string, b: string, maxDist?: number): number {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const limit = maxDist || Math.max(al, bl);
    if (Math.abs(al - bl) > limit) return limit + 1;

    // 使用 let 以支持引用交换（对齐原始 JS 的 var tmp = prev; prev = cur; cur = tmp;）
    let prev = new Array<number>(bl + 1);
    let cur = new Array<number>(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      cur[0] = i;
      for (let j = 1; j <= bl; j++) {
        const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[bl];
  }

  /** 在 text 中找到与 pattern 最相似的片段 */
  fuzzyFind(text: string, pattern: string, maxDist?: number): FuzzyFindResult {
    if (!text || !pattern) return { found: false, match: '', start: -1, distance: 0 };
    const t = String(text), p = String(pattern);
    const exactIdx = t.indexOf(p);
    if (exactIdx >= 0) {
      return { found: true, match: p, start: exactIdx, distance: 0, exact: true };
    }
    const pl = p.length;
    const tl = t.length;
    if (pl > tl) return { found: false, match: '', start: -1, distance: 0 };

    let threshold = maxDist || Math.floor(pl * 0.2);  // 默认容忍 20% 编辑距离
    if (threshold < 1) threshold = 1;
    let best: FuzzyFindResult = { found: false, match: '', start: -1, distance: threshold + 1 };

    // 滑动窗口步长过大会漏匹配 — 原步长 pl/4 在 pl=80 时步长 20，
    // 而 threshold=16，意味着可能直接跨过正确匹配位置。改为步长 = max(1, pl/16)，
    // 配合 threshold 内的编辑距离，确保不会漏过合法候选。
    const step = Math.max(1, Math.floor(pl / 16));
    for (let start = 0; start + pl <= tl; start += step) {
      const candidate = t.substring(start, start + pl);
      const d = this.levenshtein(p, candidate, threshold);
      if (d < best.distance) {
        best = { found: true, match: candidate, start, distance: d, exact: false };
        if (d === 0) break;
      }
    }
    if (best.distance > threshold) best.found = false;
    return best;
  }

  /** 计算相似度（0-1） */
  similarity(a: string, b: string): number {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const d = this.levenshtein(a, b, maxLen);
    return 1 - d / maxLen;
  }

  // =========================================================================
  // 8. PatchParser — 补丁解析
  //    对齐 hermes-agent/tools/patch_parser.py
  //    增强 apply_patch 工具，支持解析 unified diff 格式
  // =========================================================================

  /** 解析 unified diff 格式（@@ -start,count +start,count @@） */
  parseUnifiedDiff(diffText: string): PatchHunk[] {
    if (!diffText) return [];
    const lines = String(diffText).split('\n');
    const hunks: PatchHunk[] = [];
    let current: PatchHunk | null = null;
    let oldLine = 0, newLine = 0;

    for (const line of lines) {
      // 文件头
      if (line.indexOf('--- ') === 0) continue;
      if (line.indexOf('+++ ') === 0) continue;
      // hunk 头
      const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (m) {
        if (current) hunks.push(current);
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[3], 10);
        current = {
          oldStart: oldLine,
          newStart: newLine,
          oldCount: m[2] ? parseInt(m[2], 10) : 1,
          newCount: m[4] ? parseInt(m[4], 10) : 1,
          lines: [],
        };
        continue;
      }
      if (!current) continue;
      if (line.charAt(0) === '+') {
        current.lines.push({ type: 'add', content: line.substring(1), newLine: newLine++ });
      } else if (line.charAt(0) === '-') {
        current.lines.push({ type: 'del', content: line.substring(1), oldLine: oldLine++ });
      } else if (line.charAt(0) === ' ') {
        current.lines.push({ type: 'ctx', content: line.substring(1), oldLine: oldLine++, newLine: newLine++ });
      } else if (line.charAt(0) === '\\') {
        // \ No newline at end of file
        if (current.lines.length > 0) current.lines[current.lines.length - 1].noNewline = true;
      }
    }
    if (current) hunks.push(current);
    return hunks;
  }

  /** 在指定位置检查文本是否匹配 */
  private matchAt(lines: string[], startIdx: number, expected: string[]): boolean {
    if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (String(lines[startIdx + i]).trim() !== String(expected[i]).trim()) return false;
    }
    return true;
  }

  /** 应用补丁到文本 */
  applyHunks(text: string, hunks: PatchHunk[]): string {
    if (!text || !hunks || hunks.length === 0) return text;
    const lines = String(text).split('\n');
    // 从后往前应用，避免行号偏移
    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h];
      let startIdx = hunk.oldStart - 1;  // 0-based
      if (startIdx < 0) startIdx = 0;
      // 找到匹配位置（精确 + 模糊）
      const expectedCtx = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.content);
      let matched = false;
      for (let offset = 0; offset < 5 && !matched; offset++) {
        if (this.matchAt(lines, startIdx + offset, expectedCtx)) {
          startIdx += offset;
          matched = true;
        } else if (startIdx - offset >= 0 && this.matchAt(lines, startIdx - offset, expectedCtx)) {
          startIdx -= offset;
          matched = true;
        }
      }
      if (!matched) continue;  // 跳过无法匹配的 hunk
      // 替换：先删除 del/ctx 行，再插入 add 行
      const delCount = hunk.lines.filter((l) => l.type === 'del' || l.type === 'ctx').length;
      const insertLines = hunk.lines.filter((l) => l.type === 'add' || l.type === 'ctx').map((l) => l.content);
      lines.splice(startIdx, delCount, ...insertLines);
    }
    return lines.join('\n');
  }

  // =========================================================================
  // 9. PromptCaching — Anthropic 提示词缓存控制
  //    对齐 hermes-agent/agent/prompt_caching.py
  //    为 Anthropic API 请求插入 cache_control 字段，减少重复 token 成本
  // =========================================================================

  /**
   * 为消息列表添加 cache_control 标记
   * 策略：标记最近 3 条非系统消息
   */
  applyAnthropicCacheControl(messages: Record<string, unknown>[], _systemPrompt?: string): Record<string, unknown>[] {
    if (!messages || messages.length === 0) return messages;

    const result = messages.map((m) => {
      return JSON.parse(JSON.stringify(m)) as Record<string, unknown>;  // deep clone
    });

    // 标记最后 3 条消息
    const toMark = Math.min(3, result.length);
    for (let i = result.length - toMark; i < result.length; i++) {
      const m = result[i];
      const content = m['content'] as unknown;
      if (content && typeof content === 'object' && Array.isArray(content)) {
        // 多模态内容：标记最后一个 block
        const blocks = content as CacheContentBlock[];
        if (blocks.length > 0) {
          blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
        }
      } else if (typeof content === 'string') {
        // 字符串内容：转为单元素数组并标记
        m['content'] = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
      }
    }
    return result;
  }

  /** 为 system prompt 添加 cache_control */
  applySystemCacheControl(systemPrompt: string | CacheContentBlock[] | null): string | CacheContentBlock[] | null {
    if (!systemPrompt) return systemPrompt;
    if (typeof systemPrompt === 'string') {
      return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
    }
    if (Array.isArray(systemPrompt)) {
      if (systemPrompt.length > 0) {
        const last = systemPrompt[systemPrompt.length - 1];
        if (last && typeof last === 'object') {
          last.cache_control = { type: 'ephemeral' };
        }
      }
      return systemPrompt;
    }
    return systemPrompt;
  }

  // =========================================================================
  // 10. VerifyHooks — 任务完成验证钩子
  //     对齐 hermes-agent/agent/verify_hooks.py
  //     在 AI 声明任务完成前，检查是否真的完成了
  // =========================================================================

  /** 添加验证钩子 */
  addVerifyHook(hook: VerifyHook): void {
    if (!hook || !hook.name || typeof hook.check !== 'function') return;
    this.verifyHooks.push(hook);
  }

  /** 清除所有验证钩子 */
  clearVerifyHooks(): void {
    this.verifyHooks = [];
  }

  /**
   * 运行所有验证钩子
   * @param result AI 的最终输出 { text, toolCalls, ... }
   * @param ctx { sessionId, task, toolsCalled, ... }
   * @returns { passed, failures, suggestions }
   */
  runVerifyHooks(result: TaskResult, ctx: VerifyContext): VerifyResult {
    const failures: { name: string; msg: string }[] = [];
    const suggestions: string[] = [];
    if (this.verifyHooks.length === 0) return { passed: true, failures: [], suggestions: [] };
    for (const hook of this.verifyHooks) {
      try {
        const r = hook.check(result, ctx);
        if (!r || !r.passed) {
          failures.push({ name: hook.name, msg: r ? (r.msg || '验证失败') : '验证失败' });
          if (r && r.hint) suggestions.push(r.hint);
        }
      } catch (e) {
        failures.push({ name: hook.name, msg: '验证异常: ' + (e instanceof Error ? e.message : String(e)) });
      }
    }
    return { passed: failures.length === 0, failures, suggestions };
  }

  /**
   * 默认验证钩子：检查 AI 是否真的调用了工具（避免"假干活"）
   * 用户曾反馈："让它干活是假干活，比如打开浏览器做了某个操作，它跟你说做了。实际没有做！"
   */
  private defaultVerifyToolExecuted(result: unknown, ctx: unknown): VerifyCheckResult {
    const r = result as TaskResult;
    const c = ctx as VerifyContext;
    if (!c || !c.toolsCalled || c.toolsCalled === 0) {
      // 如果 AI 声明完成了但没调用任何工具，可疑
      if (r && r.text && /完成|done|已完成|已执行|已打开|已创建/i.test(r.text)) {
        return {
          passed: false,
          msg: 'AI 声明完成任务但未调用任何工具，疑似幻觉',
          hint: '请确认任务真的需要执行操作，如果是查询/解释类则忽略此警告',
        };
      }
    }
    return { passed: true };
  }

  // =========================================================================
  // 11. Redact — 日志脱敏
  //     在记录日志前识别敏感字段，避免凭据进入日志。
  //     增强 sanitizeApiKey，支持更多敏感字段
  // =========================================================================

  /** 检查字段名是否敏感 */
  isSensitiveKey(key: string): boolean {
    if (!key) return false;
    const k = String(key).toLowerCase();
    return SENSITIVE_KEYS.indexOf(k) >= 0;
  }

  /** 脱敏字符串 */
  redactString(str: string): string {
    if (!str || typeof str !== 'string') return str;
    let s = str;
    for (const pattern of SENSITIVE_PATTERNS) {
      s = s.replace(pattern.re, pattern.replacement);
    }
    return s;
  }

  /**
   * 脱敏对象（递归）
   * 用 WeakSet 检测循环引用，避免栈溢出。原来仅靠 depth 限制，
   *   循环引用对象在 depth=5 之前就会因递归过深栈溢出。
   */
  redactObject(obj: unknown, depth?: number, seen?: WeakSet<object>): unknown {
    const d = depth === undefined ? 0 : depth;
    const s = seen === undefined ? new WeakSet<object>() : seen;
    if (d > 5) return obj;
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.redactString(obj);
    if (typeof obj !== 'object') return obj;
    // 循环引用检测：obj 已在当前路径出现过，则不再递归
    if (s.has(obj as object)) return '[Circular]';
    s.add(obj as object);
    if (Array.isArray(obj)) {
      const arrResult = obj.map((v) => this.redactObject(v, d + 1, s));
      s.delete(obj as object);
      return arrResult;
    }
    const result: Record<string, unknown> = {};
    const objRecord = obj as Record<string, unknown>;
    for (const k in objRecord) {
      if (!Object.prototype.hasOwnProperty.call(objRecord, k)) continue;
      if (this.isSensitiveKey(k)) {
        result[k] = '***REDACTED***';
      } else {
        result[k] = this.redactObject(objRecord[k], d + 1, s);
      }
    }
    s.delete(obj as object);
    return result;
  }

  /**
   * 脱敏 API Key（保留前 6 位）
   * 短 key（<=8 字符）原本返回 '***' 仍可能让攻击者通过长度推测；
   *   现改为短 key 仅显示首末各 1 字符，最大限度隐藏长度信息。
   */
  maskApiKey(key: string): string {
    if (!key) return '';
    const s = String(key);
    if (s.length <= 8) {
      // 短 key 仅显示首末各 1 字符
      if (s.length <= 2) return '*';
      return s.charAt(0) + '*'.repeat(s.length - 2) + s.charAt(s.length - 1);
    }
    if (s.length <= 10) return '***';
    return s.substring(0, 6) + '***' + s.substring(s.length - 4);
  }

  // =========================================================================
  // 公开常量访问器
  // =========================================================================

  /** 获取默认 parent 最大迭代数 */
  get DEFAULT_PARENT_MAX(): number {
    return DEFAULT_PARENT_MAX;
  }

  /** 获取默认 subagent 最大迭代数 */
  get DEFAULT_SUBAGENT_MAX(): number {
    return DEFAULT_SUBAGENT_MAX;
  }

  /** 获取最大验证尝试次数 */
  get MAX_VERIFY_ATTEMPTS(): number {
    return this.maxVerifyAttempts;
  }
}
