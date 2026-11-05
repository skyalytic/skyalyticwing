import { Injectable, OnModuleInit } from '@nestjs/common';
import { arch, freemem, homedir, hostname, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { LoggerService } from '../logger/logger.service.js';
import { resolveAppVersion } from '../utils/app-version.util.js';

/**
 * SystemService - 系统信息与杂项 P2 路由服务
 *
 * 移植自 start.cjs：
 *   - 行 38577-38603  GET /health（健康检查 + 运行时信息）
 *   - 行 39560-39578  GET /system/info（系统信息快照）
 *
 * 暴露：
 *   - getHealth()：健康检查（status/timestamp/uptime/requests/version/platform/memoryUsage/providers/agents）
 *   - getSystemInfo()：系统信息（platform/arch/hostname/nodeVersion/version/uptime/memory/pid/totalRequests/dataDir/subAgents/pluginsLoaded/vectorEmbeddings）
 */
export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  requests: number;
  version: string;
  platform: string;
  nodeVersion: string;
  memoryUsage: string;
  providers: number;
  agents: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  hostname: string;
  nodeVersion: string;
  version: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  pid: number;
  totalRequests: number;
  dataDir: string;
  subAgents: number;
  pluginsLoaded: number;
  vectorEmbeddings: number;
  totalMem: number;
  freeMem: number;
}

/** 应用版本回退值 */
const FALLBACK_VERSION = resolveAppVersion();

/** 启动时间戳，用于计算 uptime */
const START_TIME = Date.now();

@Injectable()
export class SystemService implements OnModuleInit {
  private version = FALLBACK_VERSION;
  /** 请求计数器（与 .cjs requestCounter 对齐） */
  private requestCounter = 0;

  constructor(
    private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    this.logger.info('SystemService: initialized', { version: this.version });
  }

  /** 累加请求计数（可由中间件调用） */
  incrementRequestCount(): void {
    this.requestCounter++;
  }

  /** 获取请求计数 */
  getRequestCount(): number {
    return this.requestCounter;
  }

  /** 获取应用版本（供 /status/full、/update/check 等聚合端点使用） */
  getVersion(): string {
    return this.version;
  }

  /**
   * 健康检查快照（移植自 .cjs GET /health 行 38577-38603）。
   *
   * 入参 configuredProviders / agentCount 由控制器从相应服务注入，
   * 保持 SystemService 与具体域解耦。
   */
  getHealth(configuredProviders: number = 0, agentCount: number = 0): HealthSnapshot {
    const heapUsed = process.memoryUsage().heapUsed;
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      requests: this.requestCounter,
      version: this.version,
      platform: platform(),
      nodeVersion: process.version,
      memoryUsage: Math.round(heapUsed / 1024 / 1024) + 'MB',
      providers: configuredProviders,
      agents: agentCount,
    };
  }

  /**
   * 系统信息快照（移植自 .cjs GET /system/info 行 39560-39578）。
   *
   * 入参 subAgents / pluginsLoaded / vectorEmbeddings 由控制器从相应服务注入，
   * 保持 SystemService 与具体域解耦。
   */
  getSystemInfo(
    subAgents: number = 0,
    pluginsLoaded: number = 0,
    vectorEmbeddings: number = 0,
  ): SystemInfo {
    return {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      nodeVersion: process.version,
      version: this.version,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      memory: process.memoryUsage(),
      pid: process.pid,
      totalRequests: this.requestCounter,
      dataDir: this.resolveDataDir(),
      subAgents,
      pluginsLoaded,
      vectorEmbeddings,
      totalMem: totalmem(),
      freeMem: freemem(),
    };
  }

  /** 解析数据目录路径（与 .cjs DATA_DIR 对齐） */
  private resolveDataDir(): string {
    const env = process.env['SKYALYTICWING_DATA_DIR'];
    if (env) return env;
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
