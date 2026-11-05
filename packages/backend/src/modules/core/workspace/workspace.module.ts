import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { WorkspaceController } from './workspace.controller.js';

/**
 * WorkspaceModule - 工作区模块
 *
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [WorkspaceService],
  controllers: [WorkspaceController],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
