import { RunJournal, type RunState } from './run-journal.js';
import { ProgressGuard } from './progress-guard.js';
import { RemoteWorkspaceService } from '../../core/remote-workspace/remote-workspace.service.js';
import type { RemoteWorkspace } from '../../core/remote-workspace/remote-connections.js';
import { compactContext } from './context-compaction.js';
import { ChatControlRegistry } from '../chat/chat-control.registry.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { SkillService } from './skill.service.js';
import { Inject, Injectable, Optional, OnModuleInit } from '@nestjs/common';
import { visualObservation } from './visual-observation.js';
import { TaskVerification, TASK_VERIFY, VERIFICATION_PROMPT } from './task-verification.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { resolveEffectiveWorkspace } from '../../core/config/effective-workspace.util.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { LLMClientService } from '../llm/llm-client.service.js';
import {
  TOOL_EXECUTOR_SERVICE,
  SESSION_SERVICE,
  type ISessionService,
  type IToolExecutorService,
  type LlmMessage,
} from '../types.js';

/**
 * SubAgentSystem (子代理系统) - NestJS TypeScript 重写
 *
 * 移植自 packages/web/start.cjs 第 4674-5366 行的 SubAgentSystem。
 *
 * 核心能力：
 *   - 子代理创建（唯一 ID: sub-<ts>-<rand6>）
 *   - fork 链追踪（_forkChain，禁止 Fork 内嵌套 Fork）
 *   - spawn 深度限制（maxSpawnDepth = 3，超出拒绝创建）
 *   - lane 映射（fork / subagent）
 *   - 权限模式（bubble / isolated）
 *   - 上下文 / 工具继承（fork 默认全部继承）
 *   - 自动销毁（autoDestroy，任务完成后清理工作区）
 *   - 并发限制（maxConcurrent = 5，超出排队等待）
 *   - 蜂群调度（spawnSwarm，并行执行多任务并汇总）
 */

/** 最大并发子代理数 */
const MAX_CONCURRENT = 5;
/** 最大嵌套深度 */
const MAX_SPAWN_DEPTH = 3;
/** 工作区基目录（相对 process.cwd()） */
function dataDir(): string {
  return getDefaultDataDir();
}
function safeParent(id: string): string {
  return /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');
}

/** 子代理任务配置 */
export interface SubAgentTaskConfig {
  maxIterations?: number;
  allowDelegation?: boolean;
  type?: string;
  task?: string;
  prompt?: string;
  model?: string;
  inheritTools?: boolean;
  inheritContext?: boolean;
  permissionMode?: 'bubble' | 'isolated';
  workspace?: string;
  autoDestroy?: boolean;
  systemPrompt?: string;
  tools?: string[] | undefined;
  lane?: string;
}

/** 子代理实体 */
export interface SubAgent {
  remoteWorkspace?: RemoteWorkspace;
  dataRoot?: string;
  memoryIdentity?: string;
  maxIterations?: number;
  allowDelegation?: boolean;
  calls?: number;
  tokens?: number;
  id: string;
  parentId: string;
  type: string;
  lane: string;
  status: 'created' | 'dispatching' | 'running' | 'completed' | 'error' | 'destroyed';
  task: string;
  prompt: string;
  model: string;
  systemPrompt: string;
  tools?: string[] | undefined;
  inheritTools: boolean;
  inheritContext: boolean;
  permissionMode: 'bubble' | 'isolated';
  workspace: string;
  autoDestroy: boolean;
  createdAt: number;
  messages: Array<Record<string, unknown>>;
  result: string | null;
  error: string | null;
  completedAt: number | null;
  destroyedAt: number | null;
  depth: number;
}

/** fork 链条目 */
interface ForkChainEntry {
  parentId: string;
  depth: number;
  systemPrompt: string;
  forkedAt: number;
}

/** executeSync 返回结果 */
export interface SubAgentExecutionResult {
  remoteWorkspace?: RemoteWorkspace;
  calls?: number;
  tokens?: number;
  success: boolean;
  agentId?: string;
  result?: string;
  error?: string;
  status?: string;
}

/** spawnSwarm 返回结果 */
export interface SwarmResult {
  success: boolean;
  totalTasks: number;
  completed: number;
  failed: number;
  results: SubAgentExecutionResult[];
  summary: string;
}

/** 创建子代理结果（可能因深度限制失败） */
export type CreateSubAgentResult = SubAgent | { id: null; error: string };

/** createFork 结果 */
export type CreateForkResult = SubAgent | { error: string };

/** dispatchTask 结果 */
export interface DispatchResult {
  success: boolean;
  agentId?: string;
  mode?: string;
  error?: string;
}

