import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  copyFileSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { AgentLoopService } from '../agent/agent-loop.service.js';
import { AcpSessionService } from './acp-session.service.js';
import { AcpMessageRouter } from './acp-message.router.js';
import type { AcpSession, AcpSessionConfig } from '../types.js';

/**
 * AcpService - ACP (Agent Communication Protocol) 管理器门面
 *
 * 全量移植自 packages/web/acp-manager.cjs（1982 行）。
 *
 * 作为 ACP 域的统一入口，聚合以下 10 个子系统：
 *   1. StdioServer      - ACP stdio 服务器（JSON-RPC over stdin/stdout）
 *   2. AcpClient        - ACP 客户端（spawn 子进程与外部 ACP server 通信）
 *   3. EventLedger      - 事件账本（memory / file / sqlite 三后端，会话回放）
 *   4. PermissionRelay  - 权限中继（Gateway exec 审批与 ACP 权限请求互转）
 *   5. Policy           - 策略系统（启用开关 / 允许 agent 列表 / 调度策略）
 *   6. Bindings         - 持久化绑定（sessionKey -> agentId 映射）
 *   7. SessionMapper    - 会话键解析与规范化（agentId:channel:peerId）
 *   8. ApprovalClassifier - 工具审批分类（readonly/exec/mutating/control_plane/other）
 *   9. EventMapper      - Gateway 事件到 ACP SessionUpdate 的映射
 *  10. setAIProvider    - 外部 AI Provider 函数注入点
 *
 * 同时保留与 AcpController 兼容的简化接口：
 *   - createSession(AcpSessionConfig) -> AcpSession
 *   - sendMessage(sessionId, message) -> string（同步聚合 agentLoop 事件）
 *   - cancelSession(sessionId)
 *
 * 控制面 turn 执行委托给 AcpSessionService（已移植自 .cjs ControlPlane）。
 * JSON-RPC 消息路由委托给 AcpMessageRouter（已移植自 .cjs _handleStdioMessage）。
 */

// ─── 常量 ──────────────────────────────────────────────────────────

/** ACP 协议版本 */
const ACP_PROTOCOL_VERSION = '0.1';

/** 会话 TTL（1 小时无活动） */
const SESSION_TTL_MS = 3_600_000;
/** 清理扫描间隔（5 分钟） */
const CLEANUP_INTERVAL_MS = 300_000;
/** 默认 turn 超时（5 分钟） */
const DEFAULT_TURN_TIMEOUT_MS = 0;
/** prompt 最大字节数（2MB） */
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

/** EventLedger：内存后端最大会话数 */
const LEDGER_MAX_SESSIONS = 200;
/** EventLedger：单会话最大事件数 */
const LEDGER_MAX_EVENTS_PER_SESSION = 5000;
/** EventLedger：内存后端最大序列化字节数（16MB） */
const LEDGER_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
/** EventLedger：单事件最大字节数（1MB） */
const LEDGER_MAX_EVENT_BYTES = 1024 * 1024;

/** 文件锁最大重试次数 */
const FILE_LOCK_MAX_RETRIES = 8;
/** 文件锁基础重试延迟（毫秒） */
const FILE_LOCK_BASE_DELAY = 50;
/** 文件锁过期时间（15 秒） */
const FILE_LOCK_STALE_MS = 15_000;

/** AcpClient 请求超时（30 秒） */
const CLIENT_REQUEST_TIMEOUT_MS = 30_000;

/** 默认数据目录名称 */

// ─── 类型定义 ──────────────────────────────────────────────────────

/** StdioServer 运行状态 */
interface StdioServerState {
  rl: ReturnType<typeof createInterface>;
  running: boolean;
  startedAt: number;
  initialized: boolean;
  clientInfo: { name: string; version: string } | null;
  currentSessionId: string | null;
}

/** AcpClient 请求待处理条目 */
interface PendingClientRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** AcpClient 运行状态 */
interface AcpClientState {
  initialized: boolean;
  sessionId: string | null;
  requestId: number;
  pendingRequests: Map<number, PendingClientRequest>;
  eventHandlers: Map<string, Array<(params: unknown) => void>>;
}

/** EventLedger 事件条目 */
interface LedgerEvent {
  sessionId: string;
  type: string;
  data: unknown;
  timestamp: number;
  id?: string | number;
}

/** EventLedger 后端类型 */
type LedgerBackend = 'memory' | 'file' | 'sqlite';

/** EventLedger 回放结果 */
interface ReplayResult {
  sessionId: string;
  complete: boolean;
  events: LedgerEvent[];
}

/** 权限请求条目 */
interface PermissionRequest {
  approvalId: string;
  toolName: string;
  args: unknown;
  classification: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'denied';
  resolvedAt?: number;
}

/** 权限请求选项 */
interface PermissionOption {
  optionId: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once';
  label: string;
}

/** ACP 权限请求载荷 */
interface AcpPermissionPayload {
  type: 'request_permission';
  approvalId: string;
  toolName: string;
  args: unknown;
  classification: string;
  permissionOptions: PermissionOption[];
}

/** 策略配置 */
interface PolicyConfig {
  enabled: boolean;
  allowedAgents: string[];
  dispatchPolicy: 'round-robin' | 'least-load' | 'sticky';
  updatedAt?: number | null;
}

/** 持久化绑定条目 */
interface BindingEntry {
  sessionKey: string;
  agentId: string;
  config: Record<string, unknown>;
  savedAt: number;
}

/** 自定义分类规则 */
interface ClassificationRule {
  id: string;
  pattern: string | null;
  toolName: string | null;
  classification: string;
  addedAt: number;
}

/** 工具分类结果 */
type ToolClassification =
  | 'readonly_scoped'
  | 'readonly_search'
  | 'exec_capable'
  | 'control_plane'
  | 'mutating'
  | 'other';

/** Gateway exec 审批事件解析结果 */
interface ParsedGatewayApproval {
  approvalId: string;
  command: string;
  host: string;
  title: string;
  toolCallId: string;
}

/** AI Provider 函数类型 */
type AIProviderFn = (input: {
  sessionId: string;
  agentId: string;
  prompt: string;
  attachments: unknown[];
  channel: string;
  peerId: string;
  backendCandidate: string;
  runtimeOptions: Record<string, unknown>;
  metadata: Record<string, unknown>;
}) => Promise<unknown> | unknown;

/** 通用操作结果 */
interface OpResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

// ─── 工具分类内置映射表 ────────────────────────────────────────────

const TOOL_CLASSIFICATIONS: Readonly<Record<string, ToolClassification>> = {
  // readonly_scoped
  read_file: 'readonly_scoped',
  list_directory: 'readonly_scoped',
  search_files: 'readonly_scoped',
  get_file_info: 'readonly_scoped',
  read_multiple_files: 'readonly_scoped',
  // readonly_search
  search_code: 'readonly_search',
  grep: 'readonly_search',
  glob: 'readonly_search',
  list_files: 'readonly_search',
  search_web: 'readonly_search',
  web_fetch: 'readonly_search',
  // exec_capable
  execute_command: 'exec_capable',
  run_command: 'exec_capable',
  shell_exec: 'exec_capable',
  bash: 'exec_capable',
  terminal: 'exec_capable',
  // control_plane
  initialize_session: 'control_plane',
  close_session: 'control_plane',
  cancel_session: 'control_plane',
  list_sessions: 'control_plane',
  set_policy: 'control_plane',
  // mutating
  write_file: 'mutating',
  edit_file: 'mutating',
  create_file: 'mutating',
  delete_file: 'mutating',
  move_file: 'mutating',
  install_package: 'mutating',
  git_commit: 'mutating',
  git_push: 'mutating',
};

// ─── 主服务 ────────────────────────────────────────────────────────

@Injectable()
export class AcpService implements OnModuleInit, OnModuleDestroy {
  // ─── 1. StdioServer 状态 ──────────────────────────────────────
  private stdioServer: StdioServerState | null = null;

  // ─── 2. AcpClient 状态 ────────────────────────────────────────
  private clientProcess: ChildProcess | null = null;
  private readonly clientState: AcpClientState = {
    initialized: false,
    sessionId: null,
    requestId: 0,
    pendingRequests: new Map(),
    eventHandlers: new Map(),
  };

  // ─── 3. EventLedger 状态 ──────────────────────────────────────
  private ledgerBackend: LedgerBackend = 'memory';
  private readonly ledgerMemoryStore = new Map<string, LedgerEvent[]>();
  private ledgerFilePath: string | null = null;
  private ledgerLockFile: string | null = null;
  private ledgerDb: unknown = null;
  private ledgerMaxSessions = LEDGER_MAX_SESSIONS;
  private ledgerMaxEventsPerSession = LEDGER_MAX_EVENTS_PER_SESSION;
  private ledgerMaxSerializedBytes = LEDGER_MAX_SERIALIZED_BYTES;

  // ─── 4. PermissionRelay 状态 ──────────────────────────────────
  private readonly pendingPermissions = new Map<string, PermissionRequest>();

  // ─── 5. Policy 状态 ───────────────────────────────────────────
  private policy: PolicyConfig = {
    enabled: false,
    allowedAgents: [],
    dispatchPolicy: 'round-robin',
    updatedAt: null,
  };

  // ─── 6. Bindings 状态 ─────────────────────────────────────────
  private bindings: Record<string, BindingEntry> = {};
  private bindingsFilePath: string | null = null;

  // ─── 8. ApprovalClassifier 状态 ──────────────────────────────
  private customClassificationRules: Record<string, ClassificationRule> = {};

  // ─── 10. AI Provider 注入 ────────────────────────────────────
  private aiProviderFn: AIProviderFn | null = null;

