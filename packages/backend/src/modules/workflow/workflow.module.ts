import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service.js';
import { WorkflowController } from './workflow.controller.js';
import { LlmModule } from '../ai/llm/llm.module.js';
import { AgentModule } from '../ai/agent/agent.module.js';

/**
 * WorkflowModule - 工作流模块
 *
 * 把复杂任务固化为可复用工作流：步骤顺序执行，每步调 LLMClientService.chatSync，
 * 步骤间上下文传递（上一步输出注入下一步 prompt）。
 * 依赖 LoggerService（全局模块提供）与 LlmModule（LLM 调用层）。
 */
@Module({
  imports: [LlmModule, AgentModule],
  providers: [WorkflowService],
  controllers: [WorkflowController],
  exports: [WorkflowService],
})
export class WorkflowModule {}
