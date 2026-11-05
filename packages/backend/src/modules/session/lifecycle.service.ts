import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DoomLoopConfig, LifecycleState } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { DoomLoopDetectorService } from './doom-loop-detector.service.js';
import type { DoomLoopResult } from './doom-loop-detector.service.js';

/** 单次生成生命周期内部状态（Doom Loop 检测已委托 DoomLoopDetectorService） */
interface InternalLifecycleState extends LifecycleState {}

// ---------------------------------------------------------------------------
// LifecycleManager 常量（从 start.cjs 第 2320-2350 行移植）
// ---------------------------------------------------------------------------

/** Agent 超时：默认 48 小时，0 = 无超时（用 MAX_TIMER_TIMEOUT_MS） */
const DEFAULT_AGENT_TIMEOUT_MS = 48 * 60 * 60 * 1000;
/** Node.js setTimeout 最大安全值（~24.85 天） */
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;
/** LLM 流空闲超时：默认 120 秒 */
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120 * 1000;
/** 空闲超时断路器：连续 5 次空闲超时后停止重试 */
const MAX_CONSECUTIVE_IDLE_TIMEOUTS = 5;
/** 会话活跃度诊断阈值：2 分钟警告 */
const STUCK_SESSION_WARN_MS = 120 * 1000;
/** 5 分钟最小 abort */
const STALLED_ABORT_MS = 5 * 60 * 1000;
/** abort = max(5min, 3x警告) */
const STALLED_ABORT_MULTIPLIER = 3;
/** 子代理存活检测：2 小时 */
const STALE_SUBAGENT_MS = 2 * 60 * 60 * 1000;
/** 陈旧运行清理间隔：5 分钟 */
const STALE_RUN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** 心跳默认间隔：30 分钟 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/** 活跃运行追踪记录 */
interface ActiveRun {
  runId: string;
  sessionId: string;
  agentId: string;
  startedAt: number;
  lastActivityAt: number;
  status: 'running' | 'done' | 'timeout' | 'error';
  endedAt?: number;
  idleTimeoutCount: number;
  hasProgress: boolean;
  generation: string;
  stale?: boolean;
}

/** 会话活跃度记录 */
interface SessionActivity {
  lastActivityAt: number;
  runId: string;
}

/** 会话诊断结果 */
export interface SessionDiagnosis {
  state: 'idle' | 'running' | 'long_running' | 'stalled' | 'stuck';
  reason: string;
  elapsed?: number;
  shouldAbort?: boolean;
}

/** 心跳诊断回调参数 */
export interface HeartbeatPayload {
  agentId: string;
  timestamp: number;
  diagnostics: SessionDiagnosis;
}

/**
 * LifecycleService - 生成生命周期管理
 *
 * 职责：
 *   - startGeneration/endGeneration：标记会话生成生命周期
 *   - isRunning：检查会话是否在生成中
 *   - Doom Loop 检测委托给 DoomLoopDetectorService
 *     （trackToolCall / clearDoomLoop / checkDoomLoop / getDoomLoopConfig）
 */
