/**
 * AI 域共享类型定义
 *
 * 包含：
 *   - LLM 调用层类型（ChatParams / ChatChunk / LlmMessage / LlmToolDefinition）
 *     与任务规格中描述的 SDK ChatParams/ChatChunk 形状对齐：role 联合包含 'tool'，
 *     支持 toolCallId/toolCalls，ChatChunk 包含 content/tool_call/done/error 及 finishReason。
 *   - Provider 配置类型
 *   - Agent 域类型（AgentLoopEvent / AgentInfo / AgentMemory / CreateAgentDto / UpdateAgentDto）
 *   - ACP 域类型（AcpSession / AcpSessionConfig）
 *   - 尚未实现的依赖服务接口（ISessionService / IToolExecutorService）及注入 Token
 */
import type {
  Attachment,
  ChatMessage,
  TokenUsage,
  ToolApprovalRequest,
  ToolContext,
  ToolResult,
} from '@skyalyticwing/shared';

// ---------------------------------------------------------------------------
// LLM 调用层类型
// ---------------------------------------------------------------------------

/** LLM 工具定义（参数为 JSON Schema，便于直接透传给 OpenAI/Anthropic API） */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * LLM 多模态内容 part（对齐 OpenAI Chat Completions 多模态 content 数组格式）。
 * 图片以 DataURL（data:image/xxx;base64,yyy）形式内联于 image_url.url。
 */
