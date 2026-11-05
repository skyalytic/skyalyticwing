import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SecurityManagerService } from './security-manager.service.js';
import { PathGuardService } from './path-guard.service.js';
import { CommandGuardService } from './command-guard.service.js';
import { SsrfGuardService } from './ssrf-guard.service.js';
import { SafetyManagerService } from './safety-manager.service.js';
import { AuthGuard } from './auth.guard.js';
import { PermissionController } from './permission.controller.js';
import { ApprovalController } from './approval.controller.js';

/**
 * SecurityModule - 全局安全模块
 *
 * 通过 @Global() 装饰，SecurityManagerService 及其子 Guard 可在任意模块注入。
 * 依赖 ConfigService（由 ConfigModule 全局提供）读取 allowedPaths / blockedCommands。
 *
 * SafetyManagerService 为独立的运行时安全与可靠性增强服务，
 * 提供 API 错误分类、迭代预算、工具护栏、轨迹记录、输出截断、
 * 凭证池、模糊匹配、补丁解析、提示词缓存、验证钩子、日志脱敏等能力。
 *
 * Controllers:
 *   - PermissionController: /permissions, /yolo, /secretref, /security 路由
 *   - ApprovalController:   /approvals 路由（审批管理）
 *
 * AuthGuard 经 APP_GUARD 全局注册：HTTP REST 可选 Token 鉴权
 * （security.auth.mode === 'token' 时启用，默认 'none' 完全放行）。
 *
 * 依赖 ApprovalService / YoloClassifierService（由全局 ToolExecutorModule 提供）。
 */
@Global()
@Module({
  providers: [
    SecurityManagerService,
    PathGuardService,
    CommandGuardService,
    SsrfGuardService,
    SafetyManagerService,
    // 全局 HTTP 鉴权 Guard：读 security.auth 配置，未配置 token 模式时零开销放行
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  controllers: [PermissionController, ApprovalController],
  exports: [
    SecurityManagerService,
    PathGuardService,
    CommandGuardService,
    SsrfGuardService,
    SafetyManagerService,
  ],
})
export class SecurityModule {}
