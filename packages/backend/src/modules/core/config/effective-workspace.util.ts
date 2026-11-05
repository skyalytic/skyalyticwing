import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultDataDir } from '../utils/web-data.util.js';

/**
 * 产物有效工作目录解析（IDE 工程模式核心）。
 *
 * 规则（与产品设定一致）：
 *   1. 用户选择了项目文件夹（config general.projectDir）→ 一切产物/相对路径操作落工程目录
 *   2. 未选择 → 落智能体工作目录（dataDir/workspaces/<agentId>，与智能体页面"工作区管理"同一目录）
 *   3. agentId 缺失时回退内置智能体 'agent' 的工作区；dataDir 解析失败才用 process.cwd()
 *
 * projectDir 读取器由 FilesService 构造时注册（ConfigService 是配置的内存权威，
 * 避免每个 ctx.workspace 构造点都注入 ConfigService）。
 */

let projectDirProvider: () => string = () => '';
let sessionProjectDirProvider: (sessionId: string) => string = () => '';

/** 注册 projectDir 读取器（应用启动时由 FilesService 接线一次） */
export function registerProjectDirProvider(fn: () => string): void {
  projectDirProvider = fn;
}

/** 注册会话级项目目录读取器（应用启动时由 FilesService 接线一次） */
export function registerSessionProjectDirProvider(fn: (sessionId: string) => string): void {
  sessionProjectDirProvider = fn;
}

/** 读取当前工程目录（空串=未选择） */
export function getProjectDir(): string {
  try {
    return projectDirProvider() || '';
  } catch {
    return '';
  }
}

/** 读取会话绑定的项目目录（空串=该会话未绑定） */
export function getSessionProjectDir(sessionId?: string): string {
  if (!sessionId) return '';
  try {
    return sessionProjectDirProvider(sessionId) || '';
  } catch {
    return '';
  }
}

/**
 * 解析智能体工作目录：${dataDir}/workspaces/<agentId>（与 agent.controller
 * resolveWorkspaceDir 同一套 sanitize 与 dataDir 规则，保持单一事实来源语义）。
 */
export function resolveAgentWorkspaceDir(agentId?: string): string {
  const safe = String(agentId || 'agent')
    .replace(/\.\./g, '')
    .replace(/[\\/]/g, '') || 'agent';
  return resolve(getDefaultDataDir(), 'workspaces', safe);
}

/**
 * 解析有效工作目录（产物落点统一入口）：
 * 会话绑定的项目目录（须存在）→ 全局工程目录（须存在）→ 智能体工作目录 → process.cwd() 兜底。
 * 规则：一个项目文件夹可被多个会话绑定；一个会话同时只绑定一个项目文件夹。
 * 所有 ToolContext.workspace 构造点统一使用，保证 AI 相对路径操作与产物落点一致。
 */
export function resolveEffectiveWorkspace(agentId?: string, sessionId?: string): string {
  const spd = getSessionProjectDir(sessionId);
  if (spd && existsSync(spd)) return spd;
  // A conversation with no project must not inherit a different conversation's folder.
  const pd = sessionId ? '' : getProjectDir();
  if (pd && existsSync(pd)) return pd;
  try {
    return resolveAgentWorkspaceDir(agentId);
  } catch {
    return process.cwd();
  }
}