export type LlmContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** LLM 消息（与 SDK 描述的 ChatParams.messages 形状对齐；content 支持多模态数组） */
export interface LlmMessage {
  /** Provider reasoning payload, retained for tool continuation; not answer text. */
  reasoningContent?: string;
  contextSummary?: boolean;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentPart[];
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** LLM 调用参数 */
export interface ChatParams {
  signal?: AbortSignal;
  messages: LlmMessage[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LlmToolDefinition[];
  stream?: boolean;
  /** 指定 provider，未提供时由 LLMClientService 选择默认 provider */
  providerId?: string;
}

/** LLM 流式响应块 */
export interface ChatChunk {
  reasoningContent?: string;
  type: 'content' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: { id: string; name: string; arguments: string };
  finishReason?: string;
  error?: string;
  errorCode?: string;
  /** done 块携带的 token 用量（chatSync 聚合使用） */
  usage?: TokenUsage;
}

/** Provider 配置（apiKey 已完成环境变量替换） */
export interface ProviderConfig {
  id: string;
  apiKey: string;
  baseUrl: string;
  type: 'openai' | 'anthropic';
  models?: string[];
  headers?: Record<string, string>;
}
// ---------------------------------------------------------------------------
// Agent 域类型
// ---------------------------------------------------------------------------

/** Agent 循环事件流 */
export type AgentLoopEvent =
  | { type: 'assistant_delta'; message: ChatMessage }
  | {
      type: 'assistant_message';
      content: string;
      /** The persisted message, reused by HTTP and WebSocket transports. */
      message?: ChatMessage;
      /** 工具生成的内联媒体附件（图片/视频/音频），随最终助手消息返回对话流 */
      attachments?: Attachment[];
    }
  | { type: 'tool_call'; toolName: string; args: unknown; callId: string; turnId?: string; turnSequence?: number }
  | { type: 'tool_result'; toolName: string; result: ToolResult; callId: string; turnId?: string; turnSequence?: number }
  | { type: 'approval_request'; request: ToolApprovalRequest }
  | { type: 'done'; usage?: TokenUsage }
  | { type: 'error'; error: string };

/** Agent 信息 */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  toolsMode?: 'inherit' | 'selected' | 'none';
  createdAt: number;
  updatedAt: number;
  /** 代理类型（primary/specialist，旧版 .agents frontmatter type） */
  type?: string;
  /** 代理图标标识（旧版 emoji，如 "[AI]"；前端映射为 SVG 图标） */
  emoji?: string;
  /** 能力标签（旧版 capabilities） */
  capabilities?: string[];
  /** 运行状态（main 常驻 running，其余 idle） */
  status?: string;
  /** 旧版 frontmatter default_model */
  defaultModel?: string;
  /** 版本号（旧版 frontmatter version） */
  version?: string;
  /** 已完成任务数（旧版 countTasksByAgent） */
  tasksCompleted?: number;
  /** 累计 token 用量（人类可读格式，旧版 formatBytes） */
  tokensUsed?: string;
  /** 预置代理（内置种子，不可删除、仅可编辑） */
  builtin?: boolean;
  /** 英文标识名（被其他智能体调用时的唯一标识，如 project-analyzer；slug 全局唯一） */
  slug?: string;
  /** 可被其他智能体调用（多智能体协作委派白名单，缺省 true） */
  callable?: boolean;
  /** 何时调用：描述其他智能体适合委派该智能体的场景与时机（协作调度依据） */
  invocationHint?: string;
  /** 头像（base64 dataURL：data:image/(png|jpeg|webp);base64,xxx，≤200KB；空/缺省表示未设置） */
  avatar?: string;
}

/** 智能体团队（多智能体协作单元：成员以 subagent_spawn_swarm 委派协作） */
export interface TeamInfo {
  id: string;
  name: string;
  description?: string;
  /** 团队成员智能体 id 清单 */
  memberIds: string[];
  /** 主管人（Lead）成员 id；缺省取 memberIds[0] */
  leadId?: string;
  /** 擅长领域标签（展示用，如 SEO内容/关键词研究） */
  tags?: string[];
  /** 头像（base64 dataURL：data:image/(png|jpeg|webp);base64,xxx，≤200KB；空/缺省表示未设置） */
  avatar?: string;
  createdAt: number;
  updatedAt: number;
}

/** 创建团队 DTO */
export interface CreateTeamDto {
  name?: string;
  description?: string;
  memberIds?: string[];
  leadId?: string;
  tags?: string[];
  /** 头像（base64 dataURL，≤200KB） */
  avatar?: string;
}

/** 更新团队 DTO */
export interface UpdateTeamDto {
  name?: string;
  description?: string;
  memberIds?: string[];
  leadId?: string;
  tags?: string[];
  /** 头像（base64 dataURL，≤200KB；传空串清除） */
  avatar?: string;
}

/** 创建 Agent DTO */
export interface CreateAgentDto {
  name: string;
  description?: string;
  model: string;
  systemPrompt?: string;
  tools?: string[];
  toolsMode?: 'inherit' | 'selected' | 'none';
  /** 自定义代理 id（缺省自动生成 UUID） */
  id?: string;
  /** 代理类型 */
  type?: string;
  /** 代理图标标识 */
  emoji?: string;
  /** 能力标签 */
  capabilities?: string[];
  /** 英文标识名（被调用时的唯一标识，全局唯一） */
  slug?: string;
  /** 可被其他智能体调用（缺省 true） */
  callable?: boolean;
  /** 何时调用（协作调度依据） */
  invocationHint?: string;
  /** 头像（base64 dataURL，≤200KB） */
  avatar?: string;
}

/** 更新 Agent DTO */
export interface UpdateAgentDto {
  name?: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  toolsMode?: 'inherit' | 'selected' | 'none';
  type?: string;
  emoji?: string;
  capabilities?: string[];
  slug?: string;
  callable?: boolean;
  invocationHint?: string;
  /** 头像（base64 dataURL，≤200KB；传空串清除） */
  avatar?: string;
}

/** Agent 记忆 */
export interface AgentMemory {
  agentId: string;
  facts: string[];
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// ACP 域类型
// ---------------------------------------------------------------------------

/** ACP 会话配置 */
export interface AcpSessionConfig {
  agentId?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

/** ACP 会话 */
export interface AcpSession {
  id: string;
  config: AcpSessionConfig;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  createdAt: number;
  lastActivityAt: number;
  status: 'active' | 'cancelled' | 'expired' | 'closed';
}

// ---------------------------------------------------------------------------
// 尚未实现的依赖服务接口与注入 Token
// ---------------------------------------------------------------------------

/**
 * SessionService 注入 Token。
 * SessionService 由 session 域提供，当前尚未创建，故使用字符串 Token + @Optional() 注入。
 * 待 session 域实现后，可在 SessionModule 中通过 `@Inject(SESSION_SERVICE)` 将其提供出来，
 * 或将本 Token 替换为直接引用 SessionService 类。
 */
export const SESSION_SERVICE = 'SESSION_SERVICE';

/** SessionService 预期接口（AI 域依赖的最小子集） */
export interface ISessionService {
  flush?(): Promise<void>;
  getMessages(sessionId: string): ChatMessage[];
  getContextMessages?(sessionId: string): ChatMessage[];
  setContextMessages?(sessionId: string, expectedHistory: ChatMessage[], messages: ChatMessage[]): boolean;
  addMessage(sessionId: string, message: ChatMessage): void;
  replaceMessages(sessionId: string, messages: ChatMessage[]): boolean;
  getSession(
    sessionId: string,
  ): { id: string; messages: ChatMessage[]; model?: string; agent?: string } | undefined;
}

/**
 * ToolExecutorService 注入 Token。
 * ToolExecutorService 由 tools 域提供，当前尚未创建，故使用字符串 Token + @Optional() 注入。
 */
export const TOOL_EXECUTOR_SERVICE = 'TOOL_EXECUTOR_SERVICE';

/** ToolExecutorService 预期接口（AI 域依赖的最小子集） */
export interface IToolExecutorService {
  refreshExtensions?(): Promise<void>;
  getExtensionGuidance?(names: string[]): Promise<string>;
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** 危险工具标记（未显式设置策略时默认需确认） */
    dangerous?: boolean;
  }>;
  execute(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
    options?: { approvalGranted?: boolean },
  ): Promise<ToolResult>;
}
