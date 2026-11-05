import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChatControlService } from './chat-control.service.js';
import {
  ChatStopDto,
  CompactDto,
  MicroCompactDto,
  SteerDto,
} from './dto/chat-control.dto.js';

/**
 * Chat 控制 REST API（实际路由前缀 /api）
 *
 * 移植自 start.cjs：
 *   POST /api/chat/stop     - 停止当前生成（行 39293-39329）
 *   POST /api/compact       - 会话压缩（行 37242-37296）
 *   POST /api/micro-compact - 微压缩（行 40289-40319）
 *   POST /api/steer         - 会话引导（行 39391-39422）
 */
@Controller()
export class ChatControlController {
  constructor(
    private readonly chatControl: ChatControlService,
    private readonly logger: LoggerService,
  ) {}

  @Post('chat/stop')
  @HttpCode(HttpStatus.OK)
  stop(@Body() dto: ChatStopDto): ApiResponse<{ aborted: boolean; sessions: string[] }> {
    const sessionId = dto?.sessionId || dto?.session || undefined;
    const result = this.chatControl.stop(sessionId);
    return { success: true, data: { aborted: result.aborted, sessions: result.sessions } };
  }

  @Post('compact')
  @HttpCode(HttpStatus.OK)
  async compact(@Body() dto: CompactDto): Promise<ApiResponse<unknown>> {
    const sessionId = dto?.sessionId || dto?.id || 'default';
    const result = await this.chatControl.compact(sessionId, dto?.model);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Compaction failed' };
    }
    return { success: true, data: result };
  }

  @Post('micro-compact')
  @HttpCode(HttpStatus.OK)
  microCompact(@Body() dto: MicroCompactDto): ApiResponse<unknown> {
    const sessionId = dto?.sessionId || 'default';
    const result = this.chatControl.microCompact(sessionId);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Micro-compact failed' };
    }
    return { success: true, data: result };
  }

  @Post('steer')
  @HttpCode(HttpStatus.OK)
  steer(@Body() dto: SteerDto): ApiResponse<unknown> {
    if (!dto?.session || !dto?.message) {
      return { success: false, error: '需要session和message' };
    }
    this.logger.info('Steer requested', { session: dto.session });
    const result = this.chatControl.steer(dto.session, dto.message);
    return { success: true, data: result };
  }
}
