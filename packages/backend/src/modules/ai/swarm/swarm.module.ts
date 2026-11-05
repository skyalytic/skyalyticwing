import { Module } from '@nestjs/common';
import { SwarmService } from './swarm.service.js';
import { SwarmController } from './swarm.controller.js';

/**
 * SwarmModule - 蜂群（多代理协作编排）模块
 *
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [SwarmService],
  controllers: [SwarmController],
  exports: [SwarmService],
})
export class SwarmModule {}
