import { ChatControlRegistry } from '../chat/chat-control.registry.js';
import { SkillService } from './skill.service.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TaskVerification, TASK_VERIFY, VERIFICATION_PROMPT } from './task-verification.js';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../../core/logger/logger.service.js';
import { resolveEffectiveWorkspace } from '../../core/config/effective-workspace.util.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { LLMClientService } from '../llm/llm-client.service.js';
import { AgentService } from './agent.service.js';
import {
  TOOL_EXECUTOR_SERVICE,
  type IToolExecutorService,
  type LlmMessage,
} from '../types.js';

/**
 * AgentMessenger (代理间消息传递) - NestJS TypeScript 重写
 *
 * 移植自 packages/web/start.cjs 第 1845-2224 行的 AgentMessenger。
 *
 * 核心能力：
 *   - 代理间消息路由（send）
 *   - 消息队列（每代理 mailbox，超过 200 条裁剪到 150 条）
 *   - 广播（broadcast）/ 单播
 *   - 自动回复：目标代理无活跃会话时，创建临时会话驱动 LLM 生成回复，
 *     回复自动发送回原发送方
 *   - 收件箱查询 / 未读查询 / 标记已读 / 会话历史
 *
 * 注意：原 .cjs 中 inter-agent 会话消息上限 500 条（第十三轮修复）。
 */

/** 单代理 mailbox 最大保留条数（超出后裁剪到 TRIM_TO） */
const MAILBOX_MAX = 200;
/** 裁剪后的目标条数 */
const MAILBOX_TRIM_TO = 150;
/** 自动回复会话消息上限 */
const REPLY_SESSION_MAX_MSGS = 500;
/** 自动回复最大迭代轮数 */


/** 代理间消息 */
export interface AgentMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  type: string;
  timestamp: number;
  read: boolean;
  /** 回复所针对的原消息 ID */
  inReplyTo?: string;
}

/** send 返回结果 */
export interface SendResult {
  success: boolean;
  msgId?: string;
  delivered?: boolean;
  error?: string;
}

/** 标记已读结果 */
export interface MarkReadResult {
  success: boolean;
  marked: number;
}

