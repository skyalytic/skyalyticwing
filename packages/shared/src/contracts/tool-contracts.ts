/**
 * 工具契约（契约先行架构 · 001）
 *
 * 工具是 harness 的第一公民：本文件定义工具的分类、生命周期与清单契约，
 * 作为 backend 工具注册表（tool-registry）、前端工具面板与 CLI 的共同事实来源。
 * 规则：契约类型只描述"是什么"，不包含实现；实现必须满足契约（编译期校验）。
 */
import type { ToolDefinition, ToolResult, ToolContext } from '../types/tool.js';

/** 工具分类（与 built-in 工具的 category 字段对齐；新增分类须在此登记） */
export const TOOL_CATEGORIES = [
  'filesystem',
  'exec',
  'search',
  'web',
  'automation',
  'interactive',
  'session',
  'memory',
  'skill',
  'cron',
  'channel',
  'media',
  'doc',
  'misc',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** 工具能力标记（用于能力协商：CLI/子代理/无头模式可声明禁用某类工具） */
export interface ToolCapabilities {
  /** 需要用户交互（ask_user 等）——无头模式自动降级 */
  interactive?: boolean;
  /** 会操作本机桌面（desktop/computer_use）——远程模式可禁用 */
  localDesktop?: boolean;
  /** 需要网络访问 */
  network?: boolean;
  /** 仅特定平台可用 */
  platform?: 'win32' | 'darwin' | 'linux';
}

/**
 * 工具清单条目（ToolManifest）：对外（前端/CLI/子代理）暴露的工具元数据契约。
 * 与内部 ToolDefinition 的区别：不含 execute 实现，仅含可协商的元信息。
 */
export interface ToolManifest {
  name: string;
  description: string;
  category: string;
  dangerous: boolean;
  capabilities?: ToolCapabilities;
  parameters: ToolDefinition['parameters'];
}

/** 工具执行结果扩展载荷：工具可通过 data 透传结构化结果给前端渲染 */
export type ToolResultPayload = ToolResult;

/** 由 ToolDefinition 收敛为 ToolManifest（清单导出的统一入口） */
export function toToolManifest(def: ToolDefinition): ToolManifest {
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    dangerous: def.dangerous,
    parameters: def.parameters,
  };
}

/** 工具执行上下文契约（运行时构造，工具只读消费） */
export type ToolRuntimeContext = ToolContext;
