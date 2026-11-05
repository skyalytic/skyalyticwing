import { Injectable, OnModuleInit } from '@nestjs/common';
import type { LogEntry } from '../core/logger/logger.service.js';
import { LoggerService } from '../core/logger/logger.service.js';
import { WebSocketService } from '../core/websocket/websocket.service.js';
import { SessionService } from '../session/session.service.js';
import { ToolRegistryService } from '../tools/executor/tool-registry.service.js';
import { resolveAppVersion } from '../core/utils/app-version.util.js';

/** 健康状态 */
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  version: string;
}

/** 统计信息 */
export interface MonitorStats {
  sessions: number;
  tools: number;
  connections: number;
  memory: NodeJS.MemoryUsage;
}

/** 应用版本（monorepo 根 package.json，见 app-version.util） */
const FALLBACK_VERSION = resolveAppVersion();

/** 启动时间戳，用于计算 uptime */
const START_TIME = Date.now();

/**
 * HealthService - 健康检查与监控统计
 *
 * 职责：
 *   - getHealth：返回健康状态、运行时长、版本
 *   - getLogs：从 LoggerService 内存缓冲获取日志（支持级别过滤与数量限制）
 *   - getStats：返回会话数、工具数、连接数、内存用量
 */
@Injectable()
export class HealthService implements OnModuleInit {
  private version = FALLBACK_VERSION;

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly sessionService: SessionService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  onModuleInit(): void {
    // 应用版本唯一事实源：monorepo 根 package.json（与 tauri.conf.json 一致）。
    // 不用 config.version——其默认值 '1.0.0' 是配置文件模板值，非应用版本（曾致监控页显示错误版本）。
    this.version = resolveAppVersion();
  }

  /** 健康状态：当前实现始终返回 ok（无外部依赖探测） */
  getHealth(): HealthStatus {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      version: this.version,
    };
  }

  /** 获取日志（从 LoggerService 内存缓冲） */
  getLogs(level?: string, limit?: number): LogEntry[] {
    return this.logger.getLogs(level, limit);
  }

  /** 统计信息 */
  getStats(): MonitorStats {
    return {
      sessions: this.sessionService.listSessions().length,
      tools: this.toolRegistry.getAll().length,
      connections: this.ws.getConnectionCount(),
      memory: process.memoryUsage(),
    };
  }
}