@Injectable()
export class AgentMessengerService {
  /** 代理 mailbox：agentId -> 消息列表 */
  private readonly mailbox = new Map<string, AgentMessage[]>();

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly agentService: AgentService,
    private readonly llm: LLMClientService,
    @Optional() @Inject(TOOL_EXECUTOR_SERVICE) private readonly toolExecutor?: IToolExecutorService,
    @Optional() private readonly skills?: SkillService,
  ) {}

  /**
   * 发送消息：fromAgentId -> toAgentId
   * - 校验发送方/接收方存在（基于 AgentService）
   * - 禁止向自己发送
   * - 写入接收方 mailbox（超限裁剪）
   * - 目标代理无活跃会话时触发自动回复
   * - 通过 WebSocket 广播消息事件
   */
  send(
    fromAgentId: string,
    toAgentId: string,
    message: string,
    msgType = 'text',
  ): SendResult {
    const fromAgent = this.tryGetAgent(fromAgentId);
    const toAgent = this.tryGetAgent(toAgentId);
    if (!fromAgent) return { success: false, error: `发送方代理不存在: ${fromAgentId}` };
    if (!toAgent) return { success: false, error: `接收方代理不存在: ${toAgentId}` };
    if (fromAgentId === toAgentId) return { success: false, error: '不能向自己发送消息' };

    const msg: AgentMessage = {
      id: `msg-${Date.now()}-${randomBytes(3).toString('hex').slice(0, 6)}`,
      from: fromAgentId,
      fromName: fromAgent.name || fromAgentId,
      to: toAgentId,
      toName: toAgent.name || toAgentId,
      content: message,
      type: msgType,
      timestamp: Date.now(),
      read: false,
    };

    // 写入接收方 mailbox
    let inbox = this.mailbox.get(toAgentId);
    if (!inbox) {
      inbox = [];
      this.mailbox.set(toAgentId, inbox);
    }
    inbox.push(msg);
    if (inbox.length > MAILBOX_MAX) {
      this.mailbox.set(toAgentId, inbox.slice(-MAILBOX_TRIM_TO));
    }

    // 目标代理无活跃会话时触发自动回复
    // （当前 NestJS 实现无 sessionsStore 概念，统一触发自动回复以保留原逻辑）
    void this.triggerAutoReply(fromAgentId, toAgentId, message, msg);

    // 广播消息事件
    this.ws.broadcast({
      type: 'agent_message',
      data: {
        from: fromAgentId,
        fromName: fromAgent.name || fromAgentId,
        to: toAgentId,
        toName: toAgent.name || toAgentId,
        content: message,
        msgId: msg.id,
        timestamp: msg.timestamp,
      },
    });

    this.logger.info('agent-messenger: Message sent', {
      from: fromAgentId,
      to: toAgentId,
      preview: (message || '').substring(0, 80),
    });
    return { success: true, msgId: msg.id, delivered: true };
  }

  /**
   * 自动回复：目标代理通过 LLM 处理消息并回复发送方
   * - 构建提示，驱动 LLM（最多 10 轮，支持工具调用）
   * - 回复写入原发送方 mailbox 并广播
   */
  private async triggerAutoReply(
    fromAgentId: string,
    toAgentId: string,
    message: string,
    originalMsg: AgentMessage,
  ): Promise<void> {
    const fromAgent = this.tryGetAgent(fromAgentId);
    const toAgent = this.tryGetAgent(toAgentId);
    if (!fromAgent || !toAgent) return;

    const toModel = toAgent.model || this.llm.getDefaultModel();
    const verification = new TaskVerification(message);
    const tools = verification.tools(this.getToolDefinitions(toAgentId));

    const initialPrompt =
      `[来自代理 ${fromAgent.name} 的消息] ${message}\n\n` +
      '请处理以上来自其他代理的消息，给出你的回复。回复将自动发送给对方。';

    const messages: LlmMessage[] = [
      { role: 'system', content: (toAgent.systemPrompt || '你是一个协作代理，负责处理来自其他代理的消息。') + '\n' + VERIFICATION_PROMPT },
      { role: 'user', content: initialPrompt },
    ];
    const skillPrompt = await this.skills?.buildPrompt(tools);
    if (skillPrompt) messages[0].content += '\n\n' + skillPrompt;

    let replyContent = '';
    let toolResultsSummary = '';

    const loopAbort = new AbortController();
    const unsubscribeAbort = ChatControlRegistry.onAbort(id => { if (!id || id === toAgentId) loopAbort.abort(); });
    try {
      for (;;) {
        if (loopAbort.signal.aborted) throw new Error('任务已由用户停止');
        const chatParams: Parameters<LLMClientService['chatSync']>[0] = {
          messages,
          signal: loopAbort.signal,
          model: toModel,
          stream: false,
        };
        if (tools) chatParams.tools = tools;

        const aiResult = await this.llm.chatSync(chatParams);

        if (aiResult.toolCalls && aiResult.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: aiResult.content || '',
            ...(aiResult.reasoningContent !== undefined ? { reasoningContent: aiResult.reasoningContent } : {}),
            toolCalls: aiResult.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          // 执行工具
          const toolResults: Array<{ name: string; content: string; toolCallId: string }> = [];
          for (const tc of aiResult.toolCalls) {
            if (loopAbort.signal.aborted) throw new Error('任务已由用户停止');
            let tr: unknown;
            if (tc.name === TASK_VERIFY) {
              try { tr = verification.submit(JSON.parse(tc.arguments)); }
              catch { tr = {success: false, error: '验收参数必须是有效 JSON'}; }
            } else {
              tr = await this.executeTool(tc.name, tc.arguments, toAgentId, loopAbort.signal);
              verification.record(tc.id, tc.name, tc.arguments, tr);
            }
            const content =
              typeof tr === 'string' ? tr : JSON.stringify(tr, null, 2);
            toolResults.push({
              name: tc.name,
              content: content || '',
              toolCallId: tc.id || '',
            });
          }
          toolResultsSummary = '';
          for (const r of toolResults) {
            messages.push({
              role: 'tool',
              content: r.content,
              toolCallId: r.toolCallId,
            });
            toolResultsSummary += `[${r.name}]: ${r.content.substring(0, 500)}\n`;
          }
          if (messages.length > REPLY_SESSION_MAX_MSGS) {
            let cut = messages.length - REPLY_SESSION_MAX_MSGS + 2;
            while (cut < messages.length && messages[cut].role === 'tool') cut++;
            messages.splice(2, Math.max(0, cut - 2));
          }
          // 下一轮 prompt 为工具结果
          messages.push({
            role: 'user',
            content:
              '请根据以上完整工具执行结果继续完成任务；读取技能指南不代表完成，请继续执行并检查产物。若任务已完成，请给出最终回复。',
          });
          continue;
        }

        if (verification.continueIfNeeded(messages, aiResult.content)) continue;
        replyContent = verification.finalText(aiResult.content || '');
        break;
      }

      if (!replyContent && toolResultsSummary) {
        replyContent = toolResultsSummary.substring(0, 2000);
      }
    } catch (err) {
      this.logger.warn('agent-messenger: Auto-reply AI call failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!replyContent) {
        replyContent = `[代理处理消息时出错: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }

    unsubscribeAbort();
    // 发送回复给原发送方
    if (replyContent) {
      const replyMsg: AgentMessage = {
        id: `msg-${Date.now()}-${randomBytes(3).toString('hex').slice(0, 6)}`,
        from: toAgentId,
        fromName: toAgent.name || toAgentId,
        to: fromAgentId,
        toName: fromAgent.name || fromAgentId,
        content: replyContent,
        type: 'reply',
        timestamp: Date.now(),
        read: false,
        inReplyTo: originalMsg.id,
      };
      let fromInbox = this.mailbox.get(fromAgentId);
      if (!fromInbox) {
        fromInbox = [];
        this.mailbox.set(fromAgentId, fromInbox);
      }
      fromInbox.push(replyMsg);
      if (fromInbox.length > MAILBOX_MAX) {
        this.mailbox.set(fromAgentId, fromInbox.slice(-MAILBOX_TRIM_TO));
      }

      this.ws.broadcast({
        type: 'agent_message',
        data: {
          from: toAgentId,
          fromName: toAgent.name || toAgentId,
          to: fromAgentId,
          toName: fromAgent.name || fromAgentId,
          content: replyContent,
          msgId: replyMsg.id,
          timestamp: replyMsg.timestamp,
          inReplyTo: originalMsg.id,
        },
      });

      this.logger.info('agent-messenger: Auto-reply sent', {
        from: toAgentId,
        to: fromAgentId,
        preview: (replyContent || '').substring(0, 80),
      });
    }
  }

  /** 获取收件箱（最近 50 条） */
  getInbox(agentId: string): AgentMessage[] {
    return (this.mailbox.get(agentId) || []).slice(-50);
  }

  /** 获取未读消息 */
  getUnread(agentId: string): AgentMessage[] {
    return (this.mailbox.get(agentId) || []).filter((m) => !m.read);
  }

  /**
   * 标记已读
   * - 指定 msgId：仅标记该消息
   * - 未指定 msgId：标记全部未读为已读
   */
  markRead(agentId: string, msgId?: string): MarkReadResult {
    const msgs = this.mailbox.get(agentId) || [];
    let marked = 0;
    for (const m of msgs) {
      if (msgId) {
        if (m.id === msgId && !m.read) {
          m.read = true;
          marked++;
        }
      } else if (!m.read) {
        m.read = true;
        marked++;
      }
    }
    return { success: true, marked };
  }

  /**
   * 获取两个代理之间的会话历史
   * - 合并双向 mailbox 中相关消息
   * - 按时间排序，返回最近 100 条
   */
  getConversation(agentId1: string, agentId2: string): AgentMessage[] {
    const msgs1 = this.mailbox.get(agentId1) || [];
    const msgs2 = this.mailbox.get(agentId2) || [];
    const all: AgentMessage[] = [];
    for (const m of msgs1) {
      if (m.from === agentId2 || m.to === agentId2) all.push(m);
    }
    for (const m of msgs2) {
      if (m.from === agentId1 || m.to === agentId1) all.push(m);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all.slice(-100);
  }

  /** 广播消息给所有代理（写入所有 mailbox + WebSocket 广播） */
  broadcast(fromAgentId: string, message: string, msgType = 'broadcast'): void {
    for (const agentId of this.mailbox.keys()) {
      if (agentId === fromAgentId) continue;
      this.send(fromAgentId, agentId, message, msgType);
    }
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 安全获取代理（不存在返回 undefined） */
  private tryGetAgent(agentId: string): { id: string; name: string; model: string; systemPrompt: string } | undefined {
    try {
      const a = this.agentService.getAgent(agentId);
      return {
        id: a.id,
        name: a.name,
        model: a.model,
        systemPrompt: a.systemPrompt,
      };
    } catch {
      return undefined;
    }
  }

  /** 获取工具定义 */
  private getToolDefinitions(agentId: string): Parameters<LLMClientService['chatSync']>[0]['tools'] {
    if (!this.toolExecutor) return undefined;
    try {
      const allowed = this.agentService.getAgent(agentId).tools;
      const all = this.toolExecutor.getToolDefinitions().filter(t => !allowed?.length || allowed.includes(t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      return all.length > 0 ? all : undefined;
    } catch {
      return undefined;
    }
  }

  /** 执行工具 */
  private async executeTool(
    toolName: string,
    rawArgs: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.toolExecutor) {
      return { success: false, error: 'Tool executor not available' };
    }
    if (!this.getToolDefinitions(agentId)?.some(tool => tool.name === toolName)) {
      return { success: false, blocked: true, error: `工具未授权: ${toolName}` };
    }
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return { success: false, error: '工具参数必须是有效 JSON' };
    }
    try {
      const ctx = {
        sessionId: agentId,
        ...(signal ? {signal} : {}),
        workspace: resolveEffectiveWorkspace(agentId),
        config: {},
        log: (level: string, msg: string) =>
          this.logger.debug(`[messenger-tool:${level}] ${msg}`),
        broadcast: (event: string, _data: unknown) =>
          this.logger.debug(`[messenger-tool broadcast] ${event}`),
      };
      return await this.toolExecutor.execute(toolName, args, ctx);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
