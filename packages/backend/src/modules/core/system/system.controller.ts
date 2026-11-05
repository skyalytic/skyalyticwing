import { Controller, Get, HttpCode, HttpStatus, Inject, Optional, Post } from '@nestjs/common';
import { arch, cpus, hostname, platform } from 'node:os';
import type { ApiResponse } from '@skyalyticwing/shared';
import { SystemService, type HealthSnapshot, type SystemInfo } from './system.service.js';
import { UsageService, type UsageSnapshot } from './usage.service.js';
import { DepsService, type DepsCheckResult } from './deps.service.js';
import { WebSocketService } from '../websocket/websocket.service.js';
import { AgentService } from '../../ai/agent/agent.service.js';
import { AgentSwarmService } from '../../ai/agent/agent-swarm.service.js';
import { ProviderService } from '../../ai/llm/provider.service.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { CronService, type CronStatus } from '../../channels/cron/cron.service.js';
import { TOOL_EXECUTOR_SERVICE, type IToolExecutorService } from '../../ai/types.js';

/** 更新检查响应（对齐 .cjs /update/check 行 38562-38576） */
interface UpdateCheckResult {
  currentVersion: string;
  minVersion: string;
  forceUpdate: boolean;
  downloadUrl: string;
  message: string;
}

/** 完整系统状态（对齐 .cjs /status/full 行 41615-41671 的核心字段） */
interface StatusFull {
  version: string;
  appDir: string;
  uptime: number;
  system: {
    platform: string;
    arch: string;
    hostname: string;
    memory: NodeJS.MemoryUsage;
    cpu: number;
  };
  api: { totalRequests: number };
  websocket: { clients: number; active: boolean };
  agents: { total: number; subAgentsActive: number };
  tools: { total: number; implemented: number };
  providers: { total: number; configured: number };
  channels: { total: number; enabled: number };
  cron: CronStatus;
  usage: UsageSnapshot;
}

/**
 * System REST API（实际路由前缀 /api）
 *
 * 暴露 P2 杂项端点（与 .cjs 行为对齐）：
 *   GET  /api/health        - 健康检查（.cjs 行 38577-38603）
 *   GET  /api/system/info   - 系统信息快照（.cjs 行 39560-39578）
 *   GET  /api/usage         - 用量统计（.cjs 行 39427-39430，usage.json）
 *   GET  /api/status/full   - 完整系统状态聚合（.cjs 行 41615-41671）
 *   GET  /api/update/check  - 检查更新（.cjs 行 38562-38576）
 *   GET  /api/deps/check    - 依赖检查（.cjs 行 38605-38625）
 *   POST /api/deps/install  - 安装依赖（.cjs 行 38713-38734）
 *   GET  /api/deps/report   - 依赖报告（.cjs 行 38735-38738）
 *
 * 注：/api/monitor/health 已由 MonitorController 提供（更详细的健康状态），
 * 此处 /api/health 保留以兼容旧版前端轮询路径。
 */
