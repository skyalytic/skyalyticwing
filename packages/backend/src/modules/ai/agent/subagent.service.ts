import { Injectable } from '@nestjs/common';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { LLMClientService } from '../llm/llm-client.service.js';
import { AgentSwarmService } from './agent-swarm.service.js';
import type { RemoteWorkspace } from '../../core/remote-workspace/remote-connections.js';
import type {
  SubAgent,
  SubAgentTaskConfig,
  SubAgentExecutionResult,
  SwarmResult,
} from './agent-swarm.service.js';

/**
 * SubagentService - 子代理系统对外门面服务
 *
 * 基于 AgentSwarmService（移植自 start.cjs SubAgentSystem）扩展，提供：
 *   - 创建子代理（委托 AgentSwarmService.createSubAgent）
 *   - 列出子代理（委托 AgentSwarmService.listActiveAgents）
 *   - 派发子代理任务（委托 AgentSwarmService.dispatchTask）
 *   - 子代理详情（委托 AgentSwarmService.getAgentStatus）
 *   - 子代理间通信（委托 AgentSwarmService.communicate）
 *   - 隔离代理执行（IsolatedAgent.execute 语义，独立 LLM 会话）
 *   - 顺便执行 /btw（旁路提问，不打断主对话）
 *
 * 隔离代理执行：创建临时会话，调用 LLM 多轮迭代（支持工具调用），返回结果。
 */
/** 隔离代理执行配置 */
export interface IsolatedAgentOptions {
  model?: string;
  sessionId?: string;
  maxIterations?: number;
  systemPrompt?: string;
  tools?: string[];
  delivery?: unknown;
}

/** 隔离代理执行结果 */
export interface IsolatedAgentResult {
  remoteWorkspace?: RemoteWorkspace;
  success: boolean;
  output?: string;
  error?: string;
  iterations: number;
  durationMs: number;
}

/** btw 请求 */
export interface BtwResult {
  answer: string;
  question: string;
}