  // ─── 通用状态 ─────────────────────────────────────────────────
  private dataDir: string | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  /** 兼容控制器的会话存储（AcpSession 类型，含 messages 数组） */
  private readonly compatSessions = new Map<string, AcpSession>();

  // ─── ACP 网关扩展状态（对齐旧版 AcpServer / AcpSessionStore） ───
  /** ACP 配置（旧版 acp.json 结构） */
  private acpConfig: {
    enabled: boolean;
    port: number;
    allowedAgents: string[];
    autoApproveReadonly: boolean;
    sessionCreateRateLimit: { maxRequests: number; windowMs: number };
    stream: { coalesceIdleMs: number; maxChunkChars: number; deliveryMode: string };
    maxConcurrentSessions: number;
  } = {
    enabled: false,
    port: 0,
    allowedAgents: [],
    autoApproveReadonly: true,
    sessionCreateRateLimit: { maxRequests: 100, windowMs: 60_000 },
    stream: { coalesceIdleMs: 50, maxChunkChars: 4096, deliveryMode: 'stream' },
    maxConcurrentSessions: 50,
  };
  /** SSE 客户端连接 */
  private readonly acpSseClients = new Set<{ write: (chunk: string) => void }>();
  /** 全局事件队列（对齐旧版 AcpSessionStore._eventQueue） */
  private acpEventQueue: Array<{ cursor: number; type: string; data: unknown; timestamp: number }> = [];
  private acpEventCursor = 0;
  private readonly acpEventWaiters = new Set<(evt: { cursor: number; type: string; data: unknown; timestamp: number } | null) => void>();
  /** 会话创建速率限制计数 */
  private readonly acpRequestCounts = new Map<string, number[]>();

  /** ACP 事件条目 */
  private enqueueAcpEvent(type: string, data: unknown): void {
    this.acpEventCursor++;
    const evt = { cursor: this.acpEventCursor, type, data, timestamp: Date.now() };
    this.acpEventQueue.push(evt);
    while (this.acpEventQueue.length > 1000) this.acpEventQueue.shift();
    this.broadcastSSE({ type, data });
    const waiters = Array.from(this.acpEventWaiters);
    this.acpEventWaiters.clear();
    for (const w of waiters) {
      try {
        w(evt);
      } catch {
        /* ignore */
      }
    }
  }

  /** 轮询 ACP 事件 */
  pollAcpEvents(afterCursor: number, limit = 20): { events: unknown[]; nextCursor: number } {
    const events = this.acpEventQueue.filter((e) => e.cursor > (afterCursor || 0)).slice(0, limit || 20);
    const nextCursor = events.length > 0 ? events[events.length - 1].cursor : afterCursor || 0;
    return { events, nextCursor };
  }

  /** 等待下一个 ACP 事件（带超时，超时返回 null） */
  async waitAcpEvent(afterCursor: number, timeoutMs = 30_000): Promise<{ cursor: number; type: string; data: unknown; timestamp: number } | null> {
    const existing = this.acpEventQueue.find((e) => e.cursor > (afterCursor || 0));
    if (existing) return existing;
    return new Promise((resolve) => {
      const waiter = (evt: { cursor: number; type: string; data: unknown; timestamp: number } | null) => {
        clearTimeout(timer);
        this.acpEventWaiters.delete(waiter);
        resolve(evt);
      };
      const timer = setTimeout(() => {
        this.acpEventWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.acpEventWaiters.add(waiter);
    });
  }

  /** 注册 SSE 客户端 */
  addSSEClient(client: { write: (chunk: string) => void }): void {
    this.acpSseClients.add(client);
  }

  /** 移除 SSE 客户端 */
  removeSSEClient(client: { write: (chunk: string) => void }): void {
    this.acpSseClients.delete(client);
  }

  /** 向全部 SSE 客户端广播 */
  private broadcastSSE(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of Array.from(this.acpSseClients)) {
      try {
        c.write(msg);
      } catch {
        this.acpSseClients.delete(c);
      }
    }
  }

  /** ACP 状态汇总（对齐旧版 AcpServer.getStatus） */
  getStatus(): Record<string, unknown> {
    const sessions = this.listCompatSessions();
    const activeSessions = sessions.filter((s) => s['hasActiveRun'] === true).length;
    return {
      enabled: this.acpConfig.enabled,
      config: { ...this.acpConfig },
      stream: { ...this.acpConfig.stream },
      maxConcurrentSessions: this.acpConfig.maxConcurrentSessions,
      activeSessions,
      totalSessions: sessions.length,
      concurrentAvailable: activeSessions < this.acpConfig.maxConcurrentSessions,
      sseClients: this.acpSseClients.size,
      eventQueueSize: this.acpEventQueue.length,
    };
  }

  /** 更新 ACP 配置（持久化到 dataDir/acp.json） */
  updateConfig(cfg: Record<string, unknown> = {}): Record<string, unknown> {
    for (const key of Object.keys(cfg)) {
      if (key in this.acpConfig) {
        (this.acpConfig as unknown as Record<string, unknown>)[key] = cfg[key];
      }
    }
    if (this.dataDir) {
      this.saveJSON(join(this.dataDir, 'acp.json'), this.acpConfig);
    }
    return { ...this.acpConfig };
  }

  /** 加载 ACP 配置（dataDir/acp.json，init 时调用） */
  private loadAcpConfig(): void {
    if (!this.dataDir) return;
    const loaded = this.loadJSON<typeof this.acpConfig>(join(this.dataDir, 'acp.json'));
    if (loaded && typeof loaded === 'object') {
      this.acpConfig = { ...this.acpConfig, ...loaded };
    }
  }

  /** 会话创建速率限制检查 */
  private checkAcpRateLimit(key: string): boolean {
    const now = Date.now();
    const rl = this.acpConfig.sessionCreateRateLimit;
    const counts = (this.acpRequestCounts.get(key) ?? []).filter((t) => now - t < rl.windowMs);
    if (counts.length >= rl.maxRequests) {
      this.acpRequestCounts.set(key, counts);
      return false;
    }
    counts.push(now);
    this.acpRequestCounts.set(key, counts);
    return true;
  }

  /** 并发会话上限 */
  getMaxConcurrentSessions(): number {
    return this.acpConfig.maxConcurrentSessions || 50;
  }

  /** 活跃（运行中 turn）会话数 */
  getActiveSessionCount(): number {
    return this.listCompatSessions().filter((s) => s['hasActiveRun'] === true).length;
  }

  /** 并发会话是否可用 */
  isConcurrentSessionAvailable(): boolean {
    return this.getActiveSessionCount() < this.getMaxConcurrentSessions();
  }

  /** 工具审批分类（对齐旧版 AcpApprovalClassifier.classify 返回结构） */
  classifyApproval(toolName: string, args?: unknown): { approvalClass: string; autoApprove: boolean } {
    if (!toolName) return { approvalClass: 'unknown', autoApprove: false };
    const cls = this.classify(toolName, args);
    const autoApprove = cls === 'readonly_scoped' || cls === 'readonly_search';
    return { approvalClass: cls, autoApprove };
  }

  /** 兼容会话列表（对齐旧版 AcpSessionStore.list 结构） */
  listCompatSessions(): Array<Record<string, unknown>> {
    return Array.from(this.compatSessions.entries()).map(([id, s]) => ({
      sessionId: id,
      sessionKey: id,
      agentId: s.config.agentId ?? 'main',
      createdAt: s.createdAt,
      lastTouchedAt: s.lastActivityAt,
      hasActiveRun: s.status === 'active' && (this.sessionService.getSession(id)?.hasActiveTurn ?? false),
      messageCount: s.messages.length,
      lastMessageAt: s.messages.length > 0 ? s.messages[s.messages.length - 1].timestamp : null,
      status: s.status,
    }));
  }

  /** 加载会话详情（对齐旧版 AcpSessionStore.load） */
  loadSessionDetail(sessionId: string): Record<string, unknown> | null {
    const s = this.compatSessions.get(sessionId);
    if (!s) return null;
    s.lastActivityAt = Date.now();
    this.enqueueAcpEvent('session_loaded', { sessionId, agentId: s.config.agentId ?? 'main' });
    return {
      sessionId,
      sessionKey: sessionId,
      agentId: s.config.agentId ?? 'main',
      cwd: process.cwd(),
      createdAt: s.createdAt,
      lastTouchedAt: s.lastActivityAt,
      hasActiveRun: false,
      messageCount: s.messages.length,
      lastMessageAt: s.messages.length > 0 ? s.messages[s.messages.length - 1].timestamp : null,
      status: s.status,
    };
  }

  /** 恢复会话（对齐旧版 AcpSessionStore.resume） */
  resumeSessionById(sessionId: string): { success: boolean; error?: string; sessionId?: string; status?: string } {
    const s = this.compatSessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    const resumed = this.sessionService.resumeSession(sessionId);
    if (!resumed.success) return resumed;
    if (s.status === 'active') {
      // 活跃会话直接视为就绪（旧版以 activeRunId 判断，新版以 status 近似）
      s.lastActivityAt = Date.now();
      this.enqueueAcpEvent('session_resumed', { sessionId, agentId: s.config.agentId ?? 'main' });
      return { success: true, sessionId, status: 'ready' };
    }
    s.status = 'active';
    s.lastActivityAt = Date.now();
    this.enqueueAcpEvent('session_resumed', { sessionId, agentId: s.config.agentId ?? 'main' });
    return { success: true, sessionId, status: 'ready' };
  }

  /** 移除兼容会话 */
  removeCompatSession(sessionId: string): boolean {
    const existed = this.compatSessions.delete(sessionId);
    if (existed) {
      this.sessionService.closeSession({ sessionId });
      this.enqueueAcpEvent('session_closed', { sessionId });
    }
    return existed;
  }

  /**
   * ACP 统一请求入口（对齐旧版 AcpServer.handleRequest）。
   * 支持 method：initialize / newSession / prompt / cancel / listSessions /
   * getSession / closeSession / events/poll / events/wait / approvals/classify
   */
  async handleAcpRequest(request: {
    method?: string;
    params?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const method = request.method ?? '';
    const params = request.params ?? {};
    const sessionId = (params['sessionId'] as string) || `acp-${Date.now()}`;

    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '1.0',
          capabilities: {
            streaming: true,
            tools: true,
            sessions: true,
            events: true,
            approval: true,
          },
          serverInfo: { name: 'SkyalyticWing', version: '1.0.0' },
        };
      case 'newSession': {
        if (!this.checkAcpRateLimit('session-create')) {
          return { error: 'Rate limit exceeded for session creation' };
        }
        const config: AcpSessionConfig = { agentId: (params['agentId'] as string) || 'main' };
        const model = params['model'] as string | undefined;
        if (model !== undefined) config.model = model;
        const systemPrompt = params['systemPrompt'] as string | undefined;
        if (systemPrompt !== undefined) config.systemPrompt = systemPrompt;
        const timeoutMs = params['timeoutMs'] as number | undefined;
        if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
        const session = this.createSession(config);
        this.enqueueAcpEvent('session_created', { sessionId: session.id, agentId: session.config.agentId ?? 'main' });
        return { sessionId: session.id, status: 'ready', sessionKey: session.id };
      }
      case 'prompt': {
        const prompt = (params['prompt'] as string) || '';
        let session = this.compatSessions.get(sessionId);
        if (!session) {
          // 以传入的 sessionId 建立兼容会话（对齐旧版 prompt 自动建会话行为）
          const now = Date.now();
          const config: AcpSessionConfig = { agentId: (params['agentId'] as string) || 'main' };
          const model = params['model'] as string | undefined;
          if (model !== undefined) config.model = model;
          session = {
            id: sessionId,
            config,
            messages: [],
            createdAt: now,
            lastActivityAt: now,
            status: 'active',
          };
          this.compatSessions.set(sessionId, session);
          this.sessionService.initializeSession({
            sessionId,
            agentId: config.agentId ?? 'main',
            channel: 'http',
            peerId: '',
            runtimeOptions: {},
            backendCandidates: ['default'],
          });
          this.enqueueAcpEvent('session_created', { sessionId, agentId: config.agentId ?? 'main' });
        }
        const agentId = session.config.agentId ?? 'main';
        const runId = `acp-run-${Date.now()}-${randomBytes(3).toString('hex')}`;
        this.enqueueAcpEvent('prompt_started', { sessionId, runId, agentId });
        try {
          const content = await this.sendMessage(sessionId, prompt);
          this.enqueueAcpEvent('prompt_completed', { sessionId, runId });
          return { sessionId, status: 'completed', runId, content };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.enqueueAcpEvent('prompt_error', { sessionId, runId, error: message });
          return { sessionId, status: 'error', runId, error: message };
        }
      }
      case 'cancel': {
        this.cancelSession(sessionId);
        this.enqueueAcpEvent('run_cancelled', { sessionId });
        return { cancelled: true, sessionId };
      }
      case 'listSessions':
        return { sessions: this.listCompatSessions() };
      case 'getSession': {
        const s = this.compatSessions.get(sessionId);
        if (!s) return { error: 'Session not found' };
        return {
          session: {
            sessionId,
            sessionKey: sessionId,
            agentId: s.config.agentId ?? 'main',
            createdAt: s.createdAt,
            hasActiveRun: s.status === 'active',
            messageCount: s.messages.length,
            status: s.status,
          },
        };
      }
      case 'closeSession': {
        this.removeCompatSession(sessionId);
        return { closed: true };
      }
      case 'events/poll':
        return this.pollAcpEvents((params['afterCursor'] as number) || 0, (params['limit'] as number) || 20) as unknown as Record<string, unknown>;
      case 'events/wait': {
        const evt = await this.waitAcpEvent((params['afterCursor'] as number) || 0, (params['timeoutMs'] as number) || 30_000);
        return { event: evt };
      }
      case 'approvals/classify':
        return {
          classification: this.classifyApproval(
            (params['toolName'] as string) || '',
            params['args'],
          ),
        };
      default:
        return { error: `Unknown method: ${method}` };
    }
  }