@Controller()
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly usageService: UsageService,
    private readonly depsService: DepsService,
    private readonly ws: WebSocketService,
    private readonly agentService: AgentService,
    private readonly swarm: AgentSwarmService,
    private readonly providerService: ProviderService,
    private readonly channelsService: ChannelsService,
    private readonly cronService: CronService,
    @Optional() @Inject(TOOL_EXECUTOR_SERVICE) private readonly toolExecutor?: IToolExecutorService,
  ) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  health(): ApiResponse<HealthSnapshot> {
    return { success: true, data: this.systemService.getHealth() };
  }

  @Get('system/info')
  @HttpCode(HttpStatus.OK)
  systemInfo(): ApiResponse<SystemInfo> {
    return { success: true, data: this.systemService.getSystemInfo() };
  }

  /** 用量统计（token / 请求次数 / 按供应商聚合，读取 usage.json） */
  @Get('usage')
  @HttpCode(HttpStatus.OK)
  usage(): ApiResponse<UsageSnapshot> {
    return { success: true, data: this.usageService.getUsage() };
  }

  /** 完整系统状态聚合 */
  @Get('status/full')
  @HttpCode(HttpStatus.OK)
  statusFull(): ApiResponse<StatusFull> {
    let toolTotal = 0;
    if (this.toolExecutor) {
      try {
        toolTotal = this.toolExecutor.getToolDefinitions().length;
      } catch {
        toolTotal = 0;
      }
    }

    let agentTotal = 0;
    try {
      agentTotal = this.agentService.listAgents().length;
    } catch {
      agentTotal = 0;
    }

    const providers = this.providerService.listProviders().providers;
    const channels = this.channelsService.listChannels();

    return {
      success: true,
      data: {
        version: this.systemService.getVersion(),
        appDir: process.cwd(),
        uptime: Math.floor(process.uptime()),
        system: {
          platform: platform(),
          arch: arch(),
          hostname: hostname(),
          memory: process.memoryUsage(),
          cpu: cpus().length,
        },
        api: { totalRequests: this.systemService.getRequestCount() },
        websocket: { clients: this.ws.getConnectionCount(), active: true },
        agents: {
          total: agentTotal,
          subAgentsActive: this.swarm.listActiveAgents().length,
        },
        tools: { total: toolTotal, implemented: toolTotal },
        providers: {
          total: providers.length,
          configured: providers.filter((p) => p.configured).length,
        },
        channels: {
          total: channels.length,
          enabled: channels.filter((c) => (c as { status?: string }).status === 'connected').length,
        },
        cron: this.cronService.getStatus(),
        usage: this.usageService.getUsage(),
      },
    };
  }

  /** 检查更新 */
  @Get('update/check')
  @HttpCode(HttpStatus.OK)
  updateCheck(): ApiResponse<UpdateCheckResult> {
    const version = this.systemService.getVersion();
    return {
      success: true,
      data: {
        currentVersion: version,
        minVersion: version,
        forceUpdate: false,
        downloadUrl: 'https://claw.skyalytic.com/downloads',
        message: '',
      },
    };
  }

  /** 依赖检查 */
  @Get('deps/check')
  @HttpCode(HttpStatus.OK)
  depsCheck(): ApiResponse<{
    platform: string;
    installed: string[];
    missing: Array<{ name: string; desc: string; install: string | null }>;
    builtin: string[];
    npmMissing: Array<{ name: string; desc: string; installHint: string }>;
  }> {
    const r: DepsCheckResult = this.depsService.check();
    return {
      success: true,
      data: {
        platform: r.platform,
        installed: r.installed.map((d) => d.name),
        missing: r.missing.map((d) => ({ name: d.name, desc: d.desc, install: d.install })),
        builtin: r.builtin.map((d) => d.name),
        npmMissing: r.npmMissing.map((d) => ({
          name: d.name,
          desc: d.desc,
          installHint: d.installHint,
        })),
      },
    };
  }

  /** 安装缺失依赖（需设置 SKYALYTICWING_AUTO_INSTALL_DEPS 环境变量） */
  @Post('deps/install')
  @HttpCode(HttpStatus.OK)
  depsInstall(): ApiResponse<{
    success: boolean;
    platform: string;
    installed: string[];
    missing: string[];
  }> {
    const ok = this.depsService.autoInstall();
    const r = this.depsService.check();
    return {
      success: ok,
      data: {
        success: ok,
        platform: r.platform,
        installed: r.installed.map((d) => d.name),
        missing: r.missing.map((d) => d.name),
      },
    };
  }

  /** 依赖报告（文本） */
  @Get('deps/report')
  @HttpCode(HttpStatus.OK)
  depsReport(): ApiResponse<{ report: string }> {
    return { success: true, data: { report: this.depsService.getReport() } };
  }
}
