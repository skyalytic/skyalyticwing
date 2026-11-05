import { Module } from '@nestjs/common';
import { DaemonService } from './daemon.service.js';
import { DaemonController } from './daemon.controller.js';

/**
 * DaemonModule - 守护进程模块
 *
 * 依赖 LoggerService（由全局 LoggerModule 提供）。
 */
@Module({
  providers: [DaemonService],
  controllers: [DaemonController],
  exports: [DaemonService],
})
export class DaemonModule {}
