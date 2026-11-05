import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  TokenUsage,
} from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { LLMClientService } from '../llm/llm-client.service.js';
import { AgentLoopService } from '../agent/agent-loop.service.js';
import {
  ISessionService,
  SESSION_SERVICE,
} from '../types.js';

/**
 * ChatService - 聊天服务（harness 集成）
 *
 * 通过 AgentLoopService 执行完整的 harness 循环：
 *   用户消息 → LLM → 工具调用 → 审批 → 执行 → 结果回填 → 循环 → 最终响应
 *
 * 职责：
 *   - sendMessage：非流式，运行 AgentLoop 收集事件，返回完整 ChatResponse
 *   - streamMessage：流式，运行 AgentLoop 逐事件 yield ChatStreamChunk
 *   - 广播工具调用/审批/结果到 WebSocket
 *   - 获取会话历史
 *   - 透传用户多模态附件（attachments）给 AgentLoop；捕获工具生成的内联媒体附件
 *     并随最终助手消息（WS chat_message 广播与 POST 响应）返回
 *
 * AgentLoop 自身负责消息持久化和上下文构建，ChatService 不再重复保存。
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly llm: LLMClientService,
    private readonly agentLoop: AgentLoopService,
    private readonly ws: WebSocketService,
    private readonly logger: LoggerService,
    @Optional() @Inject(SESSION_SERVICE) private readonly session?: ISessionService,
  ) {}

  /** 非流式发送消息（走 AgentLoop harness 循环） */
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const sessionId = request.session;
    let content = '';
    let usage: TokenUsage | undefined;
    let attachments: Attachment[] | undefined;
    let persistedMessage: ChatMessage | undefined;
    const model = request.model ?? this.llm.getDefaultModel();

    const loopOptions: { model?: string; agentId?: string; attachments?: Attachment[]; stream?: boolean; turnId?: string } = {};
    if (request.stream !== undefined) loopOptions.stream = request.stream;
    if (request.turnId) loopOptions.turnId = request.turnId;
    if (request.model) loopOptions.model = request.model;
    if (request.agent) loopOptions.agentId = request.agent;
    if (request.attachments && request.attachments.length > 0) {
      loopOptions.attachments = request.attachments;
    }

    for await (const event of this.agentLoop.run(sessionId, request.message, loopOptions)) {
      switch (event.type) {
        case 'assistant_delta':
          this.ws.broadcastToSession(sessionId, {type: 'chat_stream', data: {sessionId, content: '', done: false, message: event.message}});
          break;
        case 'assistant_message':
          if (event.message?.phase === 'progress' || event.message?.phase === 'status') {
            this.ws.broadcastToSession(sessionId, {type: 'chat_message', data: event.message});
            break;
          }
          persistedMessage = event.message;
          content = event.content || '';
          // 捕获工具生成的内联媒体附件，随最终助手消息返回
          if (event.attachments && event.attachments.length > 0) {
            attachments = event.attachments;
          }
          break;
        case 'tool_call':
          this.ws.broadcastToSession(sessionId, {
            type: 'tool_call',
            data: { sessionId, toolName: event.toolName, args: event.args, callId: event.callId, ...(event.turnId ? {turnId: event.turnId, turnSequence: event.turnSequence} : {}) },
          });
          break;
        case 'tool_result':
          this.ws.broadcastToSession(sessionId, {
            type: 'tool_result',
            data: { sessionId, toolName: event.toolName, result: event.result, callId: event.callId, ...(event.turnId ? {turnId: event.turnId, turnSequence: event.turnSequence} : {}) },
          });
          break;
        case 'approval_request':
          this.ws.broadcastToSession(sessionId, {
            type: 'approval_request',
            data: { ...event.request, sessionId },
          });
          break;
        case 'done':
          if (event.usage) usage = event.usage;
          break;
        case 'error':
          await this.recordTurnError(request, event.error);
          throw new Error(event.error);
      }
    }

    const assistantMessage: ChatMessage = persistedMessage ? { ...persistedMessage, sessionId } : {
      id: randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      model,
      // 会话归属标记：前端按 sessionId 过滤跨会话事件（多会话并行防串扰）
      sessionId,
    };
    if (attachments) assistantMessage.attachments = attachments;
    this.ws.broadcastToSession(sessionId, { type: 'chat_message', data: assistantMessage });

    const response: ChatResponse = { message: assistantMessage, sessionId };
    if (usage) response.usage = usage;
    return response;
  }
  /** 流式发送消息（走 AgentLoop harness 循环） */
  async *streamMessage(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const sessionId = request.session;
    let usage: TokenUsage | undefined;
    const model = request.model ?? this.llm.getDefaultModel();
    let fullContent = '';
    let attachments: Attachment[] | undefined;
    let persistedMessage: ChatMessage | undefined;

    const loopOptions: { model?: string; agentId?: string; attachments?: Attachment[]; stream?: boolean; turnId?: string } = {};
    if (request.stream !== undefined) loopOptions.stream = request.stream;
    if (request.turnId) loopOptions.turnId = request.turnId;
    if (request.model) loopOptions.model = request.model;
    if (request.agent) loopOptions.agentId = request.agent;
    if (request.attachments && request.attachments.length > 0) {
      loopOptions.attachments = request.attachments;
    }

    try {
      for await (const event of this.agentLoop.run(sessionId, request.message, loopOptions)) {
        switch (event.type) {
          case 'assistant_delta':
            this.ws.broadcastToSession(sessionId, {type: 'chat_stream', data: {sessionId, content: '', done: false, message: event.message}});
            yield {type: 'delta', content: event.message.content};
            break;
          case 'assistant_message': {
            if (event.message?.phase === 'progress' || event.message?.phase === 'status') {
              this.ws.broadcastToSession(sessionId, {type: 'chat_message', data: event.message});
              break;
            }
            persistedMessage = event.message;
            // 捕获工具生成的内联媒体附件，随最终助手消息返回
            if (event.attachments && event.attachments.length > 0) {
              attachments = event.attachments;
            }
            const delta = event.content || '';
            if (delta) {
              fullContent += delta;
              this.ws.broadcastToSession(sessionId, {
                type: 'chat_stream',
                data: { sessionId, content: delta, done: false },
              });
              yield { type: 'delta', content: delta };
            }
            break;
          }
          case 'tool_call':
            this.ws.broadcastToSession(sessionId, {
              type: 'tool_call',
              data: { sessionId, toolName: event.toolName, args: event.args, callId: event.callId, ...(event.turnId ? {turnId: event.turnId, turnSequence: event.turnSequence} : {}) },
            });
            yield {
              type: 'tool_call',
              toolCall: {
                id: event.callId,
                name: event.toolName,
                arguments: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
              },
            };
            break;
          case 'tool_result':
            this.ws.broadcastToSession(sessionId, {
              type: 'tool_result',
              data: { sessionId, toolName: event.toolName, result: event.result, callId: event.callId, ...(event.turnId ? {turnId: event.turnId, turnSequence: event.turnSequence} : {}) },
            });
            break;
          case 'approval_request':
            this.ws.broadcastToSession(sessionId, {
              type: 'approval_request',
              data: { ...event.request, sessionId },
            });
            break;
          case 'done':
            if (event.usage) usage = event.usage;
            break;
          case 'error':
            await this.recordTurnError(request, event.error);
            yield { type: 'error', error: event.error };
            return;
        }
      }

      const assistantMessage: ChatMessage = persistedMessage ? { ...persistedMessage, sessionId } : {
        id: randomUUID(),
        role: 'assistant',
        // 结尾完整消息须携带累积的全部内容（修复：原先恒为空串）
        content: fullContent,
        timestamp: Date.now(),
        model,
        // 会话归属标记：前端按 sessionId 过滤跨会话事件（多会话并行防串扰）
        sessionId,
      };
      if (attachments) assistantMessage.attachments = attachments;
      this.ws.broadcastToSession(sessionId, {
        type: 'chat_stream',
        data: { sessionId, content: '', done: true, message: assistantMessage },
      });
      this.ws.broadcastToSession(sessionId, { type: 'chat_message', data: assistantMessage });

      const done: ChatStreamChunk = { type: 'done' };
      if (usage) done.usage = usage;
      yield done;
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async recordTurnError(request: ChatRequest, error: string): Promise<void> {
    if (!request.turnId || !this.session) return;
    const id = `${request.turnId}:status`;
    // The loop records cancellation explicitly. Never reinterpret a network error as a stop.
    if (this.session.getMessages(request.session).some(message => message.id === id)) return;
    const message: ChatMessage = {id, role: 'system', sessionId: request.session, turnId: request.turnId,
      turnSequence: Number.MAX_SAFE_INTEGER, phase: 'status', turnStatus: 'failed', content: error, timestamp: Date.now()};
    this.session.addMessage(request.session, message);
    await this.session.flush?.();
    this.ws.broadcastToSession(request.session, {type: 'chat_message', data: message});
  }

  isActive(sessionId: string): boolean { return this.agentLoop.isSessionRunning(sessionId); }

  /** 获取会话历史消息 */
  getHistory(sessionId: string): ChatMessage[] {
    if (this.session) {
      try {
        return this.session.getMessages(sessionId);
      } catch (err) {
        this.logger.warn('Failed to read session history', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return [];
  }
}