@Injectable()
export class SubagentService {
  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly llm: LLMClientService,
    private readonly swarm: AgentSwarmService,
  ) {}

  /** 创建子代理 */
  createSubAgent(
    parentId: string,
    config: SubAgentTaskConfig,
  ): { success: boolean; agent?: SubAgent; error?: string } {
    try {
      const created = this.swarm.createSubAgent(parentId || 'default', config || {});
      if (created.id === null) {
        return { success: false, error: created.error };
      }
      return { success: true, agent: created as SubAgent };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 列出活跃子代理 */
  history() {
    return this.swarm.listHistory();
  }
  retryInterrupted(id: string, confirmReplay: boolean) {
    return this.swarm.retryInterrupted(id, confirmReplay);
  }

  listSubagents(): { agents: SubAgent[]; total: number } {
    return {
      agents: this.swarm.listActiveAgents(),
      total: this.swarm.getRunningCount(),
    };
  }

  /** 派发子代理任务 */
  dispatchTask(
    agentId: string,
    task: string,
    background = false,
  ): { success: boolean; agentId?: string; mode?: string; error?: string } {
    return this.swarm.dispatchTask(agentId, task, background);
  }

  /** 子代理详情 */
  getSubagent(id: string): SubAgent | null {
    return this.swarm.getAgentStatus(id);
  }

  /** 子代理间通信 */
  communicate(from: string, to: string, message: string): { success: boolean; error?: string } {
    return this.swarm.communicate(from, to, message);
  }

  /** 终止子代理 */
  terminate(agentId: string): { success: boolean; error?: string } {
    return this.swarm.destroyAgent(agentId);
  }

  /**
   * 分叉子代理（对齐 .cjs SubAgentSystem.createFork）
   * - Fork 不能在 Fork 内嵌套创建
   * - 继承工具/上下文，权限 bubble
   */
  createFork(
    parentSessionId: string,
    config: SubAgentTaskConfig,
  ): { success: boolean; agent?: SubAgent; error?: string } {
    try {
      const result = this.swarm.createFork(parentSessionId || 'default', config || {});
      if (!('id' in result)) {
        return { success: false, error: result.error };
      }
      return { success: true, agent: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 蜂群任务：并行创建并执行多个子代理（对齐 .cjs spawnSwarm）
   * 任务列表超过 maxConcurrent 时排队，全部完成后汇总
   */
  async spawnSwarm(
    parentId: string,
    tasks: Array<string | SubAgentTaskConfig>,
  ): Promise<SwarmResult> {
    return this.swarm.spawnSwarm(
      parentId || 'main',
      (tasks || []) as SubAgentTaskConfig[] | string[],
    );
  }

  /**
   * 隔离代理执行
   * - 创建临时 LLM 会话，多轮迭代支持工具调用
   * - 不依赖会话存储，纯内存执行
   * - 完成后通过 WebSocket 广播 isolated_agent_completed 事件
   */
  async executeIsolated(
    prompt: string,
    options: IsolatedAgentOptions = {},
  ): Promise<IsolatedAgentResult> {
    const start = Date.now();
    if (typeof prompt !== 'string' || !prompt.trim())
      return {
        success: false,
        error: 'prompt required',
        iterations: 0,
        durationMs: Date.now() - start,
      };
    const sessionId = options.sessionId || 'isolated';
    const created = this.swarm.createSubAgent(sessionId, {
      type: 'isolated',
      task: prompt,
      prompt,
      workspace: 'isolated',
      model: options.model || this.llm.getDefaultModel(),
      systemPrompt: options.systemPrompt || '你是一个隔离执行的代理，负责完成给定任务。',
      ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
      ...(options.tools ? { tools: options.tools } : {}),
      inheritTools: false,
      allowDelegation: false,
    });
    if (created.id === null)
      return {
        success: false,
        error: created.error,
        iterations: 0,
        durationMs: Date.now() - start,
      };
    const result = await this.swarm.executeSync(created.id);
    const durationMs = Date.now() - start,
      iterations = result.calls || 0;
    if (!result.success)
      return {
        success: false,
        error: result.error || '隔离任务失败',
        iterations,
        durationMs,
        ...(result.remoteWorkspace ? { remoteWorkspace: result.remoteWorkspace } : {}),
      };
    const output = result.result || '';
    this.ws.broadcast({
      type: 'isolated_agent_completed',
      data: { sessionId, output, iterations, durationMs },
    });
    return {
      success: true,
      output,
      iterations,
      durationMs,
      ...(result.remoteWorkspace ? { remoteWorkspace: result.remoteWorkspace } : {}),
    };
  }

  /**
   * 顺便执行 /btw - 旁路提问
   * - 不打断主对话，不使用工具，简短回答
   * - 返回 { answer, question }
   */
  async handleBtw(question: string, sessionId?: string): Promise<BtwResult> {
    if (!question || typeof question !== 'string') {
      return { answer: '无效的旁路提问', question: question || '' };
    }
    const systemPrompt = [
      '你正在回答一个临时的旁路提问(/btw)。',
      '请仅根据对话背景回答这个旁路问题。',
      '不要继续或完成对话中的任何未完成任务。',
      '不要使用任何工具调用。',
      '如果问题可以简短回答，请简短回答。',
      '回答完毕后，主对话将继续不受影响。',
    ].join('\n');

    const model = this.llm.getDefaultModel();

    try {
      const result = await this.llm.chatSync({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '旁路提问: ' + question },
        ],
        model,
        stream: false,
      });
      let answer = result.content || '';
      if (!answer) {
        answer = '无法生成回答';
      }
      this.logger.info('btw: handled', { sessionId, preview: answer.substring(0, 80) });
      return { answer, question };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('btw: failed', { sessionId, error: msg });
      return { answer: `[btw 失败: ${msg}]`, question };
    }
  }

  /** 隔离代理状态（与 start.cjs IsolatedAgent.getStatus 对齐） */
  getIsolatedStatus(): { running: number; maxIterations: number | null } {
    return {
      running: this.swarm
        .listActiveAgents()
        .filter((a) => a.type === 'isolated' && a.status === 'running').length,
      maxIterations: null,
    };
  }
}

/** 工具调用结果类型（供 executeIsolated 内部引用） */
export type { SubAgentExecutionResult };