  constructor(
    private readonly logger: LoggerService,
    private readonly agentLoop: AgentLoopService,
    private readonly sessionService: AcpSessionService,
    private readonly router: AcpMessageRouter,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.init();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.stopStdioServer();
    this.stopClient();
    this.closeEventLedger();
  }

  /**
   * 初始化 AcpManager（移植自 .cjs _init）。
   * - 解析数据目录
   * - 加载策略与绑定
   * - 启动过期清理定时器
   */
  init(options: { dataDir?: string } = {}): void {
    if (options.dataDir) this.dataDir = options.dataDir;
    this.ensureDataDir();
    this.loadPolicy();
    this.loadBindings();
    this.loadAcpConfig();
    this.startCleanup();
    this.logger.info('acp: AcpManager initialized', { dataDir: this.dataDir });
  }

  // ════════════════════════════════════════════════════════════════
  // 兼容控制器的简化会话接口
  // ════════════════════════════════════════════════════════════════

  /**
   * 创建 ACP 会话（兼容 AcpController）。
   *
   * 同时在 AcpSessionService 中初始化控制面会话，并在本地维护一个
   * AcpSession 包装（含 messages 数组）以兼容旧版 controller 返回类型。
   */
  createSession(config: AcpSessionConfig): AcpSession {
    const now = Date.now();
    const id = this.generateId('session');
    const session: AcpSession = {
      id,
      config: config ?? {},
      messages: [],
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
    };
    this.compatSessions.set(id, session);

    // 同步初始化控制面会话
    const runtimeOptions: Record<string, unknown> = {};
    if (config.model) runtimeOptions['model'] = config.model;
    if (config.timeoutMs) runtimeOptions['timeoutMs'] = config.timeoutMs;
    if (config.systemPrompt) runtimeOptions['systemPrompt'] = config.systemPrompt;

    this.sessionService.initializeSession({
      sessionId: id,
      agentId: config.agentId || 'main',
      channel: 'http',
      peerId: '',
      runtimeOptions,
      backendCandidates: ['default'],
    });

    return session;
  }

  /**
   * 在会话内发送消息，返回助手响应文本（兼容 AcpController）。
   *
   * 同步聚合 AgentLoopService.run 的事件流为完整文本，
   * 同时更新本地 AcpSession.messages 数组。
   */
  async sendMessage(sessionId: string, message: string): Promise<string> {
    const session = this.compatSessions.get(sessionId);
    if (!session) throw new Error(`ACP session '${sessionId}' not found`);
    if (session.status !== 'active') {
      throw new Error(`ACP session '${sessionId}' is ${session.status}`);
    }

    session.messages.push({ role: 'user', content: message, timestamp: Date.now() });
    session.lastActivityAt = Date.now();

    const runOptions: { agentId?: string; model?: string } = {};
    if (session.config.agentId) runOptions.agentId = session.config.agentId;
    if (session.config.model) runOptions.model = session.config.model;

    let assistantText = '';
    for await (const ev of this.agentLoop.run(sessionId, message, runOptions)) {
      if (ev.type === 'assistant_message') {
        assistantText += ev.content;
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      }
    }

    session.messages.push({
      role: 'assistant',
      content: assistantText,
      timestamp: Date.now(),
    });
    session.lastActivityAt = Date.now();
    return assistantText;
  }

  /** 取消会话（兼容 AcpController） */
  cancelSession(sessionId: string): void {
    const session = this.compatSessions.get(sessionId);
    if (session) session.status = 'cancelled';
    this.sessionService.cancelSession(sessionId);
  }

  /** 获取会话（兼容 AcpController） */
  getSession(sessionId: string): AcpSession | undefined {
    return this.compatSessions.get(sessionId);
  }

  // ════════════════════════════════════════════════════════════════
  // 1. StdioServer（ACP stdio 服务器）
  // ════════════════════════════════════════════════════════════════

