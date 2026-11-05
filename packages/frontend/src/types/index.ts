// 从 @skyalyticwing/shared 重新导出所有类型
export type {
  WsEvent,
  WsConnectionStatus,
  WsConnectionInfo,
  BackgroundTaskStatus,
  BackgroundTaskEventData,
} from '@skyalyticwing/shared/types';

export type {
  Attachment,
  MessageRole,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCallInfo,
  TokenUsage,
  SessionInfo,
} from '@skyalyticwing/shared/types';

export type {
  SessionStoreItem,
  SessionRestorePoint,
  LifecycleState,
  DoomLoopConfig,
} from '@skyalyticwing/shared/types';

export type {
  ToolParameterSchema,
  ToolContext,
  ToolResult,
  ToolDefinition,
  ToolApprovalRequest,
  ToolApprovalResponse,
  YoloMode,
  ToolListItem,
} from '@skyalyticwing/shared/types';

export type {
  ChannelType,
  ChannelStatus,
  ChannelConfig,
  ChannelMessage,
  ChannelStatusInfo,
  ChannelProvider,
} from '@skyalyticwing/shared/types';

export type {
  ApiResponse,
  PaginatedResponse,
  Timestamp,
  KeyValue,
  Nullable,
  Optional,
  EventMap,
  EventHandler,
} from '@skyalyticwing/shared/types';

// 注意：shared 根未导出 config.ts 中的类型（ProviderConfig / SecurityConfig 等），
// 此处按前端使用需要定义 ProviderConfig，与后端使用的结构保持一致。
export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
}

// ===== 前端专用类型 =====

/** 连接状态 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

/** Toast 通知级别 */
export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

/** Toast 通知 */
export interface ToastItem {
  id: string;
  level: ToastLevel;
  title: string;
  message?: string;
  duration: number;
}

/** 模型信息 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
}

/** 健康状态 */
export interface HealthInfo {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  version?: string;
  services?: Record<string, string>;
}

/** 日志条目 */
export interface LogEntry {
  id: string;
  level: string;
  message: string;
  timestamp: number;
  source?: string;
  meta?: Record<string, unknown>;
}

/** 监控统计 */
export interface MonitorStats {
  sessions: number;
  messages?: number;
  toolCalls?: number;
  tokensUsed?: number;
  activeConnections?: number;
  connections?: number;
  uptime?: number;
}

/** Cron 任务 */
export interface CronJob {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
  running: boolean;
  agent?: string;
  prompt?: string;
  lastRun?: number;
  nextRun?: number;
  lastResult?: string;
  /** 任务类型（ai/shell/browser/...） */
  taskType?: string;
  /** 长期任务摘要（轮次 + 进度） */
  longRunning?: { round: number; progress?: string };
}

/** 长期任务详情（GET /cron/:id 的 longRunning 字段） */
export interface CronLongRunningDetail {
  goal?: string;
  progress?: string;
  round?: number;
  maxRounds?: number;
  history?: Array<{
    at: number;
    outcome: 'success' | 'error';
    status?: 'running' | 'done' | 'blocked';
    summary: string;
  }>;
}

/** 插件信息 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  loaded: boolean;
  path?: string;
  author?: string;
}

/** MCP 服务器 */
export interface McpServer {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  status: 'stopped' | 'running' | 'error';
  tools?: string[];
  lastError?: string;
}

/** 代理信息 */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  enabled: boolean;
  memory?: string;
}

/** 工具执行请求 */
export interface ToolExecuteRequest {
  tool: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

/** 工具执行结果（前端） */
export interface ToolExecuteResult {
  tool: string;
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
  durationMs?: number;
}

/** ACP 会话 */
export interface AcpSession {
  id: string;
  agent: string;
  status: 'active' | 'idle' | 'closed';
  createdAt: number;
  lastMessageAt?: number;
}