@Injectable()
export class AgentSwarmService implements OnModuleInit {
  private historyFile = '';
  private stopListening?: () => void;
  private readonly history = new Map<
    string,
    SubAgent & { recovery?: 'interrupted'; retryOf?: string }
  >();
  /** 活跃/全部子代理存储：agentId -> SubAgent */
  private readonly activeAgents = new Map<string, SubAgent>();
  /** 最大并发数 */
  readonly maxConcurrent = MAX_CONCURRENT;
  /** 最大嵌套深度 */
  readonly maxSpawnDepth = MAX_SPAWN_DEPTH;
  /** 当前正在运行的子代理数 */
  private _runningCount = 0;
  private readonly executions = new Map<string, Promise<SubAgentExecutionResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly liveContexts = new Map<string, LlmMessage[]>();
  private readonly queue: Array<{
    id: string;
    resolve: (result: SubAgentExecutionResult) => void;
  }> = [];
  /** fork 链：forkAgentId -> 条目 */
  private readonly _forkChain = new Map<string, ForkChainEntry>();
  /** lane 映射：agentId -> 'fork' | 'subagent' */
  private readonly _laneMap = new Map<string, 'fork' | 'subagent'>();

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly llm: LLMClientService,
    @Optional() @Inject(TOOL_EXECUTOR_SERVICE) private readonly toolExecutor?: IToolExecutorService,
    @Optional() private readonly skills?: SkillService,
    @Optional() private readonly memoryPolicy?: LocalResourcePolicy,
    @Optional() @Inject(SESSION_SERVICE) private readonly sessions?: ISessionService,
    @Optional() private readonly remote?: RemoteWorkspaceService,
  ) {}

  onModuleInit(): void {
    this.stopListening?.();
    this.stopListening = ChatControlRegistry.onAbort((sessionId) => {
      for (const agent of [...this.activeAgents.values()]) {
        if (this.owns(agent) && (!sessionId || agent.parentId === sessionId))
          this.destroyAgent(agent.id);
      }
    });
    this.historyFile = join(dataDir(), 'expert-runs.json');
    const saved = readJsonRecover<Array<SubAgent & { recovery?: 'interrupted'; retryOf?: string }>>(
      this.historyFile,
      [],
    );
    if (!Array.isArray(saved)) throw new Error('专家运行记录损坏');
    for (const run of saved) {
      if (['created', 'dispatching', 'running'].includes(run.status)) run.recovery = 'interrupted';
      this.history.set(run.id, run);
    }
    this.saveHistory();
  }
  onModuleDestroy(): void {
    this.stopListening?.();
    const interrupted = [...this.activeAgents.values()]
      .filter((a) => ['created', 'dispatching', 'running'].includes(a.status))
      .map((a) => structuredClone(a));
    for (const agent of [...this.activeAgents.values()]) this.destroyAgent(agent.id, true);
    for (const agent of interrupted)
      this.history.set(agent.id, { ...agent, recovery: 'interrupted' });
    this.saveHistory();
  }
  private saveHistory(): void {
    if (this.historyFile) writeJsonAtomicSync(this.historyFile, [...this.history.values()]);
  }
  private checkpoint(agent: SubAgent): void {
    if (!this.historyFile) return;
    this.history.set(agent.id, { ...this.history.get(agent.id), ...structuredClone(agent) });
    // Bound terminal history; never evict an interrupted or active task.
    const terminal = [...this.history.values()].filter(
      (r) => !r.recovery && ['completed', 'error', 'destroyed'].includes(r.status),
    );
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 500)))
      this.history.delete(old.id);
    this.saveHistory();
  }
  private owns(agent: SubAgent): boolean {
    return (
      !this.memoryPolicy ||
      (agent.memoryIdentity ?? 'local') === this.memoryPolicy.credentialIdentity()
    );
  }
  listHistory() {
    return structuredClone(
      [...this.history.values()]
        .filter((a) => this.owns(a))
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }
  retryInterrupted(id: string, confirmReplay: boolean): SubAgentExecutionResult {
    const old = this.history.get(id);
    if (!old || old.recovery !== 'interrupted')
      return { success: false, error: '没有可恢复的中断任务' };
    if (!this.owns(old)) return { success: false, error: '请切回任务所属账号或企业身份后恢复' };
    if (old.parentId.startsWith('workflow-'))
      return { success: false, error: '请在工作流运行记录中恢复该步骤，避免重复执行' };
    if (!confirmReplay)
      return { success: false, error: '请检查已有产物，并确认重试可能已执行的外部操作' };
    const workspace = old.remoteWorkspace
      ? old.remoteWorkspace.worktree
        ? 'isolated'
        : 'shared'
      : old.workspace;
    const created = this.createSubAgent(old.parentId, { ...old, workspace, autoDestroy: false });
    if (!('parentId' in created)) return { success: false, error: created.error || '创建失败' };
    delete old.recovery;
    old.status = 'destroyed';
    old.destroyedAt = Date.now();
    this.history.set(created.id, { ...created, retryOf: id });
    this.saveHistory();
    this.executeAsync(created.id);
    return { success: true, agentId: created.id };
  }

  /**
   * 创建子代理
   * - 生成唯一 ID
   * - 校验嵌套深度（>= maxSpawnDepth 拒绝）
   * - fork 类型：lane=fork，继承工具/上下文，权限 bubble
   * - 其他类型：lane=subagent（可定制），权限 isolated
   */
  createSubAgent(parentAgentId: string, taskConfig: SubAgentTaskConfig): CreateSubAgentResult {
    const parent = this.activeAgents.get(parentAgentId);
    if (parent && !this.owns(parent)) return { id: null, error: '父任务属于其他账号或企业身份' };
    const remote = this.remote?.binding(parentAgentId);
    if (
      remote &&
      taskConfig.workspace &&
      !['shared', 'isolated', remote.root].includes(taskConfig.workspace)
    ) {
      return { id: null, error: 'Remote child must use the connected workspace' };
    }
    const agentId = `sub-${Date.now()}-${randomBytes(3).toString('hex').slice(0, 6)}`;
    const parentDepth = this._getDepth(parentAgentId);
    if (parentDepth >= this.maxSpawnDepth) {
      return {
        id: null,
        error: `嵌套深度已达上限(${this.maxSpawnDepth})，无法继续创建子代理`,
      };
    }

    const isFork = taskConfig.type === 'fork';
    const agent: SubAgent = {
      dataRoot: this.memoryPolicy?.localMemoryRoot(dataDir()) || dataDir(),
      ...(this.memoryPolicy ? { memoryIdentity: this.memoryPolicy.credentialIdentity() } : {}),
      ...(Number.isInteger(taskConfig.maxIterations)
        ? { maxIterations: Math.max(1, taskConfig.maxIterations!) }
        : {}),
      allowDelegation: taskConfig.allowDelegation !== false,
      calls: 0,
      tokens: 0,
      id: agentId,
      parentId: parentAgentId,
      type: taskConfig.type || 'worker',
      lane: isFork ? 'fork' : taskConfig.lane || 'subagent',
      status: 'created',
      task: taskConfig.task || '',
      prompt: taskConfig.prompt || '',
      model: taskConfig.model || (isFork ? 'inherit' : ''),
      systemPrompt: taskConfig.systemPrompt || '',
      tools: taskConfig.tools,
      inheritTools: isFork ? true : taskConfig.inheritTools || false,
      inheritContext: isFork ? true : taskConfig.inheritContext || false,
      permissionMode: isFork ? 'bubble' : taskConfig.permissionMode || 'isolated',
      workspace: taskConfig.workspace || 'isolated',
      autoDestroy: taskConfig.autoDestroy !== false,
      createdAt: Date.now(),
      messages: [],
      result: null,
      error: null,
      completedAt: null,
      destroyedAt: null,
      depth: parentDepth + 1,
    };

    if (isFork) {
      this._forkChain.set(agentId, {
        parentId: parentAgentId,
        depth: agent.depth,
        systemPrompt: taskConfig.systemPrompt || '',
        forkedAt: Date.now(),
      });
    }
    this._laneMap.set(agentId, agent.lane as 'fork' | 'subagent');
    this.activeAgents.set(agentId, agent);
    this.remote?.inherit(
      parentAgentId,
      agentId,
      remote && (agent.workspace === 'shared' || agent.workspace === remote.root)
        ? 'shared'
        : 'isolated',
    );
    this._ensureSubWorkspace(agentId, parentAgentId);
    this._writeTaskDoc(agentId, taskConfig);
    this.checkpoint(agent);

    this.logger.info('subagent: Created sub-agent', {
      agentId,
      type: agent.type,
      lane: agent.lane,
      depth: agent.depth,
      task: (agent.task || '').substring(0, 80),
    });
    return agent;
  }

  /**
   * 计算代理的嵌套深度（沿 parentId 向上遍历，使用 visited 防环）
   */
  private _getDepth(agentId: string): number {
    let depth = 0;
    let current = agentId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const agent = this.activeAgents.get(current);
      if (!agent) break;
      depth++;
      current = agent.parentId;
    }
    return depth;
  }

  /**
   * 创建 Fork（并行子任务）
   * - 父会话必须存在（此处以父代理 ID 校验）
   * - Fork 不能在 Fork 内嵌套创建
   * - 继承父会话最近 20 条消息
   */
  createFork(parentSessionId: string, forkConfig: SubAgentTaskConfig): CreateForkResult {
    const parentSession = this.activeAgents.get(parentSessionId);
    if (parentSession && !this.owns(parentSession))
      return { error: '父任务属于其他账号或企业身份' };
    const conversation = parentSession ? undefined : this.sessions?.getSession(parentSessionId);
    // 父会话不存在时仍允许创建（与 .cjs 行为对齐：sessionsStore 校验放宽）
    const forkId = this._detectForkChain(parentSessionId);
    if (forkId) return { error: 'Fork不能在Fork内嵌套创建' };

    const taskConfig: SubAgentTaskConfig = {
      ...forkConfig,
      type: 'fork',
      task: forkConfig.task || '并行子任务',
      prompt: forkConfig.prompt || '',
      model: forkConfig.model || parentSession?.model || conversation?.model || 'inherit',
      inheritTools: true,
      inheritContext: true,
      permissionMode: 'bubble',
      systemPrompt: forkConfig.systemPrompt || '',
      workspace: this.remote?.binding(parentSessionId)
        ? forkConfig.workspace || 'isolated'
        : parentSession?.workspace === 'isolated'
          ? join(
              parentSession.dataRoot || dataDir(),
              'workspaces',
              safeParent(parentSession.parentId),
              'subagents',
              parentSession.id,
            )
          : parentSession?.workspace || resolveEffectiveWorkspace(parentSessionId),
      tools: parentSession
        ? parentSession.tools || (parentSession.inheritTools ? undefined : [])
        : forkConfig.tools,
      allowDelegation:
        parentSession?.allowDelegation !== false && forkConfig.allowDelegation !== false,
    };
    const agent = this.createSubAgent(parentSessionId, taskConfig);
    if (agent.id === null) return { error: agent.error };

    const source =
      this.liveContexts.get(parentSessionId) ||
      parentSession?.messages ||
      (conversation
        ? this.sessions?.getContextMessages?.(parentSessionId) || conversation.messages
        : []);
    if (source.length) {
      const inheritedMsgs = source
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20);
      const target = this.activeAgents.get(agent.id);
      if (target) {
        target.messages = inheritedMsgs.map((m) => ({
          role: (m as { role?: string }).role || 'user',
          content: (m as { content?: string }).content || '',
        }));
        this.checkpoint(target);
      }
    }
    return agent;
  }

  /**
   * 检测指定会话是否已存在 Fork（禁止嵌套）
   */
  private _detectForkChain(sessionId: string): string | null {
    const visited = new Set<string>();
    let current = sessionId;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (this._forkChain.has(current)) return current;
      current = this.activeAgents.get(current)?.parentId || '';
    }
    return null;
  }

  /**
   * 确保子代理工作区目录存在，并初始化 TASK.md / RESULT.md
   */
  private _ensureSubWorkspace(subAgentId: string, parentAgentId: string): void {
    const subWsDir = join(
      this.activeAgents.get(subAgentId)?.dataRoot || dataDir(),
      'workspaces',
      safeParent(parentAgentId),
      'subagents',
      subAgentId,
    );
    try {
      if (!existsSync(subWsDir)) mkdirSync(subWsDir, { recursive: true });
      const taskFile = join(subWsDir, 'TASK.md');
      if (!existsSync(taskFile)) {
        writeFileSync(taskFile, '# Task\n\nWaiting for task assignment...\n');
      }
      const resultFile = join(subWsDir, 'RESULT.md');
      if (!existsSync(resultFile)) {
        writeFileSync(resultFile, '# Result\n\nPending...\n');
      }
    } catch (e) {
      this.logger.warn('subagent: Failed to ensure sub workspace', {
        subAgentId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 写入任务文档 TASK.md（含类型/状态/指令/规则）
   */
  private _writeTaskDoc(subAgentId: string, taskConfig: SubAgentTaskConfig): void {
    const agent = this.activeAgents.get(subAgentId);
    if (!agent) return;
    const subWsDir = join(
      agent.dataRoot || dataDir(),
      'workspaces',
      safeParent(agent.parentId),
      'subagents',
      subAgentId,
    );
    let taskMd = `# Task: ${taskConfig.task || 'Untitled'}\n\n`;
    taskMd += `- **Type**: ${taskConfig.type || 'worker'}\n`;
    taskMd += `- **Created**: ${new Date().toISOString()}\n`;
    taskMd += `- **Status**: pending\n\n`;
    taskMd += `## Instructions\n\n${taskConfig.prompt || taskConfig.task || 'No instructions provided.'}\n\n`;
    taskMd += '## Rules\n\n';
    taskMd += '1. Stay focused - only do the assigned task\n';
    taskMd += '2. Complete the task - your result will be reported to the parent agent\n';
    taskMd += '3. Be ephemeral - you will be terminated after task completion\n';
    try {
      if (existsSync(subWsDir)) writeFileSync(join(subWsDir, 'TASK.md'), taskMd);
    } catch {
      // 忽略写入失败
    }
  }

  /**
   * 写入结果文档 RESULT.md，并追加到父工作区的 SUBAGENT_RESULTS.md
   */
  private _writeResultDoc(subAgentId: string, result: string): void {
    const agent = this.activeAgents.get(subAgentId);
    if (!agent) return;
    const subWsDir = join(
      agent.dataRoot || dataDir(),
      'workspaces',
      safeParent(agent.parentId),
      'subagents',
      subAgentId,
    );
    let resultMd = `# Result: ${agent.task || 'Untitled'}\n\n`;
    resultMd += `- **Status**: ${agent.error ? 'error' : 'completed'}\n`;
    resultMd += `- **Completed**: ${new Date().toISOString()}\n\n`;
    resultMd += `## Output\n\n${result || agent.error || 'No result'}\n`;
    try {
      if (existsSync(subWsDir)) writeFileSync(join(subWsDir, 'RESULT.md'), resultMd);
    } catch {
      // 忽略
    }
    const parentResultDir = join(
      agent.dataRoot || dataDir(),
      'workspaces',
      safeParent(agent.parentId),
    );
    if (existsSync(parentResultDir)) {
      const resultsFile = join(parentResultDir, 'SUBAGENT_RESULTS.md');
      let existing = '';
      try {
        existing = readFileSync(resultsFile, 'utf8');
      } catch {
        // 首次创建
      }
      const entry =
        `\n## [${subAgentId}] ${(agent.task || '').substring(0, 60)} (${agent.error ? 'ERROR' : 'OK'})\n\n` +
        `${result || agent.error || 'No result'}\n\n---\n`;
      try {
        writeFileSync(resultsFile, existing + entry);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 销毁子代理工作区目录
   */
  private _destroySubWorkspace(subAgentId: string, parentAgentId: string): void {
    const subWsDir = join(
      this.activeAgents.get(subAgentId)?.dataRoot || dataDir(),
      'workspaces',
      safeParent(parentAgentId),
      'subagents',
      subAgentId,
    );
    try {
      if (existsSync(subWsDir)) rmSync(subWsDir, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn('subagent: Failed to destroy workspace', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 分发任务到子代理
   * - 后台模式：executeAsync（受并发限制排队）
   * - 前台模式：executeSync（直接执行并返回结果）
   */
  dispatchTask(agentId: string, task: string, runInBackground = false): DispatchResult {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return { success: false, error: `Agent not found: ${agentId}` };
    if (!this.owns(agent)) return { success: false, error: '任务属于其他账号或企业身份' };
    if (agent.status !== 'created' || this.executions.has(agentId))
      return { success: false, error: '任务已分发或结束，请创建新任务' };
    agent.status = 'dispatching';
    agent.task = task || agent.task;
    this._writeTaskDoc(agentId, { task: agent.task, prompt: agent.prompt, type: agent.type });

    if (runInBackground) {
      void this.executeAsync(agentId);
      return { success: true, agentId, mode: 'background' };
    }
    // 前台模式由调用方 await
    void this.executeSync(agentId).then((r) => {
      this.logger.debug('subagent: dispatchTask sync completed', {
        agentId,
        success: r.success,
      });
    });
    return { success: true, agentId, mode: 'sync' };
  }

  /**
   * 同步执行子代理任务
   * - 构建 system prompt（子代理规则 + 任务类型 + 任务内容）
   * - 调用 LLM 进行多轮迭代，支持显式预算和工具调用
   * - 完成后写入结果文档，按 autoDestroy 决定是否销毁
   */
  executeSync(agentId: string): Promise<SubAgentExecutionResult> {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return Promise.resolve({ success: false, agentId, error: 'Agent not found' });
    if (!this.owns(agent))
      return Promise.resolve({ success: false, agentId, error: '任务属于其他账号或企业身份' });
    const existing = this.executions.get(agentId);
    if (existing) return existing;
    if (agent.status === 'completed' || agent.status === 'error') {
      return Promise.resolve({
        success: agent.status === 'completed',
        agentId,
        ...(agent.result ? { result: agent.result } : {}),
        ...(agent.error ? { error: agent.error } : {}),
        status: agent.status,
      });
    }
    agent.status = 'dispatching';
    let resolve!: (result: SubAgentExecutionResult) => void;
    const promise = new Promise<SubAgentExecutionResult>((done) => {
      resolve = done;
    });
    this.executions.set(agentId, promise);
    this.queue.push({ id: agentId, resolve });
    this.drainQueue();
    return promise;
  }

  private drainQueue(): void {
    while (this._runningCount < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!;
      this._runningCount++;
      void this.runAgent(job.id)
        .catch((error: unknown) => ({
          success: false,
          agentId: job.id,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          this._runningCount--;
          this.executions.delete(job.id);
          job.resolve(result);
          this.drainQueue();
        });
    }
  }

  private assertActive(agent: SubAgent): void {
    this.remote?.binding(agent.id);
    if (!this.owns(agent)) throw new Error('子任务所属账号或企业身份已切换，请切回原身份');
    if (this.activeAgents.get(agent.id) !== agent || agent.status === 'destroyed')
      throw new Error('子代理已终止');
  }

  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('子代理已终止'));
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  private async runAgent(agentId: string): Promise<SubAgentExecutionResult> {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      this.logger.error('subagent: executeSync: Agent not found', { agentId });
      return { success: false, error: `Agent not found: ${agentId}` };
    }
    agent.status = 'running';
    let journal: RunJournal | undefined;
    let journalState: RunState = 'failed';
    const controller = new AbortController();
    this.controllers.set(agentId, controller);
    this.logger.info('subagent: Executing sync', {
      agentId,
      parentId: agent.parentId,
      task: (agent.task || '').substring(0, 60),
    });

    try {
      if (this.remote?.hasChild(agentId)) {
        const prepared = await this.remote.prepareChild(agentId);
        if (prepared) {
          agent.workspace = prepared.root;
          agent.remoteWorkspace = prepared;
        }
      }
      this.assertActive(agent);
      this.checkpoint(agent);
      journal = new RunJournal(
        agent.memoryIdentity ?? 'local',
        agent.parentId,
        agent.task || agent.prompt,
      );
      journal.append('subagent', { agentId });
      const model =
        !agent.model || agent.model === 'inherit' ? this.llm.getDefaultModel() : agent.model;

      let systemPrompt = '你是一个子代理(Sub-Agent)，负责完成父代理分配的任务。\n\n';
      systemPrompt +=
        '## 规则\n1. 只做被分配的任务，不要偏离\n2. 完成后给出简洁的结果总结\n3. 你是临时的，完成后会被终止\n4. 如果需要使用工具，直接调用\n\n';
      systemPrompt += `## 任务类型: ${agent.type}\n`;
      systemPrompt += `## 任务: ${agent.task || ''}\n`;
      if (agent.systemPrompt) systemPrompt += `\n## 专家角色设定\n${agent.systemPrompt}\n`;
      const remote = this.remote?.binding(agent.id);
      if (remote)
        systemPrompt +=
          '\nRemote POSIX workspace: ' +
          remote.target +
          ':' +
          remote.root +
          '. File tools and bash run remotely; no local fallback.\n';

      const initialPrompt = agent.prompt || agent.task || '请完成任务';
      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(agent.inheritContext
          ? agent.messages.map((m) => ({
              role: m['role'] === 'assistant' ? ('assistant' as const) : ('user' as const),
              content:
                typeof m['content'] === 'string'
                  ? m['content']
                  : JSON.stringify(m['content'] || ''),
            }))
          : []),
        { role: 'user', content: initialPrompt },
      ];
      this.liveContexts.set(agentId, messages);

      const verification = new TaskVerification(
        initialPrompt,
        agent.workspace === 'isolated'
          ? join(
              agent.dataRoot || dataDir(),
              'workspaces',
              safeParent(agent.parentId),
              'subagents',
              agent.id,
            )
          : agent.workspace === 'shared'
            ? resolveEffectiveWorkspace(agent.parentId)
            : agent.workspace,
      );
      const tools = verification.tools(this.getToolDefinitions(agent));
      messages[0].content += '\n' + VERIFICATION_PROMPT;
      const skillPrompt = await this.skills?.buildPrompt(tools);
      if (skillPrompt) messages[0].content += '\n\n' + skillPrompt;
      let output = '';
      let finished = false;
      let messageCursor = agent.inheritContext ? agent.messages.length : 0;
      let previousObservation: LlmMessage | undefined;
      const progress = new ProgressGuard();

      for (let iter = 0; iter < (agent.maxIterations ?? Number.POSITIVE_INFINITY); iter++) {
        this.assertActive(agent);
        for (const message of agent.messages.slice(messageCursor)) {
          if (message['type'] === 'inter_agent' || agent.inheritContext) {
            messages.push({
              role: message['role'] === 'assistant' ? 'assistant' : 'user',
              content: String(message['content'] || ''),
            });
          }
        }
        messageCursor = agent.messages.length;
        this.logger.info('subagent: Sub-agent iteration', {
          agentId,
          iteration: iter + 1,
        });

        const chatParams: Parameters<LLMClientService['chatSync']>[0] = {
          messages,
          model,
          stream: false,
          signal: controller.signal,
        };
        if (tools) chatParams.tools = tools;

        journal.append('iteration', { iteration: iter, tokens: agent.tokens ?? 0 });
        agent.calls = (agent.calls || 0) + 1;
        this.checkpoint(agent);
        const result = await this.abortable(this.llm.chatSync(chatParams), controller.signal);
        agent.tokens = (agent.tokens || 0) + (result.usage?.totalTokens || 0);
        this.assertActive(agent);

        if (result.toolCalls && result.toolCalls.length > 0) {
          for (const call of result.toolCalls) progress.before(call.id);
          const assistantContent = result.content || '';
          if (assistantContent) output = assistantContent;
          messages.push({
            role: 'assistant',
            content: assistantContent,
            ...(result.reasoningContent !== undefined
              ? { reasoningContent: result.reasoningContent }
              : {}),
            ...(result.responseState ? { responseState: result.responseState } : {}),
            toolCalls: result.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          // 执行工具调用（子代理权限：ask 行为直接拒绝，无法交互式审批）
          let latestObservation: LlmMessage | undefined;
          for (const tc of result.toolCalls) {
            this.assertActive(agent);
            if (tc.name !== TASK_VERIFY && !tools?.some((tool) => tool.name === tc.name)) {
              throw new Error(`子任务调用了未授权的工具: ${tc.name}`);
            }
            journal.toolStarted(tc.id, tc.name, tc.arguments);
            let raw: unknown;
            if (tc.name === TASK_VERIFY) {
              try {
                raw = verification.submit(JSON.parse(tc.arguments));
              } catch {
                raw = { success: false, error: '验收参数必须是有效 JSON' };
              }
            } else {
              raw = await this.executeSubAgentTool(tc.name, tc.arguments, agentId);
              verification.record(tc.id, tc.name, tc.arguments, raw);
            }
            journal.toolFinished(
              tc.id,
              typeof raw === 'object' && raw !== null
                ? (raw as { success: boolean })
                : { success: true, output: String(raw) },
            );
            progress.after(tc.name, tc.arguments, raw);
            const provider = this.llm.resolveProviderForModel?.(model);
            const observation = visualObservation(
              raw,
              provider?.model || model,
              provider?.id || '',
            );
            const toolResult = observation.result;
            if (observation.message) latestObservation = observation.message;
            this.assertActive(agent);
            const toolContent =
              typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
            messages.push({
              role: 'tool',
              content: toolContent || '',
              toolCallId: tc.id,
            });
          }
          if (latestObservation) {
            if (previousObservation) {
              const index = messages.indexOf(previousObservation);
              if (index >= 0) messages.splice(index, 1);
            }
            previousObservation = latestObservation;
            messages.push(latestObservation);
          }
          // Summarize old steps without erasing the task or splitting tool transactions.
          if (messages.length > 100) {
            const compacted = compactContext(messages, 60);
            if (compacted !== messages) messages.splice(0, messages.length, ...compacted);
          }
          continue;
        }

        if (verification.continueIfNeeded(messages, result.content)) continue;
        if (verification.blocked) throw new Error(verification.finalText(''));
        // 验收通过后结束循环
        output = result.content || '';
        finished = true;
        break;
      }

      this.assertActive(agent);
      if (!finished) throw new Error('子代理达到迭代上限，任务尚未完成');
      if (!output.trim()) throw new Error('子代理未产生有效输出');
      const finalAgent = agent;
      finalAgent.result = output;
      finalAgent.status = 'completed';
      finalAgent.completedAt = Date.now();
      this.checkpoint(finalAgent);
      this._writeResultDoc(agentId, output);
      this.activeAgents.set(agentId, finalAgent);

      this.ws.broadcast({
        type: 'subagent_completed',
        data: { agentId, result: output },
      });

      if (finalAgent.autoDestroy) {
        this.destroyAgent(agentId, true);
      }
      journalState = 'completed';
      return {
        success: true,
        agentId,
        result: output,
        status: 'completed',
        calls: agent.calls || 0,
        tokens: agent.tokens || 0,
        ...(agent.remoteWorkspace ? { remoteWorkspace: agent.remoteWorkspace } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.activeAgents.get(agentId) !== agent)
        return { success: false, agentId, error: '子代理已终止', status: 'destroyed' };
      const errAgent = agent;
      errAgent.error = message;
      errAgent.status = 'error';
      errAgent.completedAt = Date.now();
      try {
        this.checkpoint(errAgent);
        this._writeResultDoc(agentId, `ERROR: ${message}`);
      } catch (persistenceError) {
        this.logger.error('subagent: Failed to persist task failure', {
          agentId,
          error: String(persistenceError),
        });
      }
      this.activeAgents.set(agentId, errAgent);
      if (errAgent.autoDestroy) {
        this.destroyAgent(agentId, true);
      }
      return {
        success: false,
        error: message,
        agentId,
        calls: agent.calls || 0,
        tokens: agent.tokens || 0,
        ...(agent.remoteWorkspace ? { remoteWorkspace: agent.remoteWorkspace } : {}),
      };
    } finally {
      try {
        journal?.finish(controller.signal.aborted ? 'cancelled' : journalState);
      } catch (error) {
        this.logger.error('Could not finish subagent journal', { error: String(error) });
      }
      this.controllers.delete(agentId);
      this.liveContexts.delete(agentId);
    }
  }

  /**
   * 异步执行子代理任务
   * - 所有入口共用先进先出队列
   * - 执行完成/失败后递减计数
   */
  executeAsync(agentId: string): void {
    void this.executeSync(agentId).then((result) => {
      this.logger.info('subagent: Async completed', { agentId, success: result.success });
    });
  }

  /**
   * 蜂群调度：并行创建并执行多个子代理任务
   * - 超过 maxConcurrent 的任务排队，不截断
   * - 全部完成后汇总结果（成功/失败计数 + 摘要）
   */
  async spawnSwarm(
    parentAgentId: string,
    tasks: SubAgentTaskConfig[] | string[],
  ): Promise<SwarmResult> {
    const taskList = Array.isArray(tasks) ? tasks : [tasks];
    // The concurrency limit controls execution, never the number of accepted tasks.
    const results = await Promise.all(
      taskList.map(async (tc): Promise<SubAgentExecutionResult> => {
        try {
          if (!tc || (typeof tc !== 'string' && typeof tc !== 'object'))
            throw new Error('Invalid task');
          const config = typeof tc === 'string' ? { task: tc, prompt: tc } : tc;
          const created = this.createSubAgent(parentAgentId, config);
          if (created.id === null) return { success: false, error: created.error };
          return await this.executeSync(created.id);
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    const summary = results
      .map(
        (r) =>
          `### ${r.agentId || ''}${r.success ? ' (OK)' : ' (ERROR)'}\n${(r.result || r.error || '').substring(0, 500)}`,
      )
      .join('\n\n');

    return {
      success: results.length > 0 && results.every((r) => r.success),
      totalTasks: taskList.length,
      completed: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
      summary,
    };
  }

  /**
   * 销毁子代理：标记状态、清理工作区、移除存储
   */
  destroyAgent(agentId: string, internal = false): { success: boolean; error?: string } {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return { success: false, error: `Agent not found: ${agentId}` };
    if (!internal && !this.owns(agent))
      return { success: false, error: '任务属于其他账号或企业身份' };
    const keepArtifacts = ['completed', 'error'].includes(agent.status);
    if (!['completed', 'error'].includes(agent.status)) {
      try {
        this.checkpoint({ ...agent, status: 'destroyed', destroyedAt: Date.now() });
      } catch (error) {
        this.logger.error('subagent: Failed to persist cancellation', {
          agentId,
          error: String(error),
        });
      }
    }
    agent.status = 'destroyed';
    agent.destroyedAt = Date.now();
    this.controllers.get(agentId)?.abort();
    ChatControlRegistry.requestAbort(agentId);
    ChatControlRegistry.clearAbort(agentId);
    for (const child of [...this.activeAgents.values()]) {
      if (child.parentId === agentId) this.destroyAgent(child.id, true);
    }
    const queued = this.queue.findIndex((job) => job.id === agentId);
    if (queued >= 0) {
      this.queue
        .splice(queued, 1)[0]
        .resolve({ success: false, agentId, status: 'destroyed', error: '子代理已终止' });
      this.executions.delete(agentId);
    }
    if (!keepArtifacts) this._destroySubWorkspace(agentId, agent.parentId);
    this._forkChain.delete(agentId);
    this._laneMap.delete(agentId);
    this.activeAgents.delete(agentId);
    this.remote?.release(agentId);
    this.logger.info('subagent: Destroyed sub-agent', { agentId });
    return { success: true };
  }

  /** 获取子代理状态 */
  getAgentStatus(agentId: string): SubAgent | null {
    const agent = this.activeAgents.get(agentId);
    return agent && this.owns(agent) ? structuredClone(agent) : null;
  }

  /** 列出所有处于活跃状态（created/dispatching/running）的子代理 */
  listActiveAgents(): SubAgent[] {
    return Array.from(this.activeAgents.values())
      .filter((a) => this.owns(a) && ['created', 'dispatching', 'running'].includes(a.status))
      .map((a) => structuredClone(a));
  }

  /**
   * 代理间通信：fromAgentId 向 toAgentId 发送消息
   * - 目标代理不存在则失败
   * - 消息存入目标代理的 messages 列表
   * - 通过 WebSocket 广播通知
   */
  communicate(
    fromAgentId: string,
    toAgentId: string,
    message: string,
  ): { success: boolean; error?: string } {
    const toAgent = this.activeAgents.get(toAgentId);
    if (!toAgent) return { success: false, error: 'Target agent not found' };
    const fromAgent = this.activeAgents.get(fromAgentId);
    if (!this.owns(toAgent) || (fromAgent && !this.owns(fromAgent)))
      return { success: false, error: '任务属于其他账号或企业身份' };
    if (!['created', 'dispatching', 'running'].includes(toAgent.status))
      return { success: false, error: '目标任务已结束' };
    toAgent.messages.push({
      from: fromAgentId,
      content: message,
      timestamp: Date.now(),
      type: 'inter_agent',
    });
    this.ws.broadcast({
      type: 'agent_message',
      data: { from: fromAgentId, to: toAgentId, content: message, timestamp: Date.now() },
    });
    return { success: true };
  }

  /** 终止代理（destroyAgent 别名） */
  terminateAgent(agentId: string): { success: boolean; error?: string } {
    return this.destroyAgent(agentId);
  }

  /** 当前运行中子代理数 */
  getRunningCount(): number {
    return this._runningCount;
  }

  // ─── 内部工具方法 ──────────────────────────────────────────────

  /** 获取可用工具定义（toolExecutor 不可用时返回 undefined） */
  private getToolDefinitions(
    agent: SubAgent,
  ): Parameters<LLMClientService['chatSync']>[0]['tools'] {
    if (!this.toolExecutor) return undefined;
    if (!agent.inheritTools && !agent.tools?.length) return undefined;
    try {
      const all = this.toolExecutor
        .getToolDefinitions()
        .filter(
          (t) =>
            !['subagent_spawn_swarm', 'sessions_spawn', 'subagent_create'].includes(t.name) &&
            (agent.allowDelegation !== false || t.name !== 'subagent_execute') &&
            (!agent.tools || agent.tools.includes(t.name)),
        )
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
      return all.length > 0 ? all : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 执行子代理工具调用
   * - 嵌套子代理调用（subagent_execute）：受深度限制，超限拒绝
   * - 其他工具：委托给 ToolExecutorService
   * - toolExecutor 不可用时返回错误对象
   */
  private async executeSubAgentTool(
    toolName: string,
    rawArgs: string,
    parentAgentId: string,
  ): Promise<unknown> {
    const parent = this.activeAgents.get(parentAgentId);
    if (!parent) return { ok: false, error: '子代理已终止' };
    this.assertActive(parent);
    if (!this.getToolDefinitions(parent)?.some((tool) => tool.name === toolName)) {
      return { ok: false, error: `工具未授权: ${toolName}` };
    }
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return { ok: false, error: '工具参数必须是 JSON 对象' };
    } catch {
      return { ok: false, error: '工具参数不是有效 JSON' };
    }

    // 嵌套子代理调用：校验深度
    if (toolName === 'subagent_execute') {
      const nestedDepth = this._getDepth(parentAgentId);
      if (nestedDepth >= this.maxSpawnDepth) {
        return { ok: false, error: '子代理嵌套深度已达上限，无法继续创建子代理' };
      }
      const nestedAgent = this.createSubAgent(parentAgentId, {
        task: (args['task'] as string) || 'Untitled',
        prompt: (args['prompt'] as string) || (args['task'] as string) || '',
        model: (args['model'] as string) || parent.model,
        type: (args['type'] as string) || 'worker',
        autoDestroy: args['autoDestroy'] !== false,
        inheritTools: parent.inheritTools,
        tools: parent.tools,
        permissionMode: parent.permissionMode,
        workspace: this.remote?.binding(parentAgentId)
          ? args['workspace'] === 'shared'
            ? 'shared'
            : 'isolated'
          : parent.workspace,
        allowDelegation: parent.allowDelegation !== false,
        ...(parent.maxIterations
          ? { maxIterations: Math.max(1, parent.maxIterations - (parent.calls || 0)) }
          : {}),
      });
      if (nestedAgent.id === null) {
        return {
          ok: false,
          error: `嵌套子代理创建失败: ${nestedAgent.error || '未知错误'}`,
        };
      }
      // A waiting parent lends its execution slot to its child; no extra concurrency or queue deadlock.
      const nestedRun = this.runAgent(nestedAgent.id);
      this.executions.set(nestedAgent.id, nestedRun);
      const nestedResult = await nestedRun.finally(() => this.executions.delete(nestedAgent.id));
      return {
        success: nestedResult.success,
        ok: nestedResult.success,
        output: nestedResult.result || '',
        agentId: nestedResult.agentId,
        ...(nestedResult.remoteWorkspace ? { remoteWorkspace: nestedResult.remoteWorkspace } : {}),
        error: nestedResult.error || '',
      };
    }

    // 其他工具委托给 ToolExecutorService
    if (!this.toolExecutor) {
      return { ok: false, error: 'Tool executor not available' };
    }
    try {
      const ctx = {
        ...(this.controllers.get(parentAgentId)
          ? { signal: this.controllers.get(parentAgentId)!.signal }
          : {}),
        sessionId: parentAgentId,
        agentId: parent.id,
        workspace:
          parent.workspace === 'isolated'
            ? join(
                parent.dataRoot || dataDir(),
                'workspaces',
                safeParent(parent.parentId),
                'subagents',
                parent.id,
              )
            : parent.workspace === 'shared'
              ? resolveEffectiveWorkspace(parent.parentId)
              : parent.workspace,
        config: {},
        log: (level: string, msg: string) => this.logger.debug(`[subagent-tool:${level}] ${msg}`),
        broadcast: (event: string) => this.logger.debug(`[subagent-tool broadcast] ${event}`),
      };
      const execution = this.toolExecutor.execute(toolName, args, ctx);
      const result = ctx.signal ? await this.abortable(execution, ctx.signal) : await execution;
      return result;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
