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
} from '@nestjs/common';
import type {
  ApiResponse,
  ChannelConfig,
  ChannelMessage,
  ChannelStatusInfo,
} from '@skyalyticwing/shared';
import { ApiTags } from '../core/swagger/swagger-decorators.js';
import { ChannelsService } from './channels.service.js';
import {
  CreateChannelDto,
  SendChannelMessageDto,
  UpdateChannelDto,
} from './dto/channel.dto.js';

/**
 * 渠道 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('channels') 实际路由为 /api/channels。
 *
 * 暴露端点：
 *   GET    /api/channels               - 列出渠道
 *   POST   /api/channels               - 添加渠道
 *   PUT    /api/channels/:id           - 更新渠道
 *   DELETE /api/channels/:id           - 删除渠道
 *   POST   /api/channels/:id/connect   - 连接渠道
 *   POST   /api/channels/:id/disconnect - 断开渠道
 *   POST   /api/channels/:id/reload    - 重载渠道（断开后用新配置重连）
 *   POST   /api/channels/:id/send      - 发送消息
 *   GET    /api/channels/:id/messages  - 获取渠道消息
 *   GET    /api/channels/status        - 获取所有渠道 provider 状态快照
 *
 * 响应均通过 ChannelStatusInfo 返回，不含 credentials 等敏感字段。
 */
@ApiTags('Channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  list(): ApiResponse<ChannelStatusInfo[]> {
    return { success: true, data: this.channelsService.listChannels() };
  }

  @Get('status')
  allStatus(): ApiResponse<Record<string, unknown>> {
    return { success: true, data: this.channelsService.getAllStatus() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(@Body() dto: CreateChannelDto): ApiResponse<{ id: string }> {
    const config: ChannelConfig = {
      id: dto.id,
      type: dto.type as ChannelConfig['type'],
      name: dto.name,
      enabled: dto.enabled ?? true,
      credentials: dto.credentials ?? {},
      ...(dto.options !== undefined ? { options: dto.options } : {}),
    };
    this.channelsService.addChannel(config);
    return { success: true, data: { id: dto.id } };
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
    @Query('background') background?: string,
  ): Promise<ApiResponse<{ updated: boolean; channel: ChannelStatusInfo }>> {
    const channel = await this.channelsService.saveChannel(id, dto, background === 'true');
    return { success: true, data: { updated: true, channel } };
  }

  @Get(':id/config')
  configuration(@Param('id') id: string) {
    return { success: true, data: this.channelsService.getConfiguration(id) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    await this.channelsService.removeChannel(id);
    return { success: true, data: { deleted: true } };
  }

  @Post(':id/connect')
  @HttpCode(HttpStatus.OK)
  async connect(@Param('id') id: string): Promise<ApiResponse<{ connected: boolean }>> {
    try {
      await this.channelsService.connectChannel(id);
      return { success: true, data: { connected: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Param('id') id: string): Promise<ApiResponse<{ disconnected: boolean }>> {
    await this.channelsService.disconnectChannel(id);
    return { success: true, data: { disconnected: true } };
  }

  @Post(':id/reload')
  @HttpCode(HttpStatus.OK)
  async reload(
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
  ): Promise<ApiResponse<{ reloaded: boolean }>> {
    const result = await this.channelsService.reloadChannel(id, dto);
    if (!result.success) {
      if (result.error) {
        return { success: false, error: result.error };
      }
      return { success: false };
    }
    return { success: true, data: { reloaded: true } };
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  async send(
    @Param('id') id: string,
    @Body() dto: SendChannelMessageDto,
  ): Promise<ApiResponse<{ sent: boolean }>> {
    try {
      await this.channelsService.sendMessage(id, dto.target, dto.content);
      return { success: true, data: { sent: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Get(':id/messages')
  messages(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): ApiResponse<ChannelMessage[]> {
    const lim = limit !== undefined ? parseInt(limit, 10) : undefined;
    return {
      success: true,
      data: this.channelsService.getMessages(id, lim),
    };
  }
}
