/**
 * 命令闸门共享工具（AgentLoop 审批判定与 ApprovalService 规则落盘共用）
 *
 * 安全模型（与用户确认的三层闸门设计一致）：
 *   - 命令类工具（bash/powershell/python/node/code_build/code_execution）
 *     走命令闸门：黑名单拒绝 → 白名单放行（用户规则 + 内置安全命令）→ 模式判定
 *   - 非命令工具走工具闸门：禁止 → 自动 → 模式判定
 *   - 三模式：yolo 完全信任 / ask 需要审批 / auto 智能安全（名单外静默拒绝）
 */

/** 命令类工具集合（其执行内容为终端命令/代码，走命令黑白名单） */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'python',
  'node',
  'code_build',
  'repo_verify',
  'code_execution',
]);

/** 判断工具是否为命令类工具 */
export function isCommandTool(toolName: string): boolean {
  return COMMAND_TOOLS.has(toolName);
}

/**
 * 从工具参数中提取命令文本（供黑白名单匹配与审批卡展示）。
 * 返回空串表示无法提取（如参数缺失）。
 */
export function extractCommandText(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  switch (toolName) {
    case 'repo_verify': return [str(a['command']), ...(Array.isArray(a['args']) ? a['args'].map(str) : [])].join(' ');
    case 'bash':
    case 'code_build':
    case 'code_execution':
      return str(a['command']) || str(a['cmd']) || str(a['script']);
    case 'powershell':
      return str(a['command']) || str(a['cmd']) || str(a['script']);
    case 'python':
      // 代码形态还原为实际执行形态，供危险模式识别（如代码内嵌 rm -rf）
      if (str(a['code'])) return `python -c ${str(a['code'])}`;
      if (str(a['script'])) return `python ${str(a['script'])}`;
      return '';
    case 'node':
      if (str(a['code'])) return `node -e ${str(a['code'])}`;
      if (str(a['script'])) return `node ${str(a['script'])}`;
      return '';
    default:
      return str(a['command']) || str(a['cmd']) || str(a['script']);
  }
}

/**
 * 包管理器/常见复合命令首词集合：
 * 这些命令的关键语义在第二个词（install/uninstall/push 等），
 * "始终允许 pip install" 只应豁免 install 子命令。
 */
const TWO_TOKEN_COMMANDS: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'gem',
  'apt', 'apt-get', 'choco', 'winget', 'scoop', 'go', 'docker', 'git',
  'kubectl', 'helm', 'terraform',
]);

/**
 * 从完整命令文本推导命令规则模式（glob，供 CommandGuard 白名单/黑名单匹配）。
 * 粒度：包管理器/复合命令取前两个词，其余取首词；模式形如 "pip install *"。
 * 返回空串表示无法推导。
 */
export function toCommandRulePattern(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const first = tokens[0]!.toLowerCase();
  if (TWO_TOKEN_COMMANDS.has(first) && tokens.length >= 2) {
    const second = tokens[1]!.toLowerCase();
    return `${first} ${second} *`;
  }
  return `${first} *`;
}
