import { Module } from '@nestjs/common';
import { AcpService } from './acp.service.js';
import { AcpController } from './acp.controller.js';
import { AcpSessionService } from './acp-session.service.js';
import { AcpMessageRouter } from './acp-message.router.js';
import { AgentModule } from '../agent/agent.module.js';

/**
 * AcpModule - ACP (Agent Communication Protocol) 模块
 *
 * 提供：
 *   - AcpService（ACP 管理器门面，全量移植自 acp-manager.cjs，聚合 10 个子系统：
 *     StdioServer / AcpClient / EventLedger / PermissionRelay / Policy /
 *     Bindings / SessionMapper / ApprovalClassifier / EventMapper / setAIProvider）
 *   - AcpSessionService（ACP 控制面会话管理，移植自 acp-manager.cjs ControlPlane）
 *   - AcpMessageRouter（ACP JSON-RPC 消息路由，移植自 acp-manager.cjs _handleStdioMessage）
 *
 * 依赖 AgentModule 获取 AgentLoopService 驱动会话内的 Agent 循环；
 * LoggerService / EventEmitter2 由全局模块提供。
 */
@Module({
  imports: [AgentModule],
  providers: [AcpService, AcpSessionService, AcpMessageRouter],
  controllers: [AcpController],
  exports: [AcpService, AcpSessionService, AcpMessageRouter],
})
export class AcpModule {}
