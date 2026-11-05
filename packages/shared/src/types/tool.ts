/** 工具参数 JSON Schema */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** 工具上下文 */
export interface ToolContext {
  signal?: AbortSignal;
  sessionId: string;
  agentId?: string;
  /** User-selected model for this conversation, retained across capability routing. */
  selectedModel?: string;
  /** Explicit conversation instruction: local/code video only, no paid model submission. */
  videoCodeOnly?: boolean;
  workspace: string;
  config: Record<string, unknown>;
  log: (level: string, message: string) => void;
  broadcast: (event: string, data: unknown) => void;
}

/** 工具执行结果 */
export interface ToolResult {
  /** Optional plain text row summary supplied by an installed tool. No HTML or executable UI. */
  presentation?: { title?: string; summary?: string };
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
  blocked?: boolean;
  approvalRequired?: boolean;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  category: string;
  dangerous: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具审批请求 */
export interface ToolApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
  sessionId: string;
  reason: string;
  timestamp: number;
}

/** 工具审批响应 */
export interface ToolApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

/** YOLO 模式分类 */
export type YoloMode = 'auto' | 'ask' | 'yolo';

/** 工具列表项 */
export interface ToolListItem {
  name: string;
  description: string;
  category: string;
  dangerous: boolean;
  loaded: boolean;
  /** Installation is separate from permission/disabled state. */
  installed?: boolean;
  packageId?: string;
  /** 工具 id（旧版下划线风格或新版 kebab 风格，缺省回退 name） */
  id?: string;
  /** 权限模式：allow（自动）/ ask（需确认） */
  permission?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否已实现（旧版工具列表状态徽标） */
  implemented?: boolean;
  /** 是否自定义工具 */
  custom?: boolean;
}
