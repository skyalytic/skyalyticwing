import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module.js';
import { HealthService } from './health.service.js';
import { FileWatcherService } from './file-watcher.service.js';
import { ToolAuditService } from './tool-audit.service.js';
import { MonitorController } from './monitor.controller.js';

/**
 * MonitorModule - 监控域模块
 *
 * 依赖：
 *   - SessionModule（提供 SessionService 用于会话计数）
 *   - LoggerService / WebSocketService / SecurityManagerService /
 *     ToolRegistryService / ConfigService 均由各自全局模块提供。
 */
@Module({
  imports: [SessionModule],
  providers: [HealthService, FileWatcherService, ToolAuditService],
  controllers: [MonitorController],
  exports: [HealthService, FileWatcherService, ToolAuditService],
})
export class MonitorModule {}
