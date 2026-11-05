import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { LoggerService } from '../core/logger/logger.service.js';
import { LifecycleService } from './lifecycle.service.js';
import { HeartbeatDto } from '../channels/wechat/dto/wechat.dto.js';

/**
 * Lifecycle REST API（路由前缀 /api/lifecycle）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET    /api/lifecycle/diagnostics - 生命周期诊断（活跃运行/会话/心跳）
 *   POST   /api/lifecycle/heartbeat   - 启动 agent 心跳调度器
 *   DELETE /api/lifecycle/heartbeat   - 停止 agent 心跳调度器
 */
@Controller('lifecycle')
export class LifecycleController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly logger: LoggerService,
  ) {}

  /** GET /lifecycle/diagnostics — 全量生命周期诊断 */
  @Get('diagnostics')
  diagnostics() {
    return {
      activeRuns: this.lifecycle.getActiveRunCount(),
      sessions: this.lifecycle.diagnoseAll(),
      heartbeatAgents: this.lifecycle.getHeartbeatAgentIds(),
      agentTimeoutHours: this.lifecycle.resolveAgentTimeoutMs() / 1000 / 60 / 60,
      llmIdleTimeoutSeconds: this.lifecycle.getDefaultLlmIdleTimeoutMs() / 1000,
    };
  }

  /** POST /lifecycle/heartbeat — 启动心跳（默认 30 分钟间隔） */
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Body() dto: HeartbeatDto) {
    const agentId = dto?.agentId || 'main';
    const intervalMs = dto?.intervalMs || 30 * 60 * 1000;
    this.lifecycle.startHeartbeat(agentId, intervalMs, (hb) => {
      this.logger.info('Heartbeat triggered', {
        scope: 'heartbeat',
        agentId: hb.agentId,
        timestamp: hb.timestamp,
      });
    });
    return {
      ok: true,
      message: `Heartbeat started for ${agentId} (${intervalMs / 1000}s)`,
    };
  }

  /** DELETE /lifecycle/heartbeat?agentId= — 停止心跳 */
  @Delete('heartbeat')
  stopHeartbeat(@Query('agentId') agentId?: string) {
    const key = agentId || 'main';
    this.lifecycle.stopHeartbeat(key);
    return {
      ok: true,
      message: `Heartbeat stopped for ${key}`,
    };
  }
}