@Injectable()
export class LifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly states = new Map<string, InternalLifecycleState>();

  // LifecycleManager 内部状态（从 start.cjs 第 2339-2349 行移植）
  /** 活跃运行追踪：runId → ActiveRun */
  private readonly _activeRuns = new Map<string, ActiveRun>();
  /** 会话活跃度：sessionId → SessionActivity */
  private readonly _sessionActivity = new Map<string, SessionActivity>();
  /** 心跳定时器：agentId → timer */
  private readonly _heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** 心跳回调：agentId → callback */
  private readonly _heartbeatCallbacks = new Map<
    string,
    (payload: HeartbeatPayload) => void
  >();
  /** 当前生命周期 generation UUID */
  private _lifecycleGeneration = randomUUID();
  /** 陈旧运行清理定时器 */
  private _staleRunCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly doomLoopDetector: DoomLoopDetectorService,
  ) {}

  /** 启动陈旧运行清理定时器（每 5 分钟检查一次，对应 start.cjs setInterval） */
  onModuleInit(): void {
    this._staleRunCleanupTimer = setInterval(
      () => this.cleanupStaleRuns(),
      STALE_RUN_CLEANUP_INTERVAL_MS,
    );
  }

  /** 模块销毁时清理所有定时器与运行记录 */
  onModuleDestroy(): void {
    if (this._staleRunCleanupTimer) {
      clearInterval(this._staleRunCleanupTimer);
      this._staleRunCleanupTimer = null;
    }
    this.stopAll();
  }

  /** 开始生成，返回 generationUuid */
  startGeneration(sessionId: string): string {
    const generationUuid = randomUUID();
    this.states.set(sessionId, {
      generationUuid,
      startedAt: Date.now(),
      isRunning: true,
      doomLoopDetected: false,
      consecutiveCalls: 0,
    });
    return generationUuid;
  }

  /** 结束生成 */
  endGeneration(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.isRunning = false;
    }
  }

  /** 检查会话是否在生成中 */
  isRunning(sessionId: string): boolean {
    return this.states.get(sessionId)?.isRunning ?? false;
  }

  /**
   * 检查指定会话当前是否处于 Doom Loop 状态。
   *
   * 实际检测逻辑由 DoomLoopDetectorService 维护（基于工具名 + args 哈希），
   * 此处为保持向后兼容提供委托入口，并同步本服务内部状态。
   */
  checkDoomLoop(sessionId: string): boolean {
    const detected = this.doomLoopDetector.checkDoomLoop(sessionId);
    const state = this.states.get(sessionId);
    if (state) {
      state.doomLoopDetected = detected;
    }
    return detected;
  }

  /** 获取 doom loop 检测配置（委托给 DoomLoopDetectorService） */
  getDoomLoopConfig(): DoomLoopConfig {
    return this.doomLoopDetector.getDoomLoopConfig();
  }

  // ===========================================================================
  // LifecycleManager 完整逻辑（从 start.cjs 第 2320-2644 行移植）
  // ===========================================================================

  /**
   * 解析 Agent 超时毫秒数（从 start.cjs resolveAgentTimeoutMs 移植）。
   *
   * 规则：
   *   - 0 → 无超时（使用 MAX_TIMER_TIMEOUT_MS）
   *   - 负数 → 默认 48 小时
   *   - 正数 → max(值*1000, 1000)
   */
  resolveAgentTimeoutMs(configStore?: { agentTimeoutSeconds?: number }): number {
    const cfgTimeout = configStore?.agentTimeoutSeconds ?? 0;
    if (cfgTimeout === 0) return MAX_TIMER_TIMEOUT_MS;
    if (cfgTimeout < 0) return DEFAULT_AGENT_TIMEOUT_MS;
    return Math.max(cfgTimeout * 1000, 1000);
  }

  /**
   * 解析 LLM 流空闲超时毫秒数（从 start.cjs resolveLlmIdleTimeoutMs 移植）。
   *
   * 本地 provider（ollama / localhost / 127.0.0.1 / .local）禁用空闲看门狗（返回 0）。
   */
  resolveLlmIdleTimeoutMs(providerId: string, model: string): number {
    const modelLower = (model || '').toLowerCase();
    if (
      providerId === 'ollama' ||
      modelLower.indexOf('localhost') >= 0 ||
      modelLower.indexOf('127.0.0.1') >= 0 ||
      modelLower.indexOf('.local') >= 0
    ) {
      return 0; // 本地模型不设空闲超时
    }
    return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  }

  /**
   * 开始一次运行追踪，返回 runId（从 start.cjs startRun 移植）。
   *
   * runId 格式：{sessionId}-{timestamp}-{random8}
   */
  startRun(sessionId: string, agentId?: string): string {
    const runId =
      sessionId + '-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
    this._activeRuns.set(runId, {
      runId,
      sessionId,
      agentId: agentId || 'main',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'running',
      idleTimeoutCount: 0,
      hasProgress: false,
      generation: this._lifecycleGeneration,
    });
    this._sessionActivity.set(sessionId, {
      lastActivityAt: Date.now(),
      runId,
    });
    return runId;
  }

  /** 更新运行活跃度（从 start.cjs updateActivity 移植） */
  updateActivity(runId: string): void {
    const run = this._activeRuns.get(runId);
    if (run) {
      run.lastActivityAt = Date.now();
      run.hasProgress = true;
      run.idleTimeoutCount = 0;
    }
    if (run) {
      const activity = this._sessionActivity.get(run.sessionId);
      if (activity) {
        activity.lastActivityAt = Date.now();
      }
    }
  }

  /**
   * 记录一次空闲超时（从 start.cjs recordIdleTimeout 移植）。
   *
   * @returns 是否达到断路器阈值（连续 MAX_CONSECUTIVE_IDLE_TIMEOUTS 次）
   */
  recordIdleTimeout(runId: string): boolean {
    const run = this._activeRuns.get(runId);
    if (run) {
      run.idleTimeoutCount++;
      run.hasProgress = false;
      return run.idleTimeoutCount >= MAX_CONSECUTIVE_IDLE_TIMEOUTS;
    }
    return false;
  }

  /** 结束运行（从 start.cjs endRun 移植） */
  endRun(runId: string, status?: 'done' | 'timeout' | 'error'): void {
    const run = this._activeRuns.get(runId);
    if (run) {
      run.status = status || 'done';
      run.endedAt = Date.now();
      this._activeRuns.delete(runId);
      const activity = this._sessionActivity.get(run.sessionId);
      if (activity) {
        activity.lastActivityAt = Date.now();
      }
    }
  }

  /** 获取当前 generation UUID（从 start.cjs getGeneration 移植） */
  getGeneration(): string {
    return this._lifecycleGeneration;
  }

  /**
   * 轮换 generation（网关重置时调用，从 start.cjs rotateGeneration 移植）。
   *
   * 生成新 UUID，并将所有运行中的 run 标记为 stale。
   */
  rotateGeneration(): void {
    this._lifecycleGeneration = randomUUID();
    this.logger.info('Lifecycle generation rotated', {
      scope: 'lifecycle',
      generation: this._lifecycleGeneration,
    });
    // 清理陈旧的活跃运行上下文
    for (const [runId, run] of this._activeRuns) {
      if (run.status === 'running') {
        run.stale = true;
        this.logger.warn('Marking run as stale due to generation rotation', {
          scope: 'lifecycle',
          runId,
        });
      }
    }
  }

  /**
   * 断言运行属于当前 generation（从 start.cjs assertCurrentGeneration 移植）。
   *
   * 若 run 属于过期 generation，抛出错误。
   */
  assertCurrentGeneration(runId: string): void {
    const run = this._activeRuns.get(runId);
    if (run && run.generation && run.generation !== this._lifecycleGeneration) {
      throw new Error('Agent run belongs to a stale gateway lifecycle');
    }
  }

  /** 检查 run 是否属于当前 generation（从 start.cjs isCurrentGeneration 移植） */
  isCurrentGeneration(runId: string): boolean {
    const run = this._activeRuns.get(runId);
    if (!run) return false;
    return !run.generation || run.generation === this._lifecycleGeneration;
  }

  /**
   * 追踪一次工具调用并检测 Doom Loop（委托给 DoomLoopDetectorService）。
   *
   * 检测规则：在配置的时间窗口内，若同一工具以相同 args 哈希连续调用达到
   * 阈值次数，判定为 doom loop。
   *
   * @returns 检测结果，包含 detected、count、tool
   */
  trackToolCall(
    sessionId: string,
    toolName: string,
    args: unknown,
  ): DoomLoopResult {
    const result = this.doomLoopDetector.trackToolCall(sessionId, toolName, args);
    const state = this.states.get(sessionId);
    if (state) {
      state.doomLoopDetected = result.detected;
      state.consecutiveCalls = result.count;
    }
    return result;
  }

  /** 清除指定会话的 Doom Loop 追踪（委托给 DoomLoopDetectorService） */
  clearDoomLoop(sessionId: string): void {
    this.doomLoopDetector.clearDoomLoop(sessionId);
    const state = this.states.get(sessionId);
    if (state) {
      state.doomLoopDetected = false;
      state.consecutiveCalls = 0;
    }
  }

  /**
   * 会话活跃度诊断（从 start.cjs diagnoseSession 移植）。
   *
   * 状态判定：
   *   - stalled：运行中但超过 abort 阈值（max(5min, 3x警告)）无进展 → shouldAbort
   *   - long_running：运行中但超过 2 分钟无进展
   *   - running：运行中
   *   - stuck：无活跃运行且超过 2 小时
   *   - idle：无活跃运行
   */
  diagnoseSession(sessionId: string): SessionDiagnosis {
    const activity = this._sessionActivity.get(sessionId);
    if (!activity) return { state: 'idle', reason: 'no activity' };

    const elapsed = Date.now() - activity.lastActivityAt;
    const run = this._activeRuns.get(activity.runId);

    if (run && run.status === 'running') {
      const runElapsed = Date.now() - run.lastActivityAt;
      const abortThreshold = Math.max(
        STALLED_ABORT_MS,
        STUCK_SESSION_WARN_MS * STALLED_ABORT_MULTIPLIER,
      );

      if (runElapsed > abortThreshold) {
        return {
          state: 'stalled',
          reason: 'active work but no recent progress',
          elapsed: runElapsed,
          shouldAbort: true,
        };
      } else if (runElapsed > STUCK_SESSION_WARN_MS) {
        return {
          state: 'long_running',
          reason: 'active run, slow progress',
          elapsed: runElapsed,
        };
      }
      return { state: 'running', reason: 'active run', elapsed: runElapsed };
    }

    if (elapsed > STALE_SUBAGENT_MS) {
      return {
        state: 'stuck',
        reason: 'stale session, no active run',
        elapsed,
      };
    }

    return { state: 'idle', reason: 'no active run', elapsed };
  }

  /** 获取所有活跃会话的诊断（从 start.cjs diagnoseAll 移植） */
  diagnoseAll(): Record<string, SessionDiagnosis> {
    const results: Record<string, SessionDiagnosis> = {};
    for (const sid of this._sessionActivity.keys()) {
      results[sid] = this.diagnoseSession(sid);
    }
    return results;
  }

  /** 当前活跃运行数量（供 /lifecycle/diagnostics 展示） */
  getActiveRunCount(): number {
    let running = 0;
    for (const run of this._activeRuns.values()) {
      if (run.status === 'running') running++;
    }
    return running;
  }

  /** 当前已启动心跳的 agentId 列表（供 /lifecycle/diagnostics 展示） */
  getHeartbeatAgentIds(): string[] {
    return Array.from(this._heartbeatTimers.keys());
  }

  /** LLM 流空闲超时常量（毫秒，供 /lifecycle/diagnostics 展示） */
  getDefaultLlmIdleTimeoutMs(): number {
    return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  }

  /**
   * 启动心跳调度器（7x24 运行，从 start.cjs startHeartbeat 移植）。
   *
   * 规则：
   *   - 默认 30 分钟间隔
   *   - 会话运行中时跳过本次心跳（忙时不打扰）
   *   - 回调参数包含 agentId、timestamp、diagnostics
   */
  startHeartbeat(
    agentId: string,
    intervalMs: number,
    callback: (payload: HeartbeatPayload) => void,
  ): void {
    const key = agentId || 'main';

    // 清除旧的心跳
    this.stopHeartbeat(key);

    const interval = intervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timer = setInterval(() => {
      try {
        const diag = this.diagnoseSession(key);
        if (diag.state === 'running') {
          this.logger.debug('Skipping heartbeat: session is running', {
            scope: 'heartbeat',
            agentId: key,
          });
          return; // 忙时跳过
        }
        callback({ agentId: key, timestamp: Date.now(), diagnostics: diag });
      } catch (e) {
        this.logger.warn('Heartbeat callback error', {
          scope: 'heartbeat',
          agentId: key,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, interval);

    this._heartbeatTimers.set(key, timer);
    this._heartbeatCallbacks.set(key, callback);
    this.logger.info('Heartbeat started', {
      scope: 'heartbeat',
      agentId: key,
      intervalSec: interval / 1000,
    });
  }

  /** 停止指定 agent 的心跳（从 start.cjs stopHeartbeat 移植） */
  stopHeartbeat(agentId: string): void {
    const key = agentId || 'main';
    const timer = this._heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this._heartbeatTimers.delete(key);
      this._heartbeatCallbacks.delete(key);
      this.logger.info('Heartbeat stopped', { scope: 'heartbeat', agentId: key });
    }
  }

  /** 停止所有心跳定时器与运行记录（从 start.cjs stopAll 移植） */
  stopAll(): void {
    for (const timer of this._heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this._heartbeatTimers.clear();
    this._heartbeatCallbacks.clear();
    this._activeRuns.clear();
    this.logger.info('All lifecycle timers stopped', { scope: 'lifecycle' });
  }

  /**
   * 清理陈旧的活跃运行（从 start.cjs 第 2646-2675 行的 setInterval 移植）。
   *
   * 对运行中但超过 abort 阈值无活动的 run 强制结束（status=timeout）。
   * 由 onModuleInit 启动的定时器每 5 分钟调用一次。
   */
  private cleanupStaleRuns(): void {
    const now = Date.now();
    const abortThreshold = Math.max(
      STALLED_ABORT_MS,
      STUCK_SESSION_WARN_MS * STALLED_ABORT_MULTIPLIER,
    );
    for (const [runId, run] of this._activeRuns) {
      if (run.status === 'running') {
        const elapsed = now - run.lastActivityAt;
        if (elapsed > abortThreshold) {
          this.logger.warn('Force-ending stalled run', {
            scope: 'lifecycle',
            runId,
            idleSec: Math.round(elapsed / 1000),
          });
          this.endRun(runId, 'timeout');
        }
      }
    }
  }
}
