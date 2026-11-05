import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../../core/logger/logger.service.js';
import { AgentLoopService } from '../agent/agent-loop.service.js';

/**
 * AcpSessionService (ACP 会话管理) - NestJS TypeScript 重写
 *
 * 移植自 packages/web/acp-manager.cjs 的 ControlPlane（第 947-1155 行）。
 *
 * 核心能力：
 *   - 会话创建 / 恢复 / 关闭 / 取消
 *   - 会话级 turn 串行化（actor 队列，同一会话同时只允许一个 turn）
 *   - turn 超时 / 中止（AbortController）
 *   - 速率限制（初始化 + turn，60 秒窗口 100 次）
 *   - 延迟统计（完成数 / 失败数 / 平均 / 最大 / 错误码计数）
 *   - 过期会话清理（30 分钟无活动，running 会话最长 24 小时）
 *   - 事件派发（通过 EventEmitter2）
 */

/** 速率限制窗口（60 秒） */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 速率限制最大次数 */
const RATE_LIMIT_MAX = 100;
/** 会话 TTL（1 小时无活动） */
const SESSION_TTL_MS = 3_600_000;
/** running 会话最大运行时间（24 小时） */
const RUNNING_SESSION_MAX_MS = 24 * 3_600_000;
/** 清理扫描间隔（5 分钟） */
const CLEANUP_INTERVAL_MS = 300_000;
/** 默认 turn 超时（5 分钟） */
const DEFAULT_TURN_TIMEOUT_MS = 0;
/** prompt 最大字节数（2MB） */
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

/** ACP 会话状态 */
export type AcpControlSessionStatus =
  | 'initialized'
  | 'idle'
  | 'running'
  | 'closed'
  | 'cancelled'
  | 'expired'
  | 'error';

/** ACP 控制面会话 */
export interface AcpControlSession {
  sessionId: string;
  agentId: string;
  channel: string;
  peerId: string;
  status: AcpControlSessionStatus;
  createdAt: number;
  lastActivity: number;
  turns: number;
  metadata: Record<string, unknown>;
  runtimeOptions: Record<string, unknown>;
  backendCandidates: string[];
  closedAt?: number;
  cancelledAt?: number;
}

/** 活跃 turn */
interface ActiveTurn {
  turnId: string;
  startedAt: number;
  mode: 'prompt' | 'oneshot';
  prompt: string;
  abortController: AbortController;
}

/** 初始化会话入参 */
export interface InitializeSessionInput {
  sessionId?: string;
  agentId?: string;
  channel?: string;
  peerId?: string;
  metadata?: Record<string, unknown>;
  runtimeOptions?: Record<string, unknown>;
  backendCandidates?: string[];
}

