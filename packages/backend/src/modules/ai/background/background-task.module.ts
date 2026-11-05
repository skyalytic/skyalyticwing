import { Module } from '@nestjs/common';
import { BackgroundTaskService } from './background-task.service.js';
import { BackgroundTaskController } from './background-task.controller.js';
import { AgentModule } from '../agent/agent.module.js';

/**
 * BackgroundTaskModule - 超长任务后台执行模块
 *
 * 提供：
 *   - BackgroundTaskService（任务状态机 / 后台 AgentLoop 执行 / WS 进度推送 /
 *     完成结果回流原会话 / background-tasks.json 持久化）
 *   - BackgroundTaskController（/api/background-tasks REST 端点）
 *
 * 依赖 AgentModule 获取 AgentLoopService（harness 核心循环）；
 * SessionModule 为 @Global（SESSION_SERVICE token）直接注入；
 * WebSocketService / LoggerService 由全局模块提供。
 *
 * 服务亦经 ToolExecutor 的 ServiceResolver 懒解析供 background_task_submit
 * 内置工具调用（工具域与本模块存在反向依赖，不能构造期直连）。
 */
@Module({
  imports: [AgentModule],
  providers: [BackgroundTaskService],
  controllers: [BackgroundTaskController],
  exports: [BackgroundTaskService],
})
export class BackgroundTaskModule {}
