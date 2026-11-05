import { Module } from '@nestjs/common';
import { MandatoryUpdateService } from './mandatory-update.service.js';
import { VersionController } from './version.controller.js';

/**
 * VersionModule - 版本与强制更新策略模块
 *
 * MandatoryUpdateService 周期轮询远端版本清单并维护阻断决策；
 * VersionController 暴露状态/手动检查/配置端点（前端强制更新遮罩数据源）。
 * 未配置（enabled=false 或 manifestUrl 为空）时整体静默禁用，不影响现有更新通道。
 */
@Module({
  providers: [MandatoryUpdateService],
  controllers: [VersionController],
  exports: [MandatoryUpdateService],
})
export class VersionModule {}