/** runTurn 入参 */
export interface RunTurnInput {
  sessionId: string;
  prompt: string;
  mode?: 'prompt' | 'oneshot';
  attachments?: unknown[];
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** turn 执行结果 */
export interface TurnResult {
  success: boolean;
  sessionId?: string;
  turnId?: string;
  turn?: number;
  status?: string;
  durationMs?: number;
  error?: string;
  errorCode?: string;
  async?: boolean;
  content?: string;
}

/** 延迟统计 */
export interface LatencyStats {
  completed: number;
  failed: number;
  avgMs: number;
  maxMs: number;
  totalMs: number;
  errorCountsByCode: Record<string, number>;
}

/** 会话列表条目 */
export interface SessionListItem {
  sessionId: string;
  agentId: string;
  channel: string;
  status: AcpControlSessionStatus;
  turns: number;
  createdAt: number;
  lastActivity: number;
  hasActiveTurn: boolean;
}

/** 通用操作结果 */
export interface AcpOpResult {
  success: boolean;
  sessionId?: string;
  turnId?: string;
  durationMs?: number;
  error?: string;
  errorCode?: string;
}

@Injectable()
export class AcpSessionService implements OnModuleInit, OnModuleDestroy {
  /** 会话存储：sessionId -> 会话 */
  private readonly sessions = new Map<string, AcpControlSession>();
  /** 活跃 turn：sessionId -> ActiveTurn */
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** 会话级 actor 队列（串行化 turn）：sessionId -> Promise 链 */
  private readonly sessionActors = new Map<string, Promise<unknown>>();
  /** 速率限制：key -> {count, windowStart} */
  private readonly rateLimits = new Map<string, { count: number; windowStart: number }>();
  /** 延迟统计 */
  private turnLatencyStats = { completed: 0, failed: 0, totalMs: 0, maxMs: 0 };
  /** 错误码计数 */
  private errorCountsByCode: Record<string, number> = {};
  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly logger: LoggerService,
    private readonly events: EventEmitter2,
    private readonly agentLoop: AgentLoopService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 初始化会话
   * - sessionId 已存在则失败
   * - 速率限制校验（init:<agentId>）
   * - 状态 initialized
   */
  initializeSession(input: InitializeSessionInput = {}): AcpOpResult & { sessionId?: string } {
    const sessionId = input.sessionId || this._generateId('session');
    const agentId = input.agentId || 'main';
    const channel = input.channel || 'stdio';
    const peerId = input.peerId || '';

    if (this.sessions.has(sessionId)) {
      return { success: false, error: `Session already exists: ${sessionId}`, sessionId };
    }
    if (!this._checkRateLimit(`init:${agentId}`)) {
      return { success: false, error: `Rate limit exceeded for agent: ${agentId}` };
    }

    const session: AcpControlSession = {
      sessionId,
      agentId,
      channel,
      peerId,
      status: 'initialized',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      turns: 0,
      metadata: input.metadata || {},
      runtimeOptions: input.runtimeOptions || {},
      backendCandidates: input.backendCandidates || ['default'],
    };
    this.sessions.set(sessionId, session);
    this.events.emit('acp:session_initialized', session);
    this.logger.info('acp-session: Session initialized', { sessionId, agentId });
    return { success: true, sessionId };
  }

