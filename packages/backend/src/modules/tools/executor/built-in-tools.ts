import type { ToolDefinition } from '@skyalyticwing/shared';
import { createDatabaseTools } from './built-in/database-tools.js';
import { createOfficeTools } from './built-in/office-tools.js';
import { createLanguageTools } from './built-in/language-tools.js';
import { createRepositoryTools } from './built-in/repository-tools.js';
import { createVideoComposeTool, createVideoInspectionTool } from './built-in/video-compose.js';
import { createCodeVideoTool } from './built-in/code-video.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { SafetyManagerService } from '../../core/security/safety-manager.service.js';
import { HttpClientService } from '../../core/http/http-client.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { ConfigService } from '../../core/config/config.service.js';
import {
  createFileReadTool,
  createFileWriteTool,
  createTodoTools,
  createFileEditTool,
  createFileDeleteTool,
  createDirectoryListTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
  createPowerShellTool,
  createWebFetchTool,
  createNotifyTool,
  createMediaTools,
  createAutomationTools,
  createMemoryTools,
  createSystemTools,
  createCronMcpTools,
  createSessionAgentTools,
  createAgentReachTools,
  createChannelTools,
  createMiscTools,
  createAcpTools,
  createDaemonTools,
  createBackgroundTaskTools,
  createDocTools,
  createWebSearchTool,
  createPlatformTools,
  createLegacyTools,
  createOcrTools,
  createBuiltinBrowserTools,
  type ServiceResolver,
} from './built-in/index.js';

/** 内置工具所需依赖 */
export interface BuiltInToolDeps {
  security: SecurityManagerService;
  http: HttpClientService;
  ws: WebSocketService;
  /** 全局安全配置服务（agent-reach / channel 域读取 API Key 等配置） */
  config: ConfigService;
  /** 运行时安全增强服务（apply_patch 的补丁解析与模糊匹配） */
  safety: SafetyManagerService;
  /**
   * 非全局模块服务懒解析器：AgentMessageService / SessionService / AcpService 等
   * 与工具执行器存在反向依赖，构造期直连会循环实例化，故执行期经 ModuleRef 解析。
   * 未提供时相关工具注册仍成功，执行时返回"服务不可用"。
   */
  resolve: ServiceResolver;
}

/**
 * 创建全部内置工具定义数组。
 *
 * 工厂函数注入所需依赖（SecurityManagerService / HttpClientService /
 * WebSocketService / ConfigService / SafetyManagerService / ServiceResolver），
 * 返回的 ToolDefinition 由 ToolExecutorService 在 OnModuleInit 时注册到
 * ToolRegistryService。
 */
export function createBuiltInTools(deps: BuiltInToolDeps): ToolDefinition[] {
  const { security, http, ws, config, safety, resolve } = deps;
  const noopResolve: ServiceResolver = () => undefined;
  const lazy = resolve || noopResolve;
  return [
    ...createDatabaseTools(lazy),
    ...createOfficeTools(lazy),
    ...createLanguageTools(lazy),
    ...createRepositoryTools(security,lazy),
    createFileReadTool(security),
    createFileWriteTool(security),
    ...createTodoTools(),
    createFileEditTool(security),
    createFileDeleteTool(security),
    createDirectoryListTool(security),
    createGlobTool(security),
    createGrepTool(security),
    createBashTool(security),
    createPowerShellTool(security),
    createWebFetchTool(security, http),
    createNotifyTool(ws),
    // 第一批扩展：媒体 / 自动化 / 记忆向量技能 / 系统 / cron-mcp 域
    ...createMediaTools(security, http, lazy),
    createVideoComposeTool(security, config),
    createVideoInspectionTool(security, config),
    createCodeVideoTool(security, config),
    ...createAutomationTools(security, ws, lazy),
    ...createMemoryTools(lazy),
    ...createSystemTools(lazy),
    ...createCronMcpTools(lazy),
    // 第二批：跨会话协作 / agent-reach / 渠道 / 杂项 / ACP / 守护进程域
    ...createSessionAgentTools(lazy),
    ...createAgentReachTools(security, http, config),
    ...createChannelTools(security, http, ws, config),
    ...createMiscTools(security, safety, lazy),
    ...createAcpTools(lazy),
    ...createDaemonTools(security, lazy),
    // 超长任务后台执行（AI 自动判断转后台，任务完成结果回流当前会话）
    ...createBackgroundTaskTools(lazy),
    // 第三批：文档生成 / 网页搜索 / 平台域（蜂群/提供商/沙箱/会话/插件）
    ...createDocTools(security),
    createWebSearchTool(security, http, config),
    ...createPlatformTools(security, lazy),
    // 第四批：旧版遗留工具补齐（python/node/code_build/git_operation/agent_reach_doctor/plugin_*
    // + ask_user/notification/browser_open/api_call/agent_list/tool_policy_*）
    ...createLegacyTools(security, http, lazy, ws),
    // 本地 OCR（文字识别，与媒体 API 生成无关，旧媒体套件清理时保留）
    ...createOcrTools(lazy),
    // 内置浏览器（自托管 headless + 元素标记，前端"浏览器"面板可视化，AI 按编号操作元素）
    ...createBuiltinBrowserTools(lazy),
    // （语音 TTS/STT、音乐生成、媒体分析工具已随旧媒体套件清理移除，
    //  仅保留统一模型体系的图片/视频 API 生成；uia_diagnostics 迁入 automation 域）
  ];
}
