import { Global, Module } from '@nestjs/common';
import { UpdateController } from './update.controller.js';
import { SystemService } from './system.service.js';
import { SystemController } from './system.controller.js';
import { UsageService } from './usage.service.js';
import { DepsService } from './deps.service.js';
import { BreakerService } from './breaker.service.js';
import { BreakerController } from './breaker.controller.js';
import { NotifyController } from './notify.controller.js';
import { AgentModule } from '../../ai/agent/agent.module.js';
import { LlmModule } from '../../ai/llm/llm.module.js';
import { ChannelsModule } from '../../channels/channels.module.js';
import { CronModule } from '../../channels/cron/cron.module.js';

/**
 * SystemModule - 系统信息与杂项 P2 路由模块（全局）
 *
 * 提供：
 *   - SystemService：健康检查快照、系统信息快照、请求计数
 *   - UsageService：用量统计（usage.json 聚合）
 *   - DepsService：依赖检查 / 自动安装 / 报告（DependencyChecker 移植）
 *   - BreakerService：工具级熔断器（内存计数器）
 *   - SystemController：/api/health、/api/system/info、/api/usage、
 *     /api/status/full、/api/update/check、/api/deps/*
 *   - BreakerController：GET /api/breaker-status、POST /api/breaker-reset
 *   - NotifyController：POST /api/notify、GET /api/ws/status
 *
 * 导入 Agent/Llm/Channels/Cron 模块以聚合 /api/status/full 各域状态
 * （这些模块均不反向导入 SystemModule，无循环依赖）。
 *
 * 通过 @Global() 暴露 SystemService / BreakerService，供中间件或其他模块调用。
 *
 * 依赖 ConfigService / LoggerService / WebSocketService / SecurityManagerService，
 * 均由各自全局模块提供。
 */
@Global()
@Module({
  imports: [AgentModule, LlmModule, ChannelsModule, CronModule],
  providers: [SystemService, UsageService, DepsService, BreakerService],
  controllers: [SystemController, BreakerController, NotifyController, UpdateController],
  exports: [SystemService, UsageService, DepsService, BreakerService],
})
export class SystemModule {}
