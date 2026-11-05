import { Module } from '@nestjs/common';
import { RemoteService } from './remote.service.js';
import { RemoteController } from './remote.controller.js';

/**
 * RemoteModule - 分布式远程节点模块
 *
 * 依赖 LoggerService（由全局 LoggerModule 提供）。
 */
@Module({
  providers: [RemoteService],
  controllers: [RemoteController],
  exports: [RemoteService],
})
export class RemoteModule {}
