/**
 * SandboxProfiles - 三级沙箱档位与权限预设定义
 *
 * 三档模式分别控制读取、工作区写入和完全访问：
 *   - read-only          只读档：写类工具与命令执行面全部拦截（需一次性提权审批）
 *   - workspace-write    工作区档：仅允许写工作区内路径；命令执行面放行（仍受
 *                        SecurityManager/CommandGuard/审批既有校验约束）
 *   - danger-full-access 全权档：本档位体系不再额外限制（既有安全校验全部保留）
 *
 * 一次性提权：被档位拦截的调用可经现有审批流（approvalRequired → approvalGranted）
 * 获得单次放行——审批按调用请求发放，天然具备 once 语义，无需额外状态。
 */

/** 沙箱档位 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 审批策略（permission-presets 捆绑维度，标注用；执行以各审批链现状为准） */
export type ApprovalStrategy = 'all' | 'writes' | 'dangerous';

/** 权限预设：沙箱档位 + 审批策略捆绑包 */
export interface SandboxPreset {
  id: string;
  name: string;
  description: string;
  mode: SandboxMode;
  approval: ApprovalStrategy;
}

/** 档位判定结果 */
export interface SandboxGateDecision {
  allowed: boolean;
  /** 拦截原因（allowed=false 时提供） */
  reason?: string;
  /** 命中的档位规则类别 */
  rule: 'write-tool' | 'command-tool' | 'outside-workspace' | 'pass';
}

/** 内置权限预设（安全 / 标准 / 信任） */
export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: 'safe',
    name: '安全',
    description: '只读沙箱：AI 仅能读取与检索，任何写入/命令执行都需逐次提权审批',
    mode: 'read-only',
    approval: 'all',
  },
  {
    id: 'standard',
    name: '标准',
    description:
      '工作区写入：文件写入限定工作区；bash 经 Docker 隔离，容器不可用则拒绝；其他副作用需审批',
    mode: 'workspace-write',
    approval: 'writes',
  },
  {
    id: 'trusted',
    name: '信任',
    description: '全权访问：本体系不额外限制（既有命令白名单/路径白名单/审批校验仍生效）',
    mode: 'danger-full-access',
    approval: 'dangerous',
  },
];

/** 新安装默认限定工作区；用户显式保存的配置保持不变。 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write';

/** 写类工具（直接落盘修改） */
export const WRITE_TOOLS: readonly string[] = ['file-write', 'file-edit', 'file-delete'];

/** 命令/控制面工具（可产生任意副作用的执行入口） */
export const COMMAND_TOOLS: readonly string[] = ['bash', 'powershell', 'desktop'];

/** Only reviewed built-ins can skip approval. Unclassified plugin/MCP tools fail closed. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'show-message',
  'btw-ask',
  'file-read',
  'file-list',
  'directory-list',
  'glob',
  'grep',
  'web-search',
  'web-fetch',
  'sandbox-status',
  'session-list',
  'session-history',
  'background-task-list',
  'background-task-status',
  'tool-list',
  'memory-search',
  'memory-get',
  'todo',
  'update-plan',
  'task-journal',
  'cron-list',
  'mcp-list',
  'mcp-resources',
  'mcp-loopback-status',
  'mcp-conversations-list',
  'skill-list',
  'skill-execute',
  'knowledge-search',
];

/** 写类工具的路径参数名（workspace-write 档位用于工作区边界判定） */
export const PATH_ARG_KEYS: readonly string[] = [
  'path',
  'file_path',
  'filePath',
  'dir',
  'directory',
  'cwd',
  'target',
];

/** 全部合法档位 */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/** 是否合法档位值 */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value);
}

/**
 * 从工具参数中提取首个可用路径参数（字符串且非空）。
 * 未识别出路径返回 undefined（该调用按"无路径参数"处理）。
 */
export function extractPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const o = args as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
