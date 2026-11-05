import { Module } from '@nestjs/common';
import { QueueService } from './queue.service.js';
import { QueueController } from './queue.controller.js';

/**
 * QueueModule - 消息队列模块
 *
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [QueueService],
  controllers: [QueueController],
  exports: [QueueService],
})
export class QueueModule {}
