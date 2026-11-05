import { ExtensionHostService } from '../../../extensions/extension-host.service.js';
import { ExtensionSelectionService } from '../../../extensions/extension-selection.service.js';
import { ExtensionController } from '../../../extensions/extension.controller.js';
import { Global, Module } from '@nestjs/common';
import { TOOL_EXECUTOR_SERVICE } from '../../ai/types.js';
import { ToolRegistryService } from './tool-registry.service.js';
import { ToolExecutorService } from './tool-executor.service.js';
import { ExternalToolLoaderService } from './external-tool-loader.service.js';
import { YoloClassifierService } from './yolo-classifier.service.js';
import { ApprovalService } from './approval.service.js';
import { AskUserService } from './ask-user.service.js';
import { AskUserController } from './ask-user.controller.js';
import { SandboxProfileService } from '../sandbox/sandbox-profile.service.js';
import { ToolController } from '../tool.controller.js';
import { WorktreeService } from '../worktree.service.js';
import { WorktreeController } from '../worktree.controller.js';
import { ToolPolicyService } from '../tool-policy.service.js';
import { ToolPolicyController } from '../tool-policy.controller.js';

/**
 * ToolExecutorModule - 工具执行器模块（全局）
 *
 * 通过 @Global() 装饰，使 TOOL_EXECUTOR_SERVICE 注入 token 对全部模块可见——
 * 尤其是 AgentLoopService（位于 AgentModule，未导入本模块）通过
 * @Optional() @Inject(TOOL_EXECUTOR_SERVICE) 注入执行器。
 *
 * 导出 ToolRegistryService 供 PluginModule / McpModule 注册外部工具。
 * 提供 YoloClassifierService（安全命令分类）与 ApprovalService（审批流程）。
 * 提供 ExternalToolLoaderService（@skyalyticwing/tools 包热加载，设计文档 4.4）：
 * 声明在 ToolExecutorService 之后，确保内置工具先注册、外部同名工具被跳过。
 *
 * Controllers:
 *   - ToolController: /tools, /tool/execute, /tool-groups, /tool-profiles,
 *     /tools/reload（外部工具热重载）路由
 *   - WorktreeController: /worktrees, /worktrees/stats, /worktrees/remove,
 *     /worktrees/init-git, /worktrees/:id/exec, /worktrees/:id/diff
 *   - ToolPolicyController: /tool-policies CRUD
 *   - AskUserController: /tools/ask-user/respond（ask_user 提问回复）
 *
 * Providers:
 *   - WorktreeService: Git Worktree 管理（命令执行经 SecurityManager 校验）
 *   - ToolPolicyService: 工具策略管线（allow/deny glob 过滤）
 *   - AskUserService: ask_user 提问等待（WS 广播、回复、取消及停止）
 *
 * 依赖 ConfigService / LoggerService / SecurityManagerService /
 * HttpClientService / WebSocketService / EventEmitter2，均由各自的全局模块提供。
 */
@Global()
@Module({
  providers: [
    ToolRegistryService,
    ExtensionSelectionService,
    ExtensionHostService,
    ToolExecutorService,
    ExternalToolLoaderService,
    YoloClassifierService,
    ApprovalService,
    AskUserService,
    SandboxProfileService,
    WorktreeService,
    ToolPolicyService,
    {
      provide: TOOL_EXECUTOR_SERVICE,
      useExisting: ToolExecutorService,
    },
  ],
  controllers: [ExtensionController, ToolController, WorktreeController, ToolPolicyController, AskUserController],
  exports: [
    ExtensionSelectionService,
    ExtensionHostService,
    ToolRegistryService,
    ToolExecutorService,
    ExternalToolLoaderService,
    YoloClassifierService,
    ApprovalService,
    AskUserService,
    SandboxProfileService,
    WorktreeService,
    ToolPolicyService,
    TOOL_EXECUTOR_SERVICE,
  ],
})
export class ToolExecutorModule {}