  /**
   * 启动 stdio ACP 服务器。
   * - 监听 process.stdin 的逐行输入
   * - 解析 JSON-RPC 消息并通过 AcpMessageRouter 路由
   * - 响应写入 process.stdout
   */
  startStdioServer(_options: Record<string, unknown> = {}): OpResult {
    if (this.stdioServer) {
      this.logger.warn('acp: Stdio server already running');
      return { success: false, error: 'Server already running' };
    }
    try {
      const input = process.stdin;
      const rl = createInterface({ input, terminal: false });

      this.stdioServer = {
        rl,
        running: true,
        startedAt: Date.now(),
        initialized: false,
        clientInfo: null,
        currentSessionId: null,
      };

      rl.on('line', (line: string) => {
        try {
          if (!line || !line.trim()) return;
          const msg = JSON.parse(line);
          this.handleStdioMessage(msg);
        } catch (e) {
          this.logger.warn('acp: Stdio parse error', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

      rl.on('close', () => {
        this.logger.info('acp: Stdio input closed');
        this.stdioServer = null;
      });

      this.logger.info('acp: Stdio ACP server started', {
        protocolVersion: ACP_PROTOCOL_VERSION,
      });
      this.startCleanup();
      return { success: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error('acp: Stdio server start error', { error });
      return { success: false, error };
    }
  }

  /** 停止 stdio ACP 服务器 */
  stopStdioServer(): OpResult {
    if (!this.stdioServer) return { success: true };
    try {
      this.stdioServer.rl.close();
      this.stdioServer = null;
      this.logger.info('acp: Stdio server stopped');
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 通过 stdio 发送消息（写入 stdout） */
  private stdioSend(msg: unknown): boolean {
    try {
      const line = JSON.stringify(msg);
      process.stdout.write(line + '\n');
      return true;
    } catch (e) {
      this.logger.warn('acp: Stdio send error', {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * 处理 stdio 收到的 JSON-RPC 消息。
   * 委托给 AcpMessageRouter.route，并将响应通过 stdio 回复。
   */
  private handleStdioMessage(msg: {
    jsonrpc?: string;
    method?: string;
    id?: string | number | null;
    params?: Record<string, unknown> | null;
  }): void {
    const response = this.router.route({
      jsonrpc: msg.jsonrpc ?? '2.0',
      id: msg.id ?? null,
      method: msg.method ?? '',
      params: msg.params ?? {},
    });
    if (response) {
      this.stdioSend(response);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 2. AcpClient（ACP 客户端，spawn 子进程与外部 ACP server 通信）
  // ════════════════════════════════════════════════════════════════

  /**
   * 启动 ACP 客户端。
   * - spawn 子进程作为外部 ACP server
   * - 监听 stdout 逐行解析 JSON-RPC 响应
   * - 可选剥离敏感 provider 认证环境变量
   */
  startClient(options: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stripAuthVars?: boolean;
  } = {}): OpResult {
    if (this.clientProcess) {
      this.logger.warn('acp: Client already running');
      return { success: false, error: 'Client already running' };
    }
    try {
      const command = options.command || 'node';
      const args = options.args || [];

      // 构建环境变量，可选剥离敏感 provider 认证变量
      const envCopy: Record<string, string> = { ...process.env, ...(options.env || {}) } as Record<string, string>;
      if (options.stripAuthVars) {
        const stripKeys = [
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'GOOGLE_API_KEY',
          'AZURE_API_KEY',
        ];
        for (const k of stripKeys) delete envCopy[k];
      }

      this.clientProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: envCopy,
        cwd: options.cwd || process.cwd(),
      });

      const clientRl = createInterface({
        input: this.clientProcess.stdout!,
        terminal: false,
      });

      clientRl.on('line', (line: string) => {
        try {
          if (!line || !line.trim()) return;
          const msg = JSON.parse(line);
          this.handleClientMessage(msg);
        } catch (e) {
          this.logger.warn('acp: Client parse error', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

      this.clientProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.logger.warn('acp: Client stderr', { text: text.substring(0, 200) });
      });

      this.clientProcess.on('close', (code: number | null) => {
        this.logger.info('acp: Client process exited', { code });
        this.clientProcess = null;
        this.clientState.initialized = false;
        this.clientState.sessionId = null;
      });

      this.clientProcess.on('error', (err: Error) => {
        this.logger.error('acp: Client process error', { error: err.message });
        this.clientProcess = null;
      });

      this.logger.info('acp: ACP client started');
      return { success: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error('acp: Client start error', { error });
      return { success: false, error };
    }
  }

  /**
   * 停止 ACP 客户端。
   * 显式关闭子进程 stdin/stdout/stderr 流，避免依赖 GC 导致资源泄漏（M-D9 fix）。
   */
  stopClient(): OpResult {
    if (!this.clientProcess) return { success: true };
    try {
      // 显式关闭子进程流，避免资源泄漏
      try {
        this.clientProcess.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        this.clientProcess.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        this.clientProcess.stderr?.destroy();
      } catch {
        /* ignore */
      }
      this.clientProcess.kill();
      this.clientProcess = null;
      this.clientState.initialized = false;
      this.clientState.sessionId = null;
      this.logger.info('acp: ACP client stopped');
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 向客户端子进程发送消息 */
  private clientSend(msg: unknown): OpResult {
    if (!this.clientProcess || !this.clientProcess.stdin) {
      return { success: false, error: 'Client not running' };
    }
    try {
      const line = JSON.stringify(msg);
      this.clientProcess.stdin.write(line + '\n');
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送客户端请求并等待响应（带超时） */
  private sendClientRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.clientState.requestId;
      const timer = setTimeout(() => {
        this.clientState.pendingRequests.delete(id);
        reject(new Error(`Client request timeout: ${method}`));
      }, CLIENT_REQUEST_TIMEOUT_MS);

      this.clientState.pendingRequests.set(id, {
        resolve: (result: unknown) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      const sent = this.clientSend({ jsonrpc: '2.0', id, method, params });
      if (!sent.success) {
        clearTimeout(timer);
        this.clientState.pendingRequests.delete(id);
        reject(new Error(`Failed to send client request: ${sent.error}`));
      }
    });
  }

  /**
   * 处理客户端子进程返回的消息。
   * - JSON-RPC 响应（含 id）：匹配 pendingRequests 并 resolve
   * - 服务端发起的事件（request_permission / session_update）：派发给事件处理器
   */
  private handleClientMessage(msg: {
    id?: number;
    method?: string;
    result?: unknown;
    params?: Record<string, unknown> & { type?: string };
  }): void {
    // JSON-RPC 响应
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.clientState.pendingRequests.get(msg.id);
      if (pending) {
        pending.resolve(msg.result || msg);
        this.clientState.pendingRequests.delete(msg.id);
        return;
      }
    }

    // 服务端发起的事件
    const params = msg.params || {};
    if (msg.method === 'request_permission' || params.type === 'request_permission') {
      this.events.emit('client_permission_request', params);
      const handlers = this.clientState.eventHandlers.get('permission_request') || [];
      for (const h of handlers) {
        try {
          h(params);
        } catch {
          /* ignore handler errors */
        }
      }
      return;
    }

    if (msg.method === 'session_update' || params.type === 'SessionUpdate') {
      this.events.emit('client_session_update', params);
      const handlers = this.clientState.eventHandlers.get('session_update') || [];
      for (const h of handlers) {
        try {
          h(params);
        } catch {
          /* ignore handler errors */
        }
      }
      return;
    }

    // 通用事件
    this.events.emit('client_message', msg);
  }

  /** ACP 协议握手：initialize */
  async initializeClient(
    clientInfo: { name: string; version: string } = {
      name: 'skyalyticwing-acp-client',
      version: '1.1.1',
    },
  ): Promise<unknown> {
    const result = await this.sendClientRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo,
    });
    this.clientState.initialized = true;
    const serverName = (result as { serverInfo?: { name?: string } })?.serverInfo?.name || 'unknown';
    this.logger.info('acp: ACP handshake completed', { serverName });
    return result;
  }

  /** ACP 协议：创建新会话 */
  async newClientSession(params: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await this.sendClientRequest('new_session', params)) as {
      success?: boolean;
      sessionId?: string;
    };
    if (result?.success && result.sessionId) {
      this.clientState.sessionId = result.sessionId;
    }
    return result;
  }

  /** ACP 协议：发送 prompt */
  async clientPrompt(
    text: string,
    options: {
      mode?: 'prompt' | 'oneshot';
      attachments?: unknown[];
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    return this.sendClientRequest('run_turn', {
      sessionId: this.clientState.sessionId,
      prompt: text,
      mode: options.mode || 'prompt',
      attachments: options.attachments || [],
      timeoutMs: options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });
  }

  /** ACP 协议：响应权限请求 */
  async clientRespondPermission(approvalId: string, decision: boolean): Promise<unknown> {
    return this.sendClientRequest('permission_response', { approvalId, decision });
  }

  /** ACP 协议：关闭会话 */
  async clientCloseSession(): Promise<unknown> {
    return this.sendClientRequest('close_session', {
      sessionId: this.clientState.sessionId,
    });
  }

  /** 注册客户端事件处理器 */
  onClientEvent(event: string, handler: (params: unknown) => void): void {
    if (!this.clientState.eventHandlers.has(event)) {
      this.clientState.eventHandlers.set(event, []);
    }
    this.clientState.eventHandlers.get(event)!.push(handler);
  }

  /** 获取客户端状态 */
  getClientStatus(): { running: boolean; initialized: boolean; sessionId: string | null } {
    return {
      running: !!this.clientProcess,
      initialized: this.clientState.initialized,
      sessionId: this.clientState.sessionId,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 3. EventLedger（事件账本）
  // ════════════════════════════════════════════════════════════════

  /**
   * 初始化 EventLedger 后端。
   * - sqlite：尝试加载 better-sqlite3，失败则降级到 file
   * - file：使用 JSONL 文件追加写入
   * - memory：纯内存存储
   */
  initEventLedger(options: {
    backend?: LedgerBackend;
    dataDir?: string;
    maxSessions?: number;
    maxEventsPerSession?: number;
    maxSerializedBytes?: number;
  } = {}): { backend: LedgerBackend } {
    const backendType = options.backend || 'memory';
    const dir = options.dataDir || this.ensureDataDir();
    if (options.maxSessions) this.ledgerMaxSessions = options.maxSessions;
    if (options.maxEventsPerSession) this.ledgerMaxEventsPerSession = options.maxEventsPerSession;
    if (options.maxSerializedBytes) this.ledgerMaxSerializedBytes = options.maxSerializedBytes;
    this.initLedgerBackend(backendType, dir);
    return { backend: this.ledgerBackend };
  }

  /** 初始化指定后端 */
  private initLedgerBackend(backendType: LedgerBackend, dir: string): void {
    if (backendType === 'sqlite') {
      try {
        // 动态加载 better-sqlite3，失败则降级
        const Database = require('better-sqlite3');
        const dbPath = join(dir, 'acp-ledger.db');
        const db = new Database(dbPath);
        db.exec(
          'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, type TEXT, data TEXT, timestamp INTEGER)',
        );
        db.exec(
          'CREATE TABLE IF NOT EXISTS sessions (sessionId TEXT PRIMARY KEY, status TEXT, agentId TEXT, channel TEXT, startedAt INTEGER, lastActivity INTEGER)',
        );
        db.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionId)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
        this.ledgerDb = db;
        this.ledgerBackend = 'sqlite';
        this.logger.info('acp: Event ledger using SQLite backend');
        return;
      } catch (e) {
        this.logger.warn('acp: SQLite unavailable, falling back to file backend', {
          error: e instanceof Error ? e.message : String(e),
        });
        return this.initLedgerBackend('file', dir);
      }
    }
    if (backendType === 'file') {
      this.ledgerFilePath = join(dir, 'acp-ledger.jsonl');
      this.ledgerLockFile = join(dir, 'acp-ledger.lock');
      try {
        appendFileSync(this.ledgerFilePath, '', 'utf8');
      } catch {
        /* ignore */
      }
      this.ledgerBackend = 'file';
      this.logger.info('acp: Event ledger using file backend', { path: this.ledgerFilePath });
      return;
    }
    this.ledgerBackend = 'memory';
    this.logger.info('acp: Event ledger using memory backend');
  }

  /** 获取文件锁（带重试 + 过期检测） */
  private acquireFileLock(): boolean {
    if (!this.ledgerLockFile) return true;
    for (let i = 0; i < FILE_LOCK_MAX_RETRIES; i++) {
      try {
        if (existsSync(this.ledgerLockFile)) {
          try {
            const lockData = readFileSync(this.ledgerLockFile, 'utf8');
            const parsed = JSON.parse(lockData) as { pid: number; timestamp: number };
            // 过期锁检测（15 秒）
            if (parsed?.pid && parsed?.timestamp) {
              if (Date.now() - parsed.timestamp > FILE_LOCK_STALE_MS) {
                try {
                  unlinkSync(this.ledgerLockFile);
                } catch {
                  /* ignore */
                }
                continue;
              }
              // 检查进程是否存活
              try {
                process.kill(parsed.pid, 0);
              } catch {
                // 进程已死，移除过期锁
                try {
                  unlinkSync(this.ledgerLockFile);
                } catch {
                  /* ignore */
                }
                continue;
              }
            }
          } catch {
            try {
              unlinkSync(this.ledgerLockFile);
            } catch {
              /* ignore */
            }
            continue;
          }
        }
        // 尝试创建锁
        writeFileSync(
          this.ledgerLockFile,
          JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
          'utf8',
        );
        return true;
      } catch {
        if (i < FILE_LOCK_MAX_RETRIES - 1) {
          const delay = FILE_LOCK_BASE_DELAY * Math.pow(2, i);
          const endWait = Date.now() + delay;
          while (Date.now() < endWait) {
            /* busy wait - cross-platform */
          }
        }
      }
    }
    this.logger.warn('acp: Could not acquire file lock', { retries: FILE_LOCK_MAX_RETRIES });
    return false;
  }

  /** 释放文件锁 */
  private releaseFileLock(): void {
    if (!this.ledgerLockFile) return;
    try {
      const lockData = readFileSync(this.ledgerLockFile, 'utf8');
      const parsed = JSON.parse(lockData) as { pid: number };
      if (parsed?.pid === process.pid) {
        unlinkSync(this.ledgerLockFile);
      }
    } catch {
      /* ignore */
    }
  }

  /** 深拷贝（防止外部引用突变） */
  private deepClone<T>(obj: T): T {
    try {
      return JSON.parse(JSON.stringify(obj)) as T;
    } catch {
      return obj;
    }
  }

  /** 规范化并校验事件数据 */
  private normalizeEvent(entry: Partial<LedgerEvent> | null): LedgerEvent | null {
    if (!entry || typeof entry !== 'object') return null;
    if (!entry.sessionId || typeof entry.sessionId !== 'string') return null;
    if (!entry.type || typeof entry.type !== 'string') return null;
    // 大小检查
    try {
      const serialized = JSON.stringify(entry);
      if (serialized.length > LEDGER_MAX_EVENT_BYTES) {
        this.logger.warn('acp: Event too large, truncating data');
        entry.data = { truncated: true, originalSize: serialized.length };
      }
    } catch {
      /* ignore */
    }
    entry.timestamp = entry.timestamp || Date.now();
    return entry as LedgerEvent;
  }

  /** 修剪过期会话与事件 */
  private pruneLedgerSessions(): void {
    if (this.ledgerBackend === 'memory') {
      // 内存后端：按最后事件时间排序，淘汰最旧会话
      const sessionKeys = Array.from(this.ledgerMemoryStore.keys());
      if (sessionKeys.length > this.ledgerMaxSessions) {
        sessionKeys.sort((a, b) => {
          const aEvents = this.ledgerMemoryStore.get(a)!;
          const bEvents = this.ledgerMemoryStore.get(b)!;
          const aLast = aEvents.length > 0 ? aEvents[aEvents.length - 1].timestamp : 0;
          const bLast = bEvents.length > 0 ? bEvents[bEvents.length - 1].timestamp : 0;
          return aLast - bLast;
        });
        while (sessionKeys.length > this.ledgerMaxSessions) {
          const oldest = sessionKeys.shift()!;
          this.ledgerMemoryStore.delete(oldest);
        }
      }
      // 单会话事件数限制
      for (const [key, events] of this.ledgerMemoryStore) {
        if (events.length > this.ledgerMaxEventsPerSession) {
          this.ledgerMemoryStore.set(key, events.slice(-this.ledgerMaxEventsPerSession));
        }
      }
      // 全局字节数修剪
      try {
        let totalBytes = 0;
        for (const [, events] of this.ledgerMemoryStore) {
          totalBytes += JSON.stringify(events).length;
        }
        while (totalBytes > this.ledgerMaxSerializedBytes && this.ledgerMemoryStore.size > 0) {
          let oldestKey: string | null = null;
          let oldestTime = Infinity;
          for (const [k, events] of this.ledgerMemoryStore) {
            if (events.length > 0 && events[0].timestamp < oldestTime) {
              oldestTime = events[0].timestamp;
              oldestKey = k;
            }
          }
          if (oldestKey) {
            const events = this.ledgerMemoryStore.get(oldestKey)!;
            totalBytes -= JSON.stringify(events).length;
            this.ledgerMemoryStore.delete(oldestKey);
          } else {
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (this.ledgerBackend === 'sqlite' && this.ledgerDb) {
      try {
        const db = this.ledgerDb as {
          prepare: (sql: string) => { get: () => { cnt: number } | undefined; run: (...args: unknown[]) => void; all: () => Array<{ sessionId: string }> };
        };
        try {
          const countRow = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
          const excess = Math.max(0, (countRow ? countRow.cnt : 0) - this.ledgerMaxSessions);
          if (excess > 0) {
            db.prepare(
              'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions ORDER BY lastActivity ASC LIMIT ?)',
            ).run(excess);
          }
        } catch {
          /* ignore */
        }
        const sessRows = db.prepare('SELECT DISTINCT sessionId FROM events').all();
        for (const row of sessRows) {
          db.prepare(
            'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE sessionId = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?)',
          ).run(row.sessionId, this.ledgerMaxEventsPerSession);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** 记录事件 */
  private recordLedgerEvent(sessionId: string, type: string, data: unknown): LedgerEvent | null {
    const entry = this.normalizeEvent({
      sessionId,
      type,
      data: this.deepClone(data),
      timestamp: Date.now(),
    });
    if (!entry) {
      this.logger.warn('acp: Invalid event rejected');
      return null;
    }

    if (this.ledgerBackend === 'sqlite' && this.ledgerDb) {
      try {
        const db = this.ledgerDb as {
          prepare: (sql: string) => { run: (...args: unknown[]) => void };
        };
        db.prepare(
          'INSERT INTO events (sessionId, type, data, timestamp) VALUES (?, ?, ?, ?)',
        ).run(sessionId, type, JSON.stringify(entry.data), entry.timestamp);
        db.prepare(
          'INSERT OR REPLACE INTO sessions (sessionId, status, agentId, channel, startedAt, lastActivity) VALUES (?, COALESCE((SELECT status FROM sessions WHERE sessionId = ?), ?), COALESCE((SELECT agentId FROM sessions WHERE sessionId = ?), ?), COALESCE((SELECT channel FROM sessions WHERE sessionId = ?), ?), COALESCE((SELECT startedAt FROM sessions WHERE sessionId = ?), ?), ?)',
        ).run(sessionId, sessionId, 'active', sessionId, '', sessionId, 'stdio', sessionId, Date.now(), Date.now());
        this.pruneLedgerSessions();
        return entry;
      } catch (e) {
        this.logger.warn('acp: SQLite write error, falling back', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (this.ledgerBackend === 'file' && this.ledgerFilePath) {
      this.acquireFileLock();
      try {
        appendFileSync(this.ledgerFilePath, JSON.stringify(entry) + '\n', 'utf8');
        this.pruneLedgerSessions();
        return entry;
      } catch (e) {
        this.logger.warn('acp: File write error', {
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      } finally {
        this.releaseFileLock();
      }
    }

    // 内存后端
    if (!this.ledgerMemoryStore.has(sessionId)) {
      this.ledgerMemoryStore.set(sessionId, []);
    }
    this.ledgerMemoryStore.get(sessionId)!.push(entry);
    this.pruneLedgerSessions();
    return entry;
  }

  /** 读取会话事件 */
  private readLedgerEvents(sessionId: string): LedgerEvent[] {
    if (this.ledgerBackend === 'sqlite' && this.ledgerDb) {
      try {
        const db = this.ledgerDb as {
          prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ sessionId: string; type: string; data: string; timestamp: number }> };
        };
        const rows = db.prepare('SELECT * FROM events WHERE sessionId = ? ORDER BY timestamp ASC').all(sessionId);
        return rows.map((r) => ({
          sessionId: r.sessionId,
          type: r.type,
          data: JSON.parse(r.data),
          timestamp: r.timestamp,
        }));
      } catch (e) {
        this.logger.warn('acp: SQLite read error', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (this.ledgerBackend === 'file' && this.ledgerFilePath) {
      this.acquireFileLock();
      try {
        const content = readFileSync(this.ledgerFilePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        const events: LedgerEvent[] = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as LedgerEvent;
            if (entry.sessionId === sessionId) {
              const normalized = this.normalizeEvent(entry);
              if (normalized) events.push(normalized);
            }
          } catch {
            /* ignore malformed lines */
          }
        }
        return events;
      } catch (e) {
        this.logger.warn('acp: File read error', {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      } finally {
        this.releaseFileLock();
      }
    }

    return (this.ledgerMemoryStore.get(sessionId) || []).map((e) => this.deepClone(e));
  }

  /** 记录会话开始事件 */
  startSessionEvent(sessionId: string): { success: boolean; sessionId: string } {
    this.recordLedgerEvent(sessionId, 'session_start', { sessionId, complete: false });
    return { success: true, sessionId };
  }

  /** 记录用户 prompt（带 2MB 大小限制，CWE-400 防护） */
  recordUserPrompt(sessionId: string, text: string): { success: boolean } {
    let truncated = text;
    if (truncated && typeof truncated === 'string' && Buffer.byteLength(truncated, 'utf8') > MAX_PROMPT_BYTES) {
      truncated = truncated.substring(0, MAX_PROMPT_BYTES) + '... [truncated]';
    }
    this.recordLedgerEvent(sessionId, 'user_prompt', { text: truncated });
    return { success: true };
  }

  /** 记录会话更新事件 */
  recordUpdate(sessionId: string, update: unknown): { success: boolean } {
    this.recordLedgerEvent(sessionId, 'session_update', this.deepClone(update));
    return { success: true };
  }

  /** 标记会话未完成 */
  markIncomplete(sessionId: string): { success: boolean } {
    this.recordLedgerEvent(sessionId, 'session_incomplete', { reason: 'incomplete' });
    return { success: true };
  }

  /**
   * 读取会话回放。
   * - afterCursor：从指定事件 id/timestamp 之后开始
   * - limit：最多返回事件数
   * - complete：根据最后是否为 session_closed / session_incomplete 判断
   */
  readReplay(
    sessionId: string,
    afterCursor?: string | number,
    limit?: number,
  ): ReplayResult {
    const allEvents = this.readLedgerEvents(sessionId);
    let events = allEvents;
    if (afterCursor !== undefined && afterCursor !== null) {
      let cursorIdx = -1;
      for (let i = 0; i < events.length; i++) {
        if (events[i].id === afterCursor || events[i].timestamp === afterCursor) {
          cursorIdx = i;
          break;
        }
      }
      if (cursorIdx >= 0) events = events.slice(cursorIdx + 1);
    }
    if (limit && limit > 0) events = events.slice(0, limit);

    let complete = false;
    for (let i = allEvents.length - 1; i >= 0; i--) {
      if (allEvents[i].type === 'session_closed' || allEvents[i].type === 'session_incomplete') {
        complete = allEvents[i].type === 'session_closed';
        break;
      }
    }
    return { sessionId, complete, events };
  }

  /** 按 sessionId 读取全部事件 */
  readReplayBySessionId(id: string): LedgerEvent[] {
    return this.readLedgerEvents(id);
  }

  /** 按 sessionKey 读取事件（解析 key 后拼接 sessionId） */
  readReplayBySessionKey(key: string): LedgerEvent[] {
    const parsed = this.parseSessionKey(key);
    if (!parsed) return [];
    const sessionId = `${parsed.agentId}:${parsed.channel}:${parsed.peerId}`;
    return this.readLedgerEvents(sessionId);
  }

  /** 获取当前后端类型 */
  getEventLedgerBackend(): LedgerBackend {
    return this.ledgerBackend;
  }

  /** 手动触发修剪 */
  pruneEventLedgerSessions(): { success: boolean } {
    this.pruneLedgerSessions();
    return { success: true };
  }

  /** 关闭 EventLedger（释放资源） */
  closeEventLedger(): void {
    this.releaseFileLock();
    if (this.ledgerDb) {
      try {
        (this.ledgerDb as { close: () => void }).close();
      } catch {
        /* ignore */
      }
      this.ledgerDb = null;
    }
    this.ledgerMemoryStore.clear();
  }

  // ════════════════════════════════════════════════════════════════
  // 4. PermissionRelay（权限中继）
  // ════════════════════════════════════════════════════════════════

  /**
   * 解析 Gateway exec 审批事件。
   * 支持旧格式（phase=requested, kind=exec, status=pending）
   * 和新结构化格式（type=exec_approval_request 或含 approvalId）。
   */
  parseGatewayExecApprovalEvent(eventData: Record<string, unknown> | null): ParsedGatewayApproval | null {
    if (!eventData) return null;
    // 旧格式：phase=requested, kind=exec, status=pending
    if (eventData['phase'] === 'requested' && eventData['kind'] === 'exec' && eventData['status'] === 'pending') {
      return {
        approvalId: (eventData['approvalId'] as string) || (eventData['id'] as string) || '',
        command: (eventData['command'] as string) || '',
        host: (eventData['host'] as string) || '',
        title: (eventData['title'] as string) || '',
        toolCallId: (eventData['toolCallId'] as string) || '',
      };
    }
    // 新结构化格式
    if (eventData['type'] === 'exec_approval_request' || eventData['approvalId']) {
      return {
        approvalId: (eventData['approvalId'] as string) || '',
        command: (eventData['command'] as string) || (eventData['content'] as string) || '',
        host: (eventData['host'] as string) || '',
        title: (eventData['title'] as string) || (eventData['label'] as string) || '',
        toolCallId: (eventData['toolCallId'] as string) || '',
      };
    }
    return null;
  }

  /**
   * 从 Gateway 审批事件构建 ACP 权限请求载荷。
   * - 解析事件 → 提取工具名 → 分类 → 构建权限选项
   * - 反欺诈检查：_meta.toolName 与命令首词不匹配时降级为 'other'
   */
  buildAcpPermissionRequest(gatewayApprovalEvent: Record<string, unknown> | null): AcpPermissionPayload | null {
    const parsed = this.parseGatewayExecApprovalEvent(gatewayApprovalEvent);
    if (!parsed) return null;

    const toolName = parsed.command ? parsed.command.split(/\s+/)[0] : 'unknown';
    let classification = this.classify(toolName, { command: parsed.command });

    // 反欺诈检查
    const metaToolName = (gatewayApprovalEvent?.['_meta'] as { toolName?: string } | undefined)?.toolName;
    if (metaToolName && metaToolName !== toolName) {
      this.logger.warn('acp: toolName mismatch in buildAcpPermissionRequest - potential spoofing, downgrading');
      classification = 'other';
    }

    // 根据分类构建权限选项
    let permissionOptions: PermissionOption[];
    if (classification === 'readonly_scoped' || classification === 'readonly_search') {
      permissionOptions = [
        { optionId: `${parsed.approvalId}_allow_once`, kind: 'allow_once', label: '允许一次' },
        { optionId: `${parsed.approvalId}_allow_always`, kind: 'allow_always', label: '始终允许' },
        { optionId: `${parsed.approvalId}_reject_once`, kind: 'reject_once', label: '拒绝' },
      ];
    } else {
      permissionOptions = [
        { optionId: `${parsed.approvalId}_allow_once`, kind: 'allow_once', label: '允许一次' },
        { optionId: `${parsed.approvalId}_reject_once`, kind: 'reject_once', label: '拒绝' },
      ];
    }

    return {
      type: 'request_permission',
      approvalId: parsed.approvalId,
      toolName,
      args: { command: parsed.command, host: parsed.host, title: parsed.title },
      classification,
      permissionOptions,
    };
  }

  /** 从 ACP 权限结果解析 Gateway 决策 */
  resolveGatewayDecisionFromPermissionOutcome(
    acpOutcome: { decision?: string; kind?: string } | null,
  ): 'allow-once' | 'allow-always' | 'deny' {
    if (!acpOutcome) return 'deny';
    const decision = acpOutcome.decision || acpOutcome.kind || '';
    switch (decision) {
      case 'allow_once':
        return 'allow-once';
      case 'allow_always':
        return 'allow-always';
      case 'reject_once':
        return 'deny';
      default:
        return 'deny';
    }
  }

  /**
   * 中继权限请求。
   * - 生成 approvalId（如未提供）
   * - 分类工具 + 反欺诈校验
   * - 派发 permission_requested 事件
   * - 通过 stdio 转发给客户端（如已连接）
   */
  relayPermissionRequest(
    approvalId: string,
    toolName: string,
    args: Record<string, unknown> & { _meta?: { toolName?: string } },
  ): AcpPermissionPayload {
    approvalId = approvalId || this.generateId('perm');
    let classification = this.classify(toolName, args);

    // 反欺诈：多源交叉校验 toolName
    let validatedToolName = toolName;
    const metaToolName = args?._meta?.toolName;
    if (metaToolName && metaToolName !== toolName) {
      this.logger.warn('acp: toolName mismatch in permission request - potential spoofing detected');
      validatedToolName = metaToolName;
      classification = 'other';
    }

    const request: PermissionRequest = {
      approvalId,
      toolName: validatedToolName,
      args,
      classification,
      timestamp: Date.now(),
      status: 'pending',
    };
    this.pendingPermissions.set(approvalId, request);

    // 根据分类构建权限选项
    let permissionOptions: PermissionOption[];
    if (classification === 'readonly_scoped' || classification === 'readonly_search') {
      permissionOptions = [
        { optionId: `${approvalId}_allow_once`, kind: 'allow_once', label: '允许一次' },
        { optionId: `${approvalId}_allow_always`, kind: 'allow_always', label: '始终允许' },
        { optionId: `${approvalId}_reject_once`, kind: 'reject_once', label: '拒绝' },
      ];
    } else {
      permissionOptions = [
        { optionId: `${approvalId}_allow_once`, kind: 'allow_once', label: '允许一次' },
        { optionId: `${approvalId}_reject_once`, kind: 'reject_once', label: '拒绝' },
      ];
    }

    const acpPayload: AcpPermissionPayload = {
      type: 'request_permission',
      approvalId,
      toolName: validatedToolName,
      args,
      classification,
      permissionOptions,
    };

    this.events.emit('permission_requested', acpPayload);
    this.logger.info('acp: Permission request', {
      approvalId,
      tool: validatedToolName,
      class: classification,
    });

    // 通过 stdio 转发
    this.stdioSend({ method: 'request_permission', params: acpPayload });

    return acpPayload;
  }

  /** 处理权限响应 */
  handlePermissionResponse(
    approvalId: string,
    decision: boolean | string,
  ): OpResult & { result?: unknown } {
    const request = this.pendingPermissions.get(approvalId);
    if (!request) {
      this.logger.warn('acp: Permission response for unknown approval', { approvalId });
      return { success: false, error: `Unknown approval ID: ${approvalId}` };
    }

    request.status = decision ? 'approved' : 'denied';
    request.resolvedAt = Date.now();

    // 映射到 Gateway 决策格式
    let gatewayDecision: 'allow-once' | 'allow-always' | 'deny' = 'deny';
    if (decision === true || decision === 'allow_once') {
      gatewayDecision = 'allow-once';
    } else if (decision === 'allow_always') {
      gatewayDecision = 'allow-always';
    }

    const result = {
      approvalId,
      decision: gatewayDecision,
      toolName: request.toolName,
      classification: request.classification,
    };

    this.events.emit('permission_resolved', result);
    this.pendingPermissions.delete(approvalId);
    this.logger.info('acp: Permission resolved', { approvalId, decision: gatewayDecision });
    return { success: true, result };
  }

  /** 获取所有待处理权限请求 */
  getPendingPermissions(): PermissionRequest[] {
    return Array.from(this.pendingPermissions.values()).map((r) => ({ ...r }));
  }

  // ════════════════════════════════════════════════════════════════
  // 5. Policy（策略系统）
  // ════════════════════════════════════════════════════════════════

  /** 策略是否启用 */
  isPolicyEnabled(): boolean {
    return !!this.policy.enabled;
  }

  /** 检查 agent 是否被允许 */
  isAgentAllowed(agentId: string): boolean {
    if (!this.policy.enabled) return true;
    if (!this.policy.allowedAgents || this.policy.allowedAgents.length === 0) return true;
    return this.policy.allowedAgents.includes(agentId);
  }

  /** 获取当前调度策略 */
  getDispatchPolicy(): PolicyConfig & { updatedAt: number | null } {
    return {
      enabled: this.policy.enabled,
      dispatchPolicy: this.policy.dispatchPolicy,
      allowedAgents: (this.policy.allowedAgents || []).slice(),
      updatedAt: this.policy.updatedAt || null,
    };
  }

  /** 更新策略并持久化 */
  setPolicy(config: Partial<PolicyConfig>): OpResult & { policy?: PolicyConfig } {
    if (config.enabled !== undefined) this.policy.enabled = !!config.enabled;
    if (config.allowedAgents) this.policy.allowedAgents = config.allowedAgents.slice();
    if (config.dispatchPolicy) this.policy.dispatchPolicy = config.dispatchPolicy;
    this.policy.updatedAt = Date.now();

    const policyPath = join(this.ensureDataDir(), 'acp-policy.json');
    this.saveJSON(policyPath, this.policy);
    this.logger.info('acp: Policy updated', {
      enabled: this.policy.enabled,
      dispatch: this.policy.dispatchPolicy,
    });
    return { success: true, policy: this.getDispatchPolicy() };
  }

  /** 从磁盘加载策略 */
  loadPolicy(): void {
    const policyPath = join(this.ensureDataDir(), 'acp-policy.json');
    const loaded = this.loadJSON<PolicyConfig>(policyPath);
    if (loaded) {
      this.policy = { ...this.policy, ...loaded };
      this.logger.info('acp: Policy loaded from disk');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 6. Bindings（持久化绑定）
  // ════════════════════════════════════════════════════════════════

  /** 获取绑定文件路径 */
  private getBindingsFilePath(): string {
    if (!this.bindingsFilePath) {
      this.bindingsFilePath = join(this.ensureDataDir(), 'acp-bindings.json');
    }
    return this.bindingsFilePath;
  }

  /** 持久化绑定到磁盘 */
  private persistBindings(): void {
    this.saveJSON(this.getBindingsFilePath(), this.bindings);
  }

  /** 从磁盘加载绑定 */
  private loadBindings(): void {
    const loaded = this.loadJSON<Record<string, BindingEntry>>(this.getBindingsFilePath());
    if (loaded && typeof loaded === 'object') {
      this.bindings = loaded;
    }
  }

  /** 保存绑定 */
  saveBinding(
    sessionKey: string,
    agentId: string,
    config: Record<string, unknown> = {},
  ): OpResult & { sessionKey?: string } {
    this.bindings[sessionKey] = {
      sessionKey,
      agentId,
      config,
      savedAt: Date.now(),
    };
    this.persistBindings();
    this.logger.info('acp: Binding saved', { sessionKey, agentId });
    return { success: true, sessionKey };
  }

  /** 加载绑定 */
  loadBinding(sessionKey: string): BindingEntry | null {
    if (!this.bindings[sessionKey]) return null;
    return { ...this.bindings[sessionKey] };
  }

  /** 移除绑定 */
  removeBinding(sessionKey: string): OpResult {
    if (!this.bindings[sessionKey]) {
      return { success: false, error: `Binding not found: ${sessionKey}` };
    }
    delete this.bindings[sessionKey];
    this.persistBindings();
    this.logger.info('acp: Binding removed', { sessionKey });
    return { success: true };
  }

  /** 列出所有绑定 */
  listBindings(): BindingEntry[] {
    return Object.values(this.bindings).map((b) => ({ ...b }));
  }

  // ════════════════════════════════════════════════════════════════
  // 7. SessionMapper（会话键解析与规范化）
  // ════════════════════════════════════════════════════════════════

  /**
   * 解析 sessionKey。
   * 格式：agentId:channel:peerId
   * - 3+ 段：agentId, channel, peerId（剩余段以 : 拼接）
   * - 2 段：agentId, channel, peerId=''
   * - 1 段：agentId=key, channel='', peerId=''
   */
  parseSessionKey(key: string): { agentId: string; channel: string; peerId: string } | null {
    if (!key) return null;
    try {
      const parts = key.split(':');
      if (parts.length >= 3) {
        return { agentId: parts[0], channel: parts[1], peerId: parts.slice(2).join(':') };
      }
      if (parts.length === 2) {
        return { agentId: parts[0], channel: parts[1], peerId: '' };
      }
      return { agentId: key, channel: '', peerId: '' };
    } catch {
      return null;
    }
  }

  /** 规范化 sessionKey */
  normalizeKey(key: string): string {
    const parsed = this.parseSessionKey(key);
    if (!parsed) return key;
    return `${parsed.agentId || ''}:${parsed.channel || ''}:${parsed.peerId || ''}`;
  }

  /** 构建主键 */
  buildMainKey(agentId: string, channel: string, peerId: string): string {
    return `${agentId || 'main'}:${channel || 'stdio'}:${peerId || ''}`;
  }

  // ════════════════════════════════════════════════════════════════
  // 8. ApprovalClassifier（工具审批分类）
  // ════════════════════════════════════════════════════════════════

  /**
   * 分类工具。
   * 优先级：自定义规则 > 内置映射 > 启发式匹配
   */
  classify(toolName: string, _args?: unknown): ToolClassification {
    if (!toolName) return 'other';

    // 自定义规则
    for (const ruleId in this.customClassificationRules) {
      const rule = this.customClassificationRules[ruleId];
      try {
        if (rule.pattern && toolName.match(new RegExp(rule.pattern))) {
          return rule.classification as ToolClassification;
        }
        if (rule.toolName && toolName === rule.toolName) {
          return rule.classification as ToolClassification;
        }
      } catch {
        /* ignore regex errors */
      }
    }

    // 内置映射
    if (TOOL_CLASSIFICATIONS[toolName]) {
      return TOOL_CLASSIFICATIONS[toolName];
    }

    // 启发式匹配
    const lower = toolName.toLowerCase();
    if (
      lower.includes('read') ||
      lower.includes('get') ||
      lower.includes('list') ||
      lower.includes('search') ||
      lower.includes('fetch')
    ) {
      if (
        lower.includes('write') ||
        lower.includes('edit') ||
        lower.includes('delete') ||
        lower.includes('create')
      ) {
        return 'mutating';
      }
      return lower.includes('search') || lower.includes('grep') ? 'readonly_search' : 'readonly_scoped';
    }
    if (
      lower.includes('exec') ||
      lower.includes('run') ||
      lower.includes('shell') ||
      lower.includes('bash') ||
      lower.includes('terminal')
    ) {
      return 'exec_capable';
    }
    if (
      lower.includes('write') ||
      lower.includes('edit') ||
      lower.includes('delete') ||
      lower.includes('create') ||
      lower.includes('move') ||
      lower.includes('install') ||
      lower.includes('push') ||
      lower.includes('commit')
    ) {
      return 'mutating';
    }
    if (lower.includes('session') || lower.includes('policy') || lower.includes('cancel')) {
      return 'control_plane';
    }

    return 'other';
  }

  /** 添加自定义分类规则 */
  addClassificationRule(rule: {
    id: string;
    pattern?: string | null;
    toolName?: string | null;
    classification: string;
  }): OpResult & { ruleId?: string } {
    if (!rule || !rule.id || !rule.classification) {
      return { success: false, error: 'Rule must have id and classification' };
    }
    this.customClassificationRules[rule.id] = {
      id: rule.id,
      pattern: rule.pattern || null,
      toolName: rule.toolName || null,
      classification: rule.classification,
      addedAt: Date.now(),
    };
    this.logger.info('acp: Classification rule added', { ruleId: rule.id });
    return { success: true, ruleId: rule.id };
  }

  /** 移除自定义分类规则 */
  removeClassificationRule(ruleId: string): OpResult {
    if (!this.customClassificationRules[ruleId]) {
      return { success: false, error: `Rule not found: ${ruleId}` };
    }
    delete this.customClassificationRules[ruleId];
    this.logger.info('acp: Classification rule removed', { ruleId });
    return { success: true };
  }

  /** 列出自定义规则 */
  listCustomRules(): ClassificationRule[] {
    return Object.values(this.customClassificationRules).map((r) => ({ ...r }));
  }

  // ════════════════════════════════════════════════════════════════
  // 9. EventMapper（Gateway 事件到 ACP SessionUpdate 映射）
  // ════════════════════════════════════════════════════════════════

  /**
   * 将 Gateway 事件映射为 ACP SessionUpdate。
   * 支持：message / tool_call / tool_result / permission_request / error / session_end
   */
  mapEvent(gatewayEvent: {
    type?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  } | null): { type: 'SessionUpdate'; update: Record<string, unknown> } | null {
    if (!gatewayEvent) return null;
    const type = (gatewayEvent.type as string) || '';
    const data = (gatewayEvent.data as Record<string, unknown>) || gatewayEvent;

    switch (type) {
      case 'message':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'agent_message',
            content: (data['content'] as string) || (data['text'] as string) || '',
            role: (data['role'] as string) || 'assistant',
          },
        };
      case 'tool_call':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'tool_call',
            toolName: (data['toolName'] as string) || (data['name'] as string) || '',
            args: data['args'] || data['arguments'] || {},
            classification: this.classify(
              (data['toolName'] as string) || (data['name'] as string) || '',
              data['args'],
            ),
          },
        };
      case 'tool_result':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'tool_result',
            toolName: (data['toolName'] as string) || '',
            result: data['result'] || '',
            isError: !!data['isError'],
          },
        };
      case 'permission_request':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'request_permission',
            approvalId: (data['approvalId'] as string) || '',
            toolName: (data['toolName'] as string) || '',
            classification:
              (data['classification'] as string) ||
              this.classify(data['toolName'] as string, data['args']),
          },
        };
      case 'error':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'error',
            error: (data['error'] as string) || (data['message'] as string) || 'Unknown error',
          },
        };
      case 'session_end':
        return {
          type: 'SessionUpdate',
          update: {
            type: 'session_end',
            reason: (data['reason'] as string) || 'completed',
          },
        };
      default:
        return {
          type: 'SessionUpdate',
          update: {
            type: type || 'unknown',
            data,
          },
        };
    }
  }

  /** 映射会话更新批量 */
  mapSessionUpdate(
    sessionId: string,
    updates: unknown,
  ): {
    type: 'SessionUpdate';
    sessionId: string;
    updates: Record<string, unknown>[];
    timestamp: number;
  } {
    let updateArray: unknown[];
    if (!updates) updateArray = [];
    else if (Array.isArray(updates)) updateArray = updates;
    else updateArray = [updates];

    const mappedUpdates: Record<string, unknown>[] = [];
    for (const u of updateArray) {
      const mapped = this.mapEvent(u as { type?: string; data?: Record<string, unknown> });
      if (mapped) mappedUpdates.push(mapped.update);
    }

    return {
      type: 'SessionUpdate',
      sessionId,
      updates: mappedUpdates,
      timestamp: Date.now(),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 10. setAIProvider（AI Provider 注入）
  // ════════════════════════════════════════════════════════════════

  /**
   * 注入外部 AI Provider 函数。
   * 该函数接收调用上下文（sessionId/prompt/attachments/...），返回 Promise<result>。
   * 注入后 ControlPlane.runTurn 将通过该函数执行 AI 调用，
   * 否则派发 turn_requires_ai 事件等待外部处理。
   */
  setAIProvider(fn: AIProviderFn): OpResult {
    if (typeof fn === 'function') {
      this.aiProviderFn = fn;
      this.logger.info('acp: AI provider function registered');
      return { success: true };
    }
    return { success: false, error: 'Provider must be a function' };
  }

  /** 获取当前注入的 AI Provider 函数（未注入返回 null） */
  getAIProvider(): AIProviderFn | null {
    return this.aiProviderFn;
  }

  // ════════════════════════════════════════════════════════════════
  // 控制面委托方法（转发到 AcpSessionService）
  // ════════════════════════════════════════════════════════════════

  /** 初始化控制面会话（委托） */
  initializeSession(input: Parameters<AcpSessionService['initializeSession']>[0]) {
    const result = this.sessionService.initializeSession(input);
    if (result.success && result.sessionId) {
      const now = Date.now();
      this.compatSessions.set(result.sessionId, {
        id: result.sessionId,
        config: { agentId: input?.agentId || 'main' },
        messages: [], createdAt: now, lastActivityAt: now, status: 'active',
      });
      this.startSessionEvent(result.sessionId);
    }
    return result;
  }

  /** 运行 turn（委托） */
  runTurn(input: Parameters<AcpSessionService['runTurn']>[0]) {
    if (input.prompt) {
      this.recordUserPrompt(input.sessionId, input.prompt);
    }
    return this.sessionService.runTurn(input);
  }

  /** 完成 turn（委托） */
  completeTurn(sessionId: string, turnResult: { content?: string } = {}) {
    const result = this.sessionService.completeTurn(sessionId, turnResult);
    if (result.success) {
      this.recordUpdate(sessionId, {
        type: 'turn_completed',
        turnId: result.turnId,
        durationMs: result.durationMs,
        result: turnResult,
      });
    }
    return result;
  }

  /** 标记 turn 失败（委托） */
  failTurn(sessionId: string, error: string, errorCode?: string) {
    const result = this.sessionService.failTurn(sessionId, error, errorCode);
    if (result.success === false && result.error) {
      this.recordUpdate(sessionId, {
        type: 'turn_failed',
        error,
        errorCode: errorCode || 'UNKNOWN',
      });
    }
    return result;
  }

  /** 关闭会话（委托） */
  closeSession(input: { sessionId: string }) {
    const result = this.sessionService.closeSession(input);
    if (result.success) {
      const session = this.compatSessions.get(input.sessionId);
      if (session) { session.status = 'closed'; session.lastActivityAt = Date.now(); }
      this.recordUpdate(input.sessionId, { type: 'session_closed', closedAt: Date.now() });
    }
    return result;
  }

  /** 列出全部控制面会话（委托） */
  listSessions() {
    return this.sessionService.listSessions();
  }

  /** 获取延迟统计（委托） */
  getLatencyStats() {
    return this.sessionService.getLatencyStats();
  }

  // ════════════════════════════════════════════════════════════════
  // 事件订阅
  // ════════════════════════════════════════════════════════════════

  /** 订阅 ACP 事件 */
  on(event: string, handler: (...args: unknown[]) => void): void {
    this.events.on(event, handler);
  }

  /** 取消订阅 */
  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.events.off(event, handler);
  }

  // ════════════════════════════════════════════════════════════════
  // 内部辅助方法
  // ════════════════════════════════════════════════════════════════

  /** 确保数据目录存在 */
  private ensureDataDir(): string {
    if (!this.dataDir) {
      this.dataDir = getDefaultDataDir();
      mkdirSync(this.dataDir, { recursive: true });
      // Retain settings from older desktop packages without overriding the
      // user's current settings or importing data into an explicit test profile.
      if (!process.env['SKYALYTICWING_DATA_DIR'] && !process.env['SKYALYTICCLAW_DATA_DIR']) {
        const legacyDir = join(process.cwd(), 'data');
        for (const name of ['acp.json', 'acp-policy.json', 'acp-bindings.json']) {
          const legacyFile = join(legacyDir, name);
          const currentFile = join(this.dataDir, name);
          if (existsSync(legacyFile) && !existsSync(currentFile)) {
            try {
              copyFileSync(legacyFile, currentFile, constants.COPYFILE_EXCL);
            } catch {
              this.logger.warn('acp: could not migrate legacy settings', { file: name });
            }
          }
        }
      }
    }
    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch {
      /* ignore */
    }
    return this.dataDir;
  }

  /** 生成 ID：prefix-timestamp-hex */
  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  }

  /** 加载 JSON 文件 */
  private loadJSON<T>(filePath: string): T | null {
    try {
      const dir = dirname(filePath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
      if (!existsSync(filePath)) return null;
      const data = readFileSync(filePath, 'utf8').trim();
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  /** 保存 JSON 文件 */
  private saveJSON(filePath: string, obj: unknown): boolean {
    try {
      const dir = dirname(filePath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
      writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    } catch (e) {
      this.logger.warn('acp: saveJSON error', {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /** 启动过期清理定时器 */
  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** 过期会话清理（委托给 AcpSessionService，同时清理兼容会话） */
  private cleanup(): void {
    const now = Date.now();
    // 清理兼容会话
    for (const [id, session] of this.compatSessions) {
      if (session.status !== 'active') continue;
      const timeout = session.config.timeoutMs || SESSION_TTL_MS;
      if (now - session.lastActivityAt > timeout) {
        session.status = 'expired';
        this.logger.debug('acp: Compat session expired', { sessionId: id });
      }
    }
  }
}
