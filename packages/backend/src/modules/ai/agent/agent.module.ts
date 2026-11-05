import { Module } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { AgentLoopService } from './agent-loop.service.js';
import { AgentController } from './agent.controller.js';
import { AgentSwarmService } from './agent-swarm.service.js';
import { CronAiExecutorService } from './cron-ai-executor.service.js';
import { TaskManagerService } from './task-manager.service.js';
import { MemoryService } from './memory.service.js';
import { AgentMessengerService } from './agent-messenger.service.js';
import { AgentMessageService } from './agent-message.service.js';
import { SkillService } from './skill.service.js';
import { SkillController } from './skill.controller.js';
import { SubagentService } from './subagent.service.js';
import { SubagentController } from './subagent.controller.js';
import { LlmModule } from '../llm/llm.module.js';
import { CronModule } from '../../channels/cron/cron.module.js';

/**
 * AgentModule - Agent 域模块
 *
 * 提供：
 *   - AgentService（CRUD + 记忆）
 *   - AgentLoopService（核心循环引擎）
 *   - AgentSwarmService（子代理系统 / 蜂群调度，移植自 start.cjs SubAgentSystem）
 *   - TaskManagerService（任务管理，maxTasks=10000 淘汰策略）
 *   - MemoryService（代理记忆系统，移植自 start.cjs MemorySystem）
 *   - AgentMessengerService（代理间消息传递，移植自 start.cjs AgentMessenger）
 *   - AgentMessageService（代理信箱互通：send/inbox/markread + 工作区文件，供 LLM 工具桥接）
 *
 * AgentLoopService 依赖 LLMClientService（来自 LlmModule）；
 * WebSocketService / SecurityManagerService / ConfigService / LoggerService /
 * EventEmitter2 由全局模块提供；ToolExecutorService / SessionService 尚未实现，
 * 在相关服务中以 @Optional() 注入。
 *
 * 导出 AgentLoopService 供 AcpModule 等使用。
 */
@Module({
  imports: [LlmModule, CronModule],
  providers: [
    AgentService,
    AgentLoopService,
    AgentSwarmService,
    CronAiExecutorService,
    TaskManagerService,
    MemoryService,
    AgentMessengerService,
    AgentMessageService,
    SkillService,
    SubagentService,
  ],
  controllers: [AgentController, SkillController, SubagentController],
  exports: [
    AgentService,
    AgentLoopService,
    AgentSwarmService,
    TaskManagerService,
    MemoryService,
    AgentMessengerService,
    AgentMessageService,
    SkillService,
    SubagentService,
  ],
})
export class AgentModule {}