  /**
   * 运行 turn
   * - 通过会话级 actor 队列串行化（同一会话同时只允许一个 turn）
   * - 校验会话存在 / 状态 / 是否已有活跃 turn / 速率限制
   * - prompt 大小校验（2MB）
   * - 调用 AgentLoopService 驱动 AI 执行
   * - oneshot 模式：turn 完成后自动关闭会话
   */
  runTurn(input: RunTurnInput): TurnResult {
    const sessionId = input.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: `Session not found: ${sessionId || '(none)'}` };
    }
    // 通过 actor 队列串行化
    const turnInput = input;
    const result = this._withSessionActor(sessionId, () => this._executeTurnSerialized(turnInput));
    // _executeTurnSerialized 返回的是 TurnResult 或 Promise<TurnResult>，
    // 为保持与 .cjs 一致的同步入口签名，这里直接返回（异步执行由内部处理）
    return result as TurnResult;
  }

  /**
   * 串行执行 turn（在 actor 队列内调用）
   */
  private _executeTurnSerialized(input: RunTurnInput): TurnResult {
    const sessionId = input.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session not found: ${sessionId}` };
    if (session.status === 'closed') return { success: false, error: `Session is closed: ${sessionId}` };
    if (session.status === 'cancelled') return { success: false, error: `Session is cancelled: ${sessionId}` };
    if (this.activeTurns.has(sessionId)) {
      return { success: false, error: `Turn already in progress for session: ${sessionId}` };
    }
    if (!this._checkRateLimit(`turn:${sessionId}`)) {
      return { success: false, error: `Rate limit exceeded for session: ${sessionId}` };
    }

    const prompt = input.prompt || '';
    const mode = input.mode || 'prompt';
    const attachments = input.attachments || [];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    // CWE-400: prompt 大小防御
    if (prompt && Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      return { success: false, error: 'Prompt exceeds maximum size limit (2MB)' };
    }

    session.status = 'running';
    session.lastActivity = Date.now();
    session.turns++;

    const turnId = this._generateId('turn');
    const abortController = new AbortController();
    const externalSignal = input.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        return { success: false, error: 'Turn was aborted before starting' };
      }
      externalSignal.addEventListener('abort', () => {
        abortController.abort();
        if (this.activeTurns.get(sessionId)?.turnId === turnId) {
          this.failTurn(sessionId, 'Turn aborted by signal', 'ABORTED');
        }
      });
    }
    const turnStart = Date.now();
    this.activeTurns.set(sessionId, {
      turnId,
      startedAt: turnStart,
      mode,
      prompt,
      abortController,
    });

    this.events.emit('acp:turn_started', { sessionId, turn: session.turns, turnId });

    // 异步执行 AI 调用（带超时 + 后端 failover）
    void this._executeTurnWithFailover(sessionId, prompt, attachments, input, timeoutMs, turnId, mode)
      .then((content) => {
        this.completeTurn(sessionId, { content });
      })
      .catch((err) => {
        this.failTurn(
          sessionId,
          err instanceof Error ? err.message : String(err),
          'TURN_EXECUTION_FAILED',
        );
      });

    return {
      success: true,
      sessionId,
      turn: session.turns,
      turnId,
      status: 'running',
      async: true,
    };
  }

  /**
   * 执行 turn（带超时 + 后端 failover）
   * - 遍历 backendCandidates，每个最多重试 2 次
   * - 调用 AgentLoopService.run 驱动 AI
   * - 超时则尝试下一个候选后端
   */
  private async _executeTurnWithFailover(
    sessionId: string,
    prompt: string,
    _attachments: unknown[],
    _input: RunTurnInput,
    timeoutMs: number,
    _turnId: string,
    _mode: string,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const candidates = session.backendCandidates.length > 0 ? session.backendCandidates : ['default'];
    const maxRetriesPerBackend = 2;

    let lastError: Error | string = 'All backend candidates failed';
    for (let ci = 0; ci < candidates.length; ci++) {
      for (let retry = 0; retry < maxRetriesPerBackend; retry++) {
        try {
          const content = await this._invokeAgentLoop(sessionId, session, prompt, timeoutMs);
          return content;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.logger.warn('acp-session: Turn execution failed, retrying', {
            sessionId,
            backend: candidates[ci],
            retry,
            error: lastError,
          });
        }
      }
    }
    throw new Error(`All backend candidates failed: ${lastError}`);
  }

  /**
   * 调用 AgentLoopService 驱动 AI 执行
   * - 聚合 assistant_message 事件为完整响应
   * - 超时则拒绝
   */
  private async _invokeAgentLoop(
    sessionId: string,
    session: AcpControlSession,
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const abort = new AbortController();
      const timer = timeoutMs > 0 ? setTimeout(() => {
        abort.abort();
        reject(new Error(`Turn timed out after ${timeoutMs}ms`));
      }, timeoutMs) : undefined;

      (async () => {
        try {
          let content = '';
          const options: { agentId?: string; model?: string; signal?: AbortSignal } = {signal:abort.signal};
          if (session.agentId && session.agentId !== 'main') options.agentId = session.agentId;
          const modelFromOpts = session.runtimeOptions['model'];
          if (typeof modelFromOpts === 'string') options.model = modelFromOpts;

          for await (const ev of this.agentLoop.run(sessionId, prompt, options)) {
            if (ev.type === 'assistant_message') {
              content += ev.content;
            } else if (ev.type === 'error') {
              throw new Error(ev.error);
            } else if (ev.type === 'done') {
              break;
            }
          }
          clearTimeout(timer);
          resolve(content);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      })();
    });
  }

  /**
   * 完成 turn
   * - 更新会话状态为 idle
   * - 累加延迟统计
   * - oneshot 模式自动关闭会话
   */
  completeTurn(sessionId: string, turnResult: { content?: string } = {}): AcpOpResult {
    if (!this.sessions.has(sessionId)) return { success: false, error: 'Session not found' };
    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) return { success: false, error: 'No active turn' };

    const session = this.sessions.get(sessionId)!;
    const turnMs = Date.now() - activeTurn.startedAt;
    session.status = 'idle';
    session.lastActivity = Date.now();

    this.turnLatencyStats.completed++;
    this.turnLatencyStats.totalMs += turnMs;
    if (turnMs > this.turnLatencyStats.maxMs) this.turnLatencyStats.maxMs = turnMs;

    this.activeTurns.delete(sessionId);

    // oneshot 模式：turn 完成后自动关闭会话
    if (activeTurn.mode === 'oneshot') {
      this.closeSession({ sessionId });
    }

    this.events.emit('acp:turn_completed', {
      sessionId,
      turnId: activeTurn.turnId,
      durationMs: turnMs,
      result: turnResult,
    });
    return { success: true, sessionId, turnId: activeTurn.turnId, durationMs: turnMs };
  }

  /**
   * 标记 turn 失败
   * - 更新会话状态为 error
   * - 累加失败统计 + 错误码计数
   */
  failTurn(sessionId: string, error: string, errorCode?: string): AcpOpResult {
    if (!this.sessions.has(sessionId)) return { success: false, error: 'Session not found' };
    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) return { success: false, error: 'No active turn' };

    const session = this.sessions.get(sessionId)!;
    const turnMs = Date.now() - activeTurn.startedAt;
    session.status = 'error';
    session.lastActivity = Date.now();

    this.turnLatencyStats.failed++;
    if (errorCode) {
      this.errorCountsByCode[errorCode] = (this.errorCountsByCode[errorCode] || 0) + 1;
    }
    this.activeTurns.delete(sessionId);

    this.events.emit('acp:turn_failed', {
      sessionId,
      turnId: activeTurn.turnId,
      error,
      errorCode,
    });
    const result: AcpOpResult = { success: false, error, durationMs: turnMs };
    if (errorCode) result.errorCode = errorCode;
    return result;
  }

  /**
   * 关闭会话
   * - 若有活跃 turn，先标记失败
   * - 状态置为 closed
   */
  closeSession(input: { sessionId: string } = { sessionId: '' }): AcpOpResult {
    const sessionId = input.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session not found: ${sessionId || '(none)'}` };

    if (this.activeTurns.has(sessionId)) {
      this.failTurn(sessionId, 'Session closed while turn was active', 'SESSION_CLOSED');
    }
    session.status = 'closed';
    session.lastActivity = Date.now();
    session.closedAt = Date.now();

    this.events.emit('acp:session_closed', session);
    this.logger.info('acp-session: Session closed', { sessionId });
    return { success: true, sessionId };
  }

  /** Reopen retained control-plane state without resetting history or an active turn. */
  resumeSession(sessionId: string): AcpOpResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session not found: ${sessionId}` };
    if (!this.activeTurns.has(sessionId)) {
      session.status = 'idle';
      delete session.closedAt;
      delete session.cancelledAt;
    }
    session.lastActivity = Date.now();
    return { success: true, sessionId };
  }

  /**
   * 取消会话
   * - 若有活跃 turn，先标记失败
   * - 状态置为 cancelled
   */
  cancelSession(sessionId: string): AcpOpResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session not found: ${sessionId || '(none)'}` };

    if (this.activeTurns.has(sessionId)) {
      this.failTurn(sessionId, 'Session cancelled', 'SESSION_CANCELLED');
    }
    session.status = 'cancelled';
    session.lastActivity = Date.now();
    session.cancelledAt = Date.now();

    this.events.emit('acp:session_cancelled', session);
    this.logger.info('acp-session: Session cancelled', { sessionId });
    return { success: true, sessionId };
  }

  /**
   * 恢复会话
   * - 将 closed/cancelled/expired/error 状态恢复为 idle
   * - 重置最后活动时间
   */
  restoreSession(sessionId: string): AcpOpResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session not found: ${sessionId}` };
    session.status = 'idle';
    session.lastActivity = Date.now();
    this.events.emit('acp:session_restored', session);
    return { success: true, sessionId };
  }

  /** 列出全部会话 */
  listSessions(): SessionListItem[] {
    const result: SessionListItem[] = [];
    for (const [key, s] of this.sessions) {
      result.push({
        sessionId: s.sessionId,
        agentId: s.agentId,
        channel: s.channel,
        status: s.status,
        turns: s.turns,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        hasActiveTurn: this.activeTurns.has(key),
      });
    }
    return result;
  }

  /** 获取单个会话（含 hasActiveTurn 标记） */
  getSession(sessionId: string): (AcpControlSession & { hasActiveTurn: boolean }) | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return { ...s, hasActiveTurn: this.activeTurns.has(sessionId) };
  }

  /** 获取延迟统计 */
  getLatencyStats(): LatencyStats {
    const avgMs =
      this.turnLatencyStats.completed > 0
        ? Math.round(this.turnLatencyStats.totalMs / this.turnLatencyStats.completed)
        : 0;
    return {
      completed: this.turnLatencyStats.completed,
      failed: this.turnLatencyStats.failed,
      avgMs,
      maxMs: this.turnLatencyStats.maxMs,
      totalMs: this.turnLatencyStats.totalMs,
      errorCountsByCode: { ...this.errorCountsByCode },
    };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 生成 ID：prefix-timestamp-hex */
  private _generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * 速率限制检查
   * - 窗口内超过 RATE_LIMIT_MAX 则拒绝
   * - 窗口过期则重置
   */
  private _checkRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(key);
    if (!entry) {
      this.rateLimits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry.count = 1;
      entry.windowStart = now;
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  /**
   * 会话级 actor 串行化：同一会话的 turn 依次执行
   * - 通过 Promise 链排队
   */
  private _withSessionActor<T>(sessionId: string, fn: () => T): T | Promise<T> {
    const prev = this.sessionActors.get(sessionId) || Promise.resolve();
    let resolveFn!: () => void;
    const next = new Promise<void>((res) => {
      resolveFn = res;
    });
    this.sessionActors.set(sessionId, prev.then(() => next));
    // 同步执行 fn，但通过 actor 链等待前序完成
    // 注意：原 .cjs 在 runTurn 中同步返回结果，这里保持同步语义
    // fn 是同步函数（_executeTurnSerialized 同步返回 TurnResult，异步部分在内部 void）
    const result = fn();
    // 标记当前 actor 完成
    resolveFn();
    return result;
  }

  /**
   * 过期会话清理
   * - 非 running 会话超过 SESSION_TTL_MS 无活动 → 删除
   * - running 会话超过 RUNNING_SESSION_MAX_MS（24h） → 标记 expired 并删除
   * - 清理过期速率限制条目
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const [key, session] of this.sessions) {
      if (session.lastActivity && now - session.lastActivity > SESSION_TTL_MS) {
        if (session.status !== 'running') {
          expiredKeys.push(key);
        } else if (now - session.lastActivity > RUNNING_SESSION_MAX_MS) {
          // running 会话超过 24 小时无活动，强制过期清理
          session.status = 'expired';
          expiredKeys.push(key);
        }
      }
    }
    for (const sid of expiredKeys) {
      const s = this.sessions.get(sid);
      if (s && s.status === 'running') {
        // running 会话清理前先标记 expired
        s.status = 'expired';
      }
      this.activeTurns.delete(sid);
      this.sessions.delete(sid);
      this.logger.debug('acp-session: Cleaned up expired session', { sessionId: sid });
    }
    // 清理过期速率限制条目
    const staleKeys: string[] = [];
    for (const [rk, entry] of this.rateLimits) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        staleKeys.push(rk);
      }
    }
    for (const k of staleKeys) this.rateLimits.delete(k);
  }
}
