import { Module } from '@nestjs/common';
import { AgentModule } from '../ai/agent/agent.module.js';
import { CronModule } from '../channels/cron/cron.module.js';
import { MemoryDataService } from './memory-data.service.js';
import { MemoryController } from './memory.controller.js';

/**
 * MemoryModule - 记忆系统模块
 *
 * 提供：
 *   - MemoryDataService：memory.json 知识库 / 梦境状态文件持久化
 *   - MemoryController：/api/memory/* REST API
 *     （search / knowledge / dream / dream/status）
 *
 * 依赖 AgentModule 获取 MemoryService（MemorySystem 移植，负责记忆搜索
 * 与 dream cycle 巩固）；依赖 CronModule 获取 CronService（dream cron 状态）。
 */
@Module({
  imports: [AgentModule, CronModule],
  providers: [MemoryDataService],
  controllers: [MemoryController],
  exports: [MemoryDataService],
})
export class MemoryModule {}
