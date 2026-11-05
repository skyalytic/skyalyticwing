/**
 * Hook 契约（契约先行架构 · 003）
 *
 * Agent 生命周期钩子（插件经 api.addHook 注册）。
 * 名称常量与载荷类型在此登记，插件与 agent-loop 双端引用同一契约。
 */
import type { ToolResult } from '../types/tool.js';

/** 支持的钩子名（与 agent-loop.service emitHook 调用点对齐） */
export const AGENT_HOOKS = {
  /** 工具调用前（返回阻止标记可拦截执行） */
  BEFORE_TOOL_CALL: 'beforeToolCall',
  /** 工具调用成功后 */
  AFTER_TOOL_CALL: 'afterToolCall',
  /** 工具调用失败后 */
  AFTER_TOOL_FAILURE: 'afterToolFailure',
  /** 会话循环结束（正常/异常/中止统一收口） */
  SESSION_END: 'sessionEnd',
} as const;

export type AgentHookName = (typeof AGENT_HOOKS)[keyof typeof AGENT_HOOKS];

/** 各钩子载荷契约 */
export interface AgentHookPayloads {
  [AGENT_HOOKS.BEFORE_TOOL_CALL]: {
    toolName: string;
    args: unknown;
    sessionId: string;
    callId?: string;
  };
  [AGENT_HOOKS.AFTER_TOOL_CALL]: {
    toolName: string;
    args: unknown;
    result: ToolResult;
    sessionId: string;
    callId?: string;
  };
  [AGENT_HOOKS.AFTER_TOOL_FAILURE]: {
    toolName: string;
    args: unknown;
    result: ToolResult;
    sessionId: string;
    callId?: string;
  };
  [AGENT_HOOKS.SESSION_END]: { sessionId: string; agentId?: string };
}

/** 钩子处理器契约：按钩子名收窄载荷类型 */
export type AgentHookHandler<T extends AgentHookName = AgentHookName> = (
  payload: AgentHookPayloads[T],
) => void | Promise<void>;
