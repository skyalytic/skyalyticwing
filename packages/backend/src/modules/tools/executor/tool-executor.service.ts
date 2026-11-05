import { ExtensionHostService } from '../../../extensions/extension-host.service.js';
import { updateMaintenance } from '../../core/system/update-maintenance.js';
import { CODE_VIDEO_REQUIRED } from '../../ai/agent/video-production-policy.js';
import { toolAccess, accessMode } from './tool-access.js';
import { withDocumentSession } from '../files/document-history.js';
import { YoloClassifierService } from './yolo-classifier.service.js';
import { ToolPolicyService } from '../tool-policy.service.js';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  ToolContext,
  ToolDefinition,
  ToolListItem,
  ToolResult,
} from '@skyalyticwing/shared';
import { ConfigService } from '../../core/config/config.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { SafetyManagerService } from '../../core/security/safety-manager.service.js';
import { HttpClientService } from '../../core/http/http-client.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { ToolRegistryService } from './tool-registry.service.js';
import { SandboxProfileService } from '../sandbox/sandbox-profile.service.js';
import { SandboxSystemService } from '../sandbox/sandbox.service.js';
import { PluginService } from '../plugin/plugin.service.js';
import { DesktopService } from '../../automation/desktop.service.js';
import sharp from 'sharp';
import type { ServiceResolver } from './built-in/service-resolver.js';

/**
 * ToolExecutorService - 工具执行器
 *
 * 履行 IToolExecutorService 契约（execute / getToolDefinitions），并通过
 * TOOL_EXECUTOR_SERVICE token 提供（见 ToolExecutorModule）。AI 域 AgentLoopService
 * 经 @Inject(TOOL_EXECUTOR_SERVICE) 注入本服务。
 *
 * 注意：未使用 `implements IToolExecutorService` 关键字，因 ai/types.ts 中该接口的
 * getToolDefinitions 返回类型以 Record<string, unknown> 描述 parameters，与本服务
 * 返回的 ToolDefinition[]（parameters: ToolParameterSchema）在 exactOptionalPropertyTypes
 * 严格模式下不可协变。运行期契约完全一致，AI 域按接口类型消费本实例。
 *
 * 同时提供 listTools / registerTool / unregisterTool 供管理 API 使用。
 *
 * 职责：
 *   1. OnModuleInit 时将内置工具注册到 ToolRegistryService。
 *   2. execute() 执行工具：存在性校验 → 危险工具 + ask 模式审批拦截 → 调用 execute → 捕获异常。
 *   3. listTools() / getToolDefinitions() 供 LLM function calling 与 UI 展示。
 */
