import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { CliController } from './cli.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatControlService } from './chat-control.service.js';
import { ChatControlController } from './chat-control.controller.js';
import { LlmModule } from '../llm/llm.module.js';
import { AgentModule } from '../agent/agent.module.js';

/**
 * ChatModule - 聊天模块
 *
 * 提供：
 *   - ChatService（聊天服务，非流式 + 流式，通过 AgentLoop 支持工具调用）
 *   - ChatGateway（/ws/chat 路径的 WebSocket 流式推送网关）
 *   - ChatControlService / ChatControlController（/chat/stop、/compact、
 *     /micro-compact、/steer 聊天控制端点，移植自 start.cjs）
 *
 * 依赖 LlmModule 获取 LLMClientService；
 * 依赖 AgentModule 获取 AgentLoopService（harness 核心循环）；
 * WebSocketService / LoggerService / ConfigService 由全局模块提供。
 */
@Module({
  imports: [LlmModule, AgentModule],
  providers: [ChatService, ChatGateway, ChatControlService],
  controllers: [ChatController, ChatControlController, CliController],
  exports: [ChatService, ChatGateway, ChatControlService],
})
export class ChatModule {}
