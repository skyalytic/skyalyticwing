import { Module } from '@nestjs/common';
import { CronService } from './cron.service.js';
import { CronDeliveryService } from './cron-delivery.service.js';
import { CronController } from './cron.controller.js';

/**
 * CronModule - 定时任务模块
 *
 * 依赖 LoggerService / WebSocketService / SecurityManagerService（由各自全局模块提供）。
 */
@Module({
  providers: [CronService, CronDeliveryService],
  controllers: [CronController],
  exports: [CronService, CronDeliveryService],
})
export class CronModule {}
