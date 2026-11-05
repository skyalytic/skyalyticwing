import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { BreakerService, type BreakerStatusItem } from './breaker.service.js';
import { BreakerResetDto } from '../../tools/dto/mcporter.dto.js';

/**
 * 熔断器 REST API（路由前缀 /api）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET  /api/breaker-status - 熔断器状态列表
 *   POST /api/breaker-reset  - 重置单个/全部熔断器
 */
@Controller()
export class BreakerController {
  constructor(private readonly breaker: BreakerService) {}

  /** GET /breaker-status */
  @Get('breaker-status')
  status(): { breakers: BreakerStatusItem[] } {
    return { breakers: this.breaker.getStatus() };
  }

  /** POST /breaker-reset — body { tool? }，缺省重置全部 */
  @Post('breaker-reset')
  @HttpCode(HttpStatus.OK)
  reset(@Body() dto: BreakerResetDto) {
    const tool = dto?.tool || null;
    this.breaker.reset(tool || undefined);
    return {
      success: true,
      message: tool ? `熔断器 ${tool} 已重置` : '所有熔断器已重置',
    };
  }
}
