/** 附件类型 */
export interface Attachment {
  type: 'image' | 'file' | 'video' | 'audio';
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

/** 聊天消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 聊天消息 */
export interface ChatMessage {
  responseState?: { provider: string; model: string; items: Record<string, unknown>[] };
  /** Stable owner and order, shared by live events and persisted history. */
  turnId?: string;
  turnSequence?: number;
  phase?: 'progress' | 'final' | 'status';
  turnStatus?: 'cancelled' | 'failed';
  streaming?: boolean;
  /** Provider reasoning retained for replay of assistant tool calls. */
  reasoningContent?: string;
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  /** Generated context summary, never inferred from user-controlled text. */
  contextSummary?: boolean;
  attachments?: Attachment[];
  toolCallId?: string;
  toolName?: string;
  /** assistant 消息携带的工具调用（历史重放必需：无此字段的 tool 消息会因缺少配对 tool_calls 被 API 400 拒绝） */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  model?: string;
  generationUuid?: string;
  /** 所属会话（WS 广播携带，前端按此过滤跨会话事件防串扰） */
  sessionId?: string;
}

/** 聊天请求 */
export interface ChatRequest {
  turnId?: string;
  session: string;
  message: string;
  model?: string;
  agent?: string;
  attachments?: Attachment[];
  stream?: boolean;
}

/** 聊天响应 */
export interface ChatResponse {
  message: ChatMessage;
  sessionId: string;
  usage?: TokenUsage;
}

/** 流式响应块 */
export interface ChatStreamChunk {
  type: 'delta' | 'done' | 'error' | 'tool_call';
  content?: string;
  toolCall?: ToolCallInfo;
  usage?: TokenUsage;
  error?: string;
}

/** 工具调用信息 */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

/** Token 用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 会话信息 */
export interface SessionInfo {
  projectDir?: string;
  titleCustomized?: boolean;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model?: string;
  agent?: string;
  /** 置顶（列表最前，按置顶时间新者先） */
  pinned?: boolean;
  /** 归档会话（列表灰显收进折叠组） */
  archived?: boolean;
}
