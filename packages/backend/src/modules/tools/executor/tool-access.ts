import { extractCommandText, isCommandTool } from './command-gate.util.js';

export type AccessDecision = { action: 'pass' | 'ask' | 'reject'; reason?: string };
export type AccessMode = 'ask' | 'auto' | 'yolo';
export function accessMode(config: { get<T>(section: string): T }): AccessMode {
  const mode = section(config, 'security')['yolo'];
  return mode === 'auto' || mode === 'yolo' ? mode : 'ask';
}
function section(config: { get<T>(section: string): T }, key: string): Record<string, any> {
  try { return config.get<Record<string, any>>(key) || {}; } catch { return {}; }
}

/** Shared by conversation, direct tools and unattended jobs. Explicit bans remain bans. */
export function toolAccess(input: {
  config: { get<T>(section: string): T };
  name: string; args: unknown; sessionId?: string | undefined; dangerous: boolean;
  commandGuard?: { isCommandBlacklisted(s: string): boolean; isCommandWhitelisted(s: string): boolean } | undefined;
  classify?: ((s: string) => { decision: string; reason: string }) | undefined;
  policy?: string | null | undefined;
}): AccessDecision {
  const { config, name, args, sessionId } = input;
  const security = section(config, 'security');
  const settings = section(config, 'tools')['toolSettings']?.[name] || {};
  // Older REST approval responses duplicated command rules/tool settings into broad
  // perm-auto rules. Use the original scoped decision, not that redundant expansion.
  const rules = Array.isArray(security['permissionRules']) ? security['permissionRules'].filter((r: any) =>
    r.tool === name && !(String(r.id || '').startsWith('perm-auto-') &&
      (isCommandTool(name) || settings.permission !== undefined || settings.disabled !== undefined))) : [];
  const cmd = isCommandTool(name) ? extractCommandText(name, args) : '';
  if (settings.disabled || settings.permission === 'disabled' || rules.some((r: any) => r.type === 'deny') || input.policy === 'deny')
    return { action: 'reject', reason: `工具 ${name} 已被明确禁用，请在权限设置中解除禁用` };
  if (cmd && input.commandGuard?.isCommandBlacklisted(cmd)) return { action: 'reject', reason: '命令已被明确加入黑名单' };
  if (accessMode(config) === 'yolo') return { action: 'pass' };
  const patterns = [...(security['alwaysApproved'] || []), ...(security['sessionApproved']?.[sessionId || ''] || [])];
  if (patterns.some((p: unknown) => typeof p === 'string' && [name, cmd].some(v => v && (p === v || (p.endsWith('*') && v.startsWith(p.slice(0, -1))))))) return { action: 'pass' };
  if (settings.permission === 'auto' || settings.permission === 'allow' || rules.some((r: any) => r.type === 'allow') || input.policy === 'allow') return { action: 'pass' };
  if (settings.permission === 'ask' || rules.some((r: any) => r.type === 'ask')) return { action: 'ask', reason: `工具 ${name} 设置为需要确认` };
  if (isCommandTool(name)) {
    if (cmd && input.commandGuard?.isCommandWhitelisted(cmd)) return { action: 'pass' };
    const risk = cmd ? input.classify?.(cmd) : undefined;
    if (accessMode(config) === 'auto' && risk?.decision === 'allow') return { action: 'pass' };
    return { action: 'ask', reason: risk?.reason || `执行命令前需要确认：${cmd || name}` };
  }
  const desktopRead = name === 'computer_use' && ['status', 'list_windows', 'list_roots', 'look', 'screenshot', 'zoom', 'read_text', 'wait_for'].includes(String((args as { action?: unknown } | null)?.action || ''));
  const browserRead = name === 'builtin_browser' && ['status', 'snapshot', 'screenshot', 'element', 'wait_for'].includes(String((args as { action?: unknown } | null)?.action || ''));
  return input.dangerous && !desktopRead && !browserRead ? { action: 'ask', reason: `工具 ${name} 将执行修改或外部操作，需要确认` } : { action: 'pass' };
}
