import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { QueueService } from './queue.service.js';
import { EnqueueDto } from './dto/queue.dto.js';

/**
 * Queue 消息队列 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET  /api/queue/stats    - 队列统计
 *   GET  /api/queue/list     - 任务列表
 *   POST /api/queue/enqueue  - 入队
 *   POST /api/queue/clear    - 清空
 *   POST /api/queue/dequeue  - 出队执行
 */
@Controller()
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('queue/stats')
  stats(): Record<string, unknown> {
    return this.queueService.getStats() as unknown as Record<string, unknown>;
  }

  @Get('queue/list')
  list(): Record<string, unknown> {
    return this.queueService.list();
  }

  @Post('queue/enqueue')
  @HttpCode(HttpStatus.CREATED)
  enqueue(@Body() dto: EnqueueDto): Record<string, unknown> {
    const item = this.queueService.enqueue(dto.message, dto.priority ?? 'normal');
    return { success: true, item };
  }

  @Post('queue/clear')
  @HttpCode(HttpStatus.OK)
  clear(): Record<string, unknown> {
    return this.queueService.clear();
  }

  @Post('queue/dequeue')
  @HttpCode(HttpStatus.OK)
  dequeue(): Record<string, unknown> {
    return this.queueService.dequeue();
  }
}
