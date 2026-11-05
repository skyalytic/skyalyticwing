import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { DaemonService, type DaemonStatus, type LogEntry } from './daemon.service.js';

/**
 * 守护进程 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('daemon') 实际路由为 /api/daemon。
 *
 * 暴露端点：
 *   POST /api/daemon/install    - 安装守护进程（危险）
 *   POST /api/daemon/uninstall  - 卸载守护进程（危险）
 *   POST /api/daemon/start      - 启动守护进程（危险）
 *   POST /api/daemon/stop       - 停止守护进程（危险）
 *   POST /api/daemon/restart    - 重启守护进程（危险，stop + start 组合）
 *   GET  /api/daemon/status     - 获取守护进程状态
 *   POST /api/daemon/autostart  - 设置自启动
 *
 * 注意：install/uninstall/start/stop 为危险操作，调用方需显式确认。
 */
@Controller('daemon')
export class DaemonController {
  constructor(private readonly daemonService: DaemonService) {}

  @Post('install')
  @HttpCode(HttpStatus.OK)
  async install(): Promise<ApiResponse<{ installed: boolean }>> {
    try {
      await this.daemonService.install();
      return { success: true, data: { installed: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('uninstall')
  @HttpCode(HttpStatus.OK)
  async uninstall(): Promise<ApiResponse<{ uninstalled: boolean }>> {
    try {
      await this.daemonService.uninstall();
      return { success: true, data: { uninstalled: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(): Promise<ApiResponse<{ started: boolean }>> {
    try {
      await this.daemonService.start();
      return { success: true, data: { started: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(): Promise<ApiResponse<{ stopped: boolean }>> {
    try {
      await this.daemonService.stop();
      return { success: true, data: { stopped: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** POST /daemon/restart — 重启守护进程（service.restart = stop + start 组合） */
  @Post('restart')
  @HttpCode(HttpStatus.OK)
  restart(): ApiResponse<{ restarted: boolean }> {
    try {
      const result = this.daemonService.restart();
      if (!result.success) {
        return { success: false, error: result.error ?? 'Failed to restart daemon' };
      }
      return { success: true, data: { restarted: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** GET /daemon/status — 异步查询（不阻塞事件循环；Windows 平台命令经 runCmdAsync 并行执行） */
  @Get('status')
  async status(): Promise<ApiResponse<DaemonStatus>> {
    return { success: true, data: await this.daemonService.getStatusAsync() };
  }

  @Post('autostart')
  @HttpCode(HttpStatus.OK)
  autostart(@Body() body: { enabled: boolean }): ApiResponse<{ set: boolean }> {
    this.daemonService.setAutoStart(Boolean(body?.enabled));
    return { success: true, data: { set: true } };
  }

  /** GET /daemon/manager/logs — 守护进程日志（旧版 /api/daemon/manager/logs 兼容路径） */
  @Get('manager/logs')
  managerLogs(@Query('lines') lines?: string): { ok: boolean; logs: LogEntry[] } {
    const lineCount = parseInt(lines || '50', 10);
    const safeLines =
      Number.isFinite(lineCount) && lineCount > 0 && lineCount <= 500 ? lineCount : 50;
    return { ok: true, logs: this.daemonService.getLogs(undefined, safeLines) };
  }
}
