import { Controller, Get, Query, Optional } from '@nestjs/common';
import { ToolAuditService } from './tool-audit.service.js';
import type { ApiResponse } from '@skyalyticwing/shared';
import type { LogEntry } from '../core/logger/logger.service.js';
import { HealthService, type HealthStatus, type MonitorStats } from './health.service.js';

/**
 * 监控 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('monitor') 实际路由为 /api/monitor。
 *
 * 暴露端点：
 *   GET /api/monitor/health - 健康状态
 *   GET /api/monitor/logs   - 获取日志（支持 level、limit 查询参数）
 *   GET /api/monitor/stats   - 统计信息
 *
 * FileWatcherService 供其它服务以编程方式调用（watch/unwatch），不通过 REST 暴露。
 */
@Controller('monitor')
export class MonitorController {
  constructor(
    private readonly healthService: HealthService,
    @Optional() private readonly audit?: ToolAuditService,
  ) {}

  @Get('audit')
  auditLog(@Query('limit') limit?: string) {
    return { success: true, data: this.audit?.recent(Number(limit || 100)) ?? [] };
  }

  @Get('health')
  health(): ApiResponse<HealthStatus> {
    return { success: true, data: this.healthService.getHealth() };
  }

  @Get('logs')
  logs(@Query('level') level?: string, @Query('limit') limit?: string): ApiResponse<LogEntry[]> {
    const lim = limit !== undefined ? parseInt(limit, 10) : undefined;
    return {
      success: true,
      data: this.healthService.getLogs(level, lim),
    };
  }

  @Get('stats')
  stats(): ApiResponse<MonitorStats> {
    return { success: true, data: this.healthService.getStats() };
  }
}