@Injectable()
export class ToolExecutorService implements OnModuleInit {
  private readonly logger = new Logger(ToolExecutorService.name);
  private desktopQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly security: SecurityManagerService,
    private readonly http: HttpClientService,
    private readonly ws: WebSocketService,
    private readonly log: LoggerService,
    private readonly config: ConfigService,
    private readonly safety: SafetyManagerService,
    /** 应用容器引用：非全局模块服务（Agent/Acp/Session/Daemon 域）执行期懒解析，避免循环实例化 */
    @Optional() private readonly moduleRef?: ModuleRef,
    /** 事件总线：发射 tool.executed 事件（审计/遥测），EventEmitterModule 未注册时缺省 */
    @Optional() private readonly eventEmitter?: EventEmitter2,
    /** 三级沙箱档位服务（read-only / workspace-write / danger-full-access） */
    @Optional() private readonly sandboxProfile?: SandboxProfileService,
    @Optional() private readonly extensions?: ExtensionHostService,

  ) {}

  async onModuleInit(): Promise<void> {
    await this.extensions?.initialize({ security: this.security, http: this.http, ws: this.ws,
      config: this.config, safety: this.safety, resolve: this.lazyResolve.bind(this) });
  }
  async refreshExtensions(): Promise<void> { await this.extensions?.refresh(); }
  async getToolCatalog() { return this.extensions ? this.extensions.toolCatalog() : this.listTools(); }
  async setToolInstalled(name: string, installed: boolean): Promise<void> {
    if (!this.extensions) throw new Error('Extension host unavailable');
    await this.extensions.setToolInstalled(name, installed);
  }
  async getExtensionGuidance(names: string[]): Promise<string> { return this.extensions?.guidance(new Set(names)) || ''; }

  /**
   * 懒解析非全局模块服务（strict:false 全容器查找）。
   * 模块未注册/未初始化/循环依赖场景返回 undefined，由调用工具返回"服务不可用"。
   */
  private lazyResolve<T>(typeOrToken: Parameters<ServiceResolver>[0]): T | undefined {
    if (!this.moduleRef) return undefined;
    try {
      return this.moduleRef.get<T>(typeOrToken, { strict: false });
    } catch {
      return undefined;
    }
  }

  /**
   * 执行工具。
   * - 工具不存在 → { success: false, error }
   * - 危险工具 + ask 模式 → { success: false, approvalRequired: true }
   * - 执行异常 → { success: false, error }
   *
   * @param options.approvalGranted 调用方已通过 ApprovalService 获得用户批准
   *   （如 ChatGateway tool_execute 通道在审批通过后的二次执行），
   *   跳过 approvalRequired 拦截。工具内部的安全校验（SecurityManager）不受影响。
   */
  async execute(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
    options?: { approvalGranted?: boolean },
  ): Promise<ToolResult> {
    await this.extensions?.refresh();
    const releaseUpdate = updateMaintenance.enter('工具执行', ctx.sessionId, true);
    try {
    if (!['desktop', 'desktop_screenshot', 'computer_use'].includes(toolName)) return await withDocumentSession(ctx.sessionId, () => this.executeTool(toolName, args, ctx, options));
    // One action plus its observation must be atomic across concurrent experts.
    const previous = this.desktopQueue;
    let release!: () => void;
    this.desktopQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await withDocumentSession(ctx.sessionId, () => this.executeTool(toolName, args, ctx, options)); }
    finally { release(); }
    } finally { releaseUpdate(); }
  }

  private async executeTool(toolName: string, args: unknown, ctx: ToolContext, options?: { approvalGranted?: boolean }): Promise<ToolResult> {
    if (ctx.signal?.aborted) return {success:false,error:'任务已取消'};
    if (ctx.videoCodeOnly && toolName==='generate_video') return {success:false,blocked:true,error:CODE_VIDEO_REQUIRED};
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { success: false, error: `Tool not found: ${toolName}` };
    }

    const access = toolAccess({ config: this.config, name: toolName, args,
      sessionId: ctx.sessionId, dangerous: !!tool.dangerous,
      commandGuard: this.security.getCommandGuard?.(),
      classify: cmd => new YoloClassifierService().classify(cmd),
      policy: this.lazyResolve<ToolPolicyService>(ToolPolicyService)?.checkTool(toolName),
    });
    if (access.action === 'reject' || (access.action === 'ask' && !options?.approvalGranted)) {
      return { success: false, ...(access.action === 'ask' ? { approvalRequired: true } : { blocked: true }), error: access.reason || '需要审批' };
    }

    // 三级沙箱档位检查与单次操作授权：
    // 拦截时复用审批管道——上游（AgentLoop/ChatGateway）弹出审批，用户批准后以
    // approvalGranted 重新执行本调用（审批按调用请求发放，天然 once 语义）。
    if (this.sandboxProfile && accessMode(this.config) !== 'yolo' && !options?.approvalGranted) {
      const gate = this.sandboxProfile.check({ toolName, args, ctx });
      if (
        !this.registry.isBuiltin(toolName) &&
        this.sandboxProfile.effectiveMode(ctx.sessionId) !== 'danger-full-access'
      ) {
        gate.allowed = false;
        gate.reason = '外部工具未在内置权限清单中，需要逐次审批';
      }
      if (!gate.allowed) {
        await this.eventEmitter?.emitAsync('tool.decision', {
          tool: toolName,
          sessionId: ctx.sessionId,
          decision: 'profile-blocked',
          policyVersion: 'workspace-policy-v2',
        });
        this.log.warn(`Tool '${toolName}' blocked by sandbox profile (${gate.rule})`, {
          sessionId: ctx.sessionId,
        });
        return {
          success: false,
          approvalRequired: true,
          error: gate.reason ?? `当前沙箱档位不允许工具 ${toolName}`,
        };
      }
    }

    const startedAt = Date.now();
    try {
      const plugins = this.lazyResolve<PluginService>(PluginService);
      const decision = await plugins?.runHook('beforeToolCall', { toolName, args, sessionId: ctx.sessionId }) as { blocked?: boolean; reason?: string } | undefined;
      if (decision?.blocked) return { success: false, blocked: true, error: decision.reason || '插件策略拒绝执行' };
      await this.eventEmitter?.emitAsync('tool.decision', {
        tool: toolName,
        sessionId: ctx.sessionId,
        decision: options?.approvalGranted ? 'approved' : 'policy-allowed',
        policyVersion: 'workspace-policy-v2',
      });
      let result: ToolResult;
      if (
        toolName === 'bash' && accessMode(this.config) !== 'yolo' &&
        this.sandboxProfile?.effectiveMode(ctx.sessionId) === 'workspace-write'
      ) {
        const sandbox = this.lazyResolve<SandboxSystemService>(SandboxSystemService);
        const command = (args as { command?: unknown })?.command;
        result =
          sandbox && typeof command === 'string'
            ? await sandbox.executeSafe(command, { cwd: ctx.workspace, sessionId:ctx.sessionId, ...(ctx.signal ? {signal:ctx.signal} : {}), ...(Number.isSafeInteger((args as {timeout?:number}).timeout) && (args as {timeout:number}).timeout > 0 ? {timeout:(args as {timeout:number}).timeout} : {}) })
            : { success: false, blocked: true, error: '隔离执行服务不可用，未在宿主机运行命令' };
      } else result = await tool.execute(args, ctx);
      const action = (args as { action?: string })?.action;
      const observeDesktop = toolName === 'desktop_screenshot' ||
        (toolName === 'desktop' && ['screenshot', 'click', 'type', 'press', 'scroll', 'drag'].includes(action || '')) ||
        (toolName === 'computer_use' && !(result.data as Record<string, unknown> | undefined)?.['desktopWorkflow'] && ['look', 'screenshot', 'act', 'act_batch'].includes(action || ''));
      if (observeDesktop && result.success) {
        try {
          const data = (result.data && typeof result.data === 'object' ? result.data : {}) as Record<string, unknown>;
          const capture = (toolName === 'desktop_screenshot' || action === 'screenshot') && typeof data['path'] === 'string'
            ? { success: true, path: data['path'] } : this.lazyResolve<DesktopService>(DesktopService)?.screenCapture({});
          if (capture?.success && capture.path) {
            const source = sharp(capture.path, { limitInputPixels: 100_000_000 });
            const metadata = await source.metadata();
            const rendered = await source.resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
            result = { ...result, data: { ...data, visualObservation: { base64: rendered.data.toString('base64'), width: rendered.info.width, height: rendered.info.height, originalWidth: metadata.width, originalHeight: metadata.height } } };
          } else result = { ...result, output: (result.output || '') + '\n未取得操作后截图；请使用观察工具重新确认。' };
        } catch { result = { ...result, output: (result.output || '') + '\n截图处理失败，动作结果尚需重新观察。' }; }
      }
      await plugins?.runHook(result.success ? 'afterToolCall' : 'afterToolFailure', {
        toolName, args, result, error: result.error, sessionId: ctx.sessionId, durationMs: Date.now() - startedAt,
      });
      this.emitToolExecuted(
        toolName,
        ctx.sessionId,
        Date.now() - startedAt,
        result.success !== false,
      );
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.error(`Tool execution failed: ${toolName}`, { error });
      this.emitToolExecuted(toolName, ctx.sessionId, Date.now() - startedAt, false);
      return { success: false, error };
    }
  }

  /**
   * 发射 tool.executed 事件（设计 §4.9）。
   * payload: { tool, sessionId, durationMs, success }；仅工具真正进入执行阶段才发射
   * （Tool not found / approvalRequired 拦截不发射）。
   */
  private emitToolExecuted(
    tool: string,
    sessionId: string | undefined,
    durationMs: number,
    success: boolean,
  ): void {
    try {
      this.eventEmitter?.emit('tool.executed', { tool, sessionId, durationMs, success });
    } catch (err) {
      this.logger.warn(
        `Failed to emit tool.executed event: ${tool}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** 列出所有工具（UI 展示用，含 loaded 状态） */
  listTools(): ToolListItem[] {
    return this.registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      dangerous: t.dangerous,
      loaded: true,
    }));
  }

  /** 获取工具定义（用于 LLM function calling） */
  getToolDefinitions(): ToolDefinition[] {
    return this.registry.getAll();
  }

  /** 注册工具 */
  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  /** 注销工具 */
  unregisterTool(name: string): void {
    this.registry.unregister(name);
  }

  /** 读取 YOLO 模式：auto / ask / yolo，默认 ask */

}
