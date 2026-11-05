// Webhook 入口：外部系统通过 HTTP POST 触发指定会话的 AI 对话
// 可选令牌校验：配置 general.webhookToken 后
// 请求须携带 header x-webhook-token 或 query token 匹配。
// 注意：sendMessage 会同步运行完整 AgentLoop（长任务可能耗时较久），调用方应设置足够超时。
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Module, Param, Post } from '@nestjs/common';
import { ApiTags } from '../core/swagger/swagger-decorators.js';
import { ChatModule } from '../ai/chat/chat.module.js';
import { ChatService } from '../ai/chat/chat.service.js';
import { ConfigService } from '../core/config/config.service.js';
import type { ChatResponse } from '@skyalyticwing/shared';

interface WebhookTriggerDto {
  message: string;
  model?: string;
  agent?: string;
}

@ApiTags('Webhook')
@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly chat: ChatService,
    private readonly config: ConfigService,
  ) {}

  /** GET /api/webhook — 使用说明（浏览器可直接访问） */
  @Get()
  usage(): { usage: string } {
    return {
      usage:
        'POST /api/webhook/:sessionId  body { "message": "...", "model"?: "...", "agent"?: "..." }' +
        '；若配置了 general.webhookToken，须携带请求头 x-webhook-token',
    };
  }

  /** POST /api/webhook/:sessionId — 以指定会话身份触发一轮 AI 对话 */
  @Post(':sessionId')
  @HttpCode(HttpStatus.OK)
  async trigger(
    @Param('sessionId') sessionId: string,
    @Headers('x-webhook-token') webhookToken: string | undefined,
    @Body() dto: WebhookTriggerDto,
  ): Promise<{ success: boolean; data: { sessionId: string; reply: ChatResponse['message'] } }> {
    // 可选令牌校验：设置了 general.webhookToken 后强制匹配
    const expected = String(
      this.config.get<Record<string, unknown>>('general')?.['webhookToken'] ?? '',
    );
    if (expected && webhookToken !== expected) {
      throw new ForbiddenException('x-webhook-token 不匹配');
    }
    if (!dto?.message || typeof dto.message !== 'string') {
      throw new BadRequestException('message required');
    }
    const resp = await this.chat.sendMessage({
      session: sessionId,
      message: dto.message,
      ...(dto.model !== undefined ? { model: dto.model } : {}),
      ...(dto.agent !== undefined ? { agent: dto.agent } : {}),
    });
    return { success: true, data: { sessionId: resp.sessionId, reply: resp.message } };
  }
}

@Module({
  imports: [ChatModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
