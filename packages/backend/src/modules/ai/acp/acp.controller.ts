import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import type { ApiResponse } from '@skyalyticwing/shared';
import { AcpService } from './acp.service.js';
import type { AcpSession, AcpSessionConfig } from '../types.js';

/**
 * ACP REST API（实际路由前缀 /api/acp）
 *
 * 暴露端点：
 *   POST   /api/acp/session            - 创建 ACP 会话
 *   POST   /api/acp/session/:id/message - 在会话内发送消息
 *   DELETE /api/acp/session/:id        - 取消会话
 *
 * 扩展端点（对齐旧版 start.cjs）：
 *   GET    /api/acp/status             - ACP 状态汇总
 *   GET    /api/acp/sessions           - 会话列表
 *   DELETE /api/acp/sessions           - 删除会话（body 传 sessionId）
 *   GET    /api/acp/stream             - 事件流（SSE）
 *   GET    /api/acp/events             - 事件轮询（after_cursor/limit）
 *   POST   /api/acp/approvals/classify - 审批分类
 *   POST   /api/acp/session/load       - 加载会话
 *   POST   /api/acp/session/resume     - 恢复会话（429 并发限制）
 *   PUT    /api/acp                    - 更新 ACP 配置（旧版）
 *   POST   /api/acp/request            - 旧版统一消息入口（method+params）
 */

/** 审批分类请求体 */
class ApprovalsClassifyDto {
  @IsOptional()
  @IsString()
  toolName?: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

/** 会话 load/resume 请求体 */
class SessionIdDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;
}

/** 更新 ACP 配置请求体（旧版 PUT /acp） */
class UpdateAcpConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  port?: number;

  @IsOptional()
  @IsObject()
  allowedAgents?: unknown;

  @IsOptional()
  @IsBoolean()
  autoApproveReadonly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsObject()
  stream?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  sessionCreateRateLimit?: Record<string, unknown>;
}

/** 旧版统一请求入口请求体（POST /acp/request） */
class AcpRequestDto {
  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

/** 事件轮询查询参数 */
class EventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  after_cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

/** 删除会话请求体 */
class DeleteSessionDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;
}

@Controller('acp')
export class AcpController {
  constructor(private readonly acp: AcpService) {}

  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: AcpSessionConfig): ApiResponse<AcpSession> {
    return { success: true, data: this.acp.createSession(body ?? {}) };
  }

  @Post('session/:id/message')
  @HttpCode(HttpStatus.OK)
  async send(
    @Param('id') id: string,
    @Body('message') message: string,
  ): Promise<ApiResponse<{ content: string }>> {
    if (typeof message !== 'string' || message.length === 0) {
      return { success: false, error: 'Field "message" is required' };
    }
    try {
      const content = await this.acp.sendMessage(id, message);
      return { success: true, data: { content } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Delete('session/:id')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string): ApiResponse<{ id: string; status: string }> {
    this.acp.cancelSession(id);
    return { success: true, data: { id, status: 'cancelled' } };
  }

  // ════════════════════════════════════════════════════════════════
  // 扩展端点（对齐旧版 start.cjs）
  // ════════════════════════════════════════════════════════════════

  @Get('status')
  status(): Record<string, unknown> {
    return this.acp.getStatus();
  }

  @Get('sessions')
  sessions(): { sessions: Array<Record<string, unknown>> } {
    return { sessions: this.acp.listCompatSessions() };
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.OK)
  removeSession(@Body() body: DeleteSessionDto): { success: boolean } {
    this.acp.removeCompatSession(body?.sessionId ?? '');
    return { success: true };
  }

  @Get('stream')
  stream(@Res() res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', server: 'SkyalyticWing-ACP' })}\n\n`);
    this.acp.addSSEClient(res);
    res.on('close', () => {
      this.acp.removeSSEClient(res);
    });
  }

  @Get('events')
  events(@Query() query: EventsQueryDto): { events: unknown[]; nextCursor: number } {
    return this.acp.pollAcpEvents(query?.after_cursor || 0, query?.limit || 20);
  }

  @Post('approvals/classify')
  @HttpCode(HttpStatus.OK)
  classify(@Body() body: ApprovalsClassifyDto): { classification: { approvalClass: string; autoApprove: boolean } } {
    return { classification: this.acp.classifyApproval(body?.toolName ?? '', body?.args) };
  }

  @Post('session/load')
  @HttpCode(HttpStatus.OK)
  loadSession(@Body() body: SessionIdDto, @Res() res: Response): void {
    const session = this.acp.loadSessionDetail(body?.sessionId ?? '');
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(200).json({ success: true, session });
  }

  @Post('session/resume')
  @HttpCode(HttpStatus.OK)
  resumeSession(@Body() body: SessionIdDto, @Res() res: Response): void {
    if (!this.acp.isConcurrentSessionAvailable()) {
      res.status(429).json({
        error: 'Max concurrent sessions reached',
        maxConcurrentSessions: this.acp.getMaxConcurrentSessions(),
        activeSessions: this.acp.getActiveSessionCount(),
      });
      return;
    }
    const result = this.acp.resumeSessionById(body?.sessionId ?? '');
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json(result);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  updateConfig(@Body() body: UpdateAcpConfigDto): { success: boolean; config: Record<string, unknown> } {
    const config = this.acp.updateConfig((body ?? {}) as unknown as Record<string, unknown>);
    return { success: true, config };
  }

  @Post('request')
  @HttpCode(HttpStatus.OK)
  async request(@Body() body: AcpRequestDto): Promise<Record<string, unknown>> {
    return this.acp.handleAcpRequest(body ?? {});
  }
}
