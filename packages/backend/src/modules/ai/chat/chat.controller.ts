import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Optional,
} from '@nestjs/common';
import type { ApiResponse, ChatMessage, ChatRequest, ChatResponse } from '@skyalyticwing/shared';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import { ChatService } from './chat.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { deduplicateMessageMedia } from '../../core/utils/media-attachments.util.js';

/**
 * 聊天 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('chat') 实际路由为 /api/chat。
 *
 * 暴露端点：
 *   POST /api/chat/send             - 发送消息（非流式，返回完整 ChatResponse）
 *   GET  /api/chat/history/:sessionId - 获取会话历史消息
 *
 * 注：流式响应通过 WebSocketService 广播（ChatService.streamMessage），
 * WebSocket 网关可调用 streamMessage 实现实时推送。
 */
@ApiTags('Chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService, @Optional() private readonly security?: SecurityManagerService) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: SendMessageDto): Promise<ApiResponse<ChatResponse>> {
    const request: ChatRequest = { session: dto.session, message: dto.message };
    if (dto.model !== undefined) request.model = dto.model;
    if (dto.agent !== undefined) request.agent = dto.agent;
    if (dto.turnId) request.turnId = dto.turnId;
    if (dto.stream !== undefined) request.stream = dto.stream;
    if (dto.attachments !== undefined) request.attachments = dto.attachments;

    try {
      const response = await this.chatService.sendMessage(request);
      return { success: true, data: response };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Get('status/:sessionId')
  status(@Param('sessionId') sessionId: string): ApiResponse<{active: boolean}> {
    return {success: true, data: {active: this.chatService.isActive(sessionId)}};
  }

  @Get('history/:sessionId')
  async history(@Param('sessionId') sessionId: string): Promise<ApiResponse<ChatMessage[]>> {
    return { success: true, data: await deduplicateMessageMedia(this.chatService.getHistory(sessionId), path => this.security?.isPathAllowed(path, 'read') === true) };
  }
}
