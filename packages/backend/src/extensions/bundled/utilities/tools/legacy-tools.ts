import { runShell } from '../../shared/tools/shell-runner.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { PythonEnvService } from '../../../../modules/core/python/python-env.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import { WebSocketService } from '../../../../modules/core/websocket/websocket.service.js';
import { parseCommandSegments } from '../../../../modules/core/utils/exec-args.util.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { PluginService } from '../../../../modules/tools/plugin/plugin.service.js';
import { AgentService } from '../../../../modules/ai/agent/agent.service.js';
import { ToolPolicyService } from '../../../../modules/tools/tool-policy.service.js';
import { AskUserService } from '../../../../modules/tools/executor/ask-user.service.js';

const execFileAsync = promisify(execFile);

/** api_call 允许的 HTTP 方法（与 HttpClientService HttpMethod 对齐） */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
type AllowedHttpMethod = (typeof HTTP_METHODS)[number];

/** api_call 响应正文上限（50KB 文本） */
const API_CALL_BODY_LIMIT = 50 * 1024;

/** Windows Toast XML 文本转义（含 $，防 PowerShell here-string 注入，对齐旧版 misc.cjs） */
function escapeToastXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\$/g, '&#36;');
}

/** PowerShell 单引号字面量转义（'' 表示一个单引号） */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 经 PowerShell -EncodedCommand 执行脚本（base64 UTF-16LE 编码，
 * 免引号/编码转义问题，execFile 数组参数不经 shell）。
 */
function execPowerShell(script: string, timeoutMs: number): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeout: timeoutMs,
    windowsHide: true,
  }).then(() => undefined);
}

/**
 * 发送系统桌面通知（对齐旧版 misc.cjs notification L336-397）：
 * Windows: Toast（ToastNotificationManager）→ 失败降级 Balloon Tip；
 * macOS: osascript display notification；Linux: notify-send。
 * @returns 成功返回 null；失败返回错误信息（不 throw）
 */
async function sendDesktopNotification(title: string, message: string): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const toastPs = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
        '$template = @"<toast><visual><binding template="ToastText02"><text id="1">' + escapeToastXml(title) + '</text><text id="2">' + escapeToastXml(message) + '</text></binding></visual></toast>"@',
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$xml.LoadXml($template)',
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("SkyalyticWing").Show($toast)',
      ].join('\r\n');
      try {
        await execPowerShell(toastPs, 10_000);
        return null;
      } catch {
        // Toast 失败（如未注册 AUMID）降级 Balloon Tip（仿旧版 misc.cjs）
        const balloonPs = [
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          '$n = New-Object System.Windows.Forms.NotifyIcon',
          '$n.Icon = [System.Drawing.SystemIcons]::Information',
          '$n.Visible = $true',
          "$n.ShowBalloonTip(5000, '" + escapePsSingleQuote(title) + "', '" + escapePsSingleQuote(message) + "', 'Info')",
          'Start-Sleep -Seconds 6',
          '$n.Dispose()',
        ].join('\r\n');
        await execPowerShell(balloonPs, 10_000);
        return null;
      }
    }
    if (process.platform === 'darwin') {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execFileAsync(
        'osascript',
        ['-e', 'display notification "' + esc(message) + '" with title "' + esc(title) + '"'],
        { timeout: 10_000, windowsHide: true },
      );
      return null;
    }
    await execFileAsync('notify-send', [title, message], { timeout: 10_000, windowsHide: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split('\n')[0] : String(e);
  }
}

function fail(error: string): ToolResult {
  return { success: false, error };
}

/** 包装执行结果为失败 ToolResult（保持 stdout/stderr 可见） */
function failWithOutput(error: string, stdout: string, stderr: string): ToolResult {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const r: ToolResult = { success: false, error };
  if (combined) r.output = combined.slice(0, 8000);
  return r;
}

/**
 * git_operation 命令白名单（对齐旧版 tools/command.cjs，做安全收敛）：
 * - 移除 clone：`git clone ext::sh -c ...` 可经 ext transport 实现任意命令执行，
 *   且 clone URL 不受 SSRF 校验（内网探测出口）。需要 clone 时请走 bash 工具（dangerous 审批链）。
 * - 移除 clean：git clean 直接删文件不进回收站，风险过高（旧版仅允许 clean -n 但匹配逻辑失效）。
 * - 移除 config：`git config alias.<子命令> '!任意命令'` 可静默植入别名，随后经白名单内
 *   子命令免审批触发任意命令执行（alias 优先于内置子命令）。
 */
const GIT_COMMAND_ALLOWLIST = new Set([
  'add', 'status', 'log', 'diff', 'commit', 'push', 'pull', 'branch', 'checkout',
  'fetch', 'merge', 'rebase', 'stash', 'tag', 'show', 'remote', 'reset',
  'revert', 'cherry-pick', 'init', 'worktree', 'describe', 'shortlog',
  'reflog', 'blame', 'ls-files',
]);

/**
 * 旧版（1.3.3）遗留工具补齐：python / node / code_build / git_operation /
 * agent_reach_doctor / plugin_install / plugin_search /
 * ask_user / notification / browser_open / api_call / agent_list /
 * tool_policy_list / tool_policy_create。
 *
 * 安全模型（对齐 bash.ts）：
 * - python / node / code_build：dangerous=true，实际命令形态过 CommandGuard，
 *   走 agent 审批链；script/cwd 过 PathGuard。
 * - git_operation：白名单只读/常规操作（无 clone/clean），execFile 数组参数防注入。
 * - agent_reach_doctor：六平台并行体检（总预算 ≤5s，经 HttpClientService 含 SSRF 防护）
 * - plugin_install / plugin_search：桥接 PluginService（脱敏 PluginInfo）
 * - ask_user / notification / browser_open / api_call / agent_list /
 *   tool_policy_list / tool_policy_create：dangerous=false；ask_user 桥接
 *   AskUserService（WS 广播 + 等待回复或停止），notification 双通道（系统 Toast +
 *   WS 广播），browser_open/api_call 经 SSRF 校验，agent_list/tool_policy_* 懒解析
 *   AgentService / ToolPolicyService。
 *
 * （旧版 image 图像理解工具已随旧媒体套件清理移除——图片能力现仅保留
 *  统一模型体系的 image_generate / generate_image API 生成。）
 */
export function createLegacyTools(
  security: SecurityManagerService,
  http: HttpClientService,
  resolve: ServiceResolver,
  ws?: WebSocketService,
): ToolDefinition[] {
  /** PythonEnvService 懒解析（捆绑 Python 优先，回退系统解释器） */
  let pyEnvCache: PythonEnvService | undefined;
  let pyEnvResolved = false;
  const getPythonEnv = (): PythonEnvService | undefined => {
    if (!pyEnvResolved) {
      pyEnvCache = resolve(PythonEnvService);
      pyEnvResolved = true;
    }
    return pyEnvCache;
  };

  return [
    // ═══ python ═══
    {
      name: 'python',
      description:
        '执行Python代码（需审批）。通过 python/python3 命令运行Python脚本，支持数据分析、脚本执行等。',
      category: 'command',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的Python代码' },
          readOnly: { type: 'boolean', description: '纯查询设为 true，跳过撤销快照；修改文件时不要设置' },
          script: { type: 'string', description: '要执行的Python脚本路径（与code二选一，须在白名单内）' },
          cwd: { type: 'string', description: '工作目录，默认当前目录（须在白名单内）' },
        },
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { code?: string; script?: string; cwd?: string; readOnly?: boolean };
        if (!a.code && !a.script) return fail('必须提供 code 或 script 参数');
        const cwd = a.cwd || ctx.workspace || process.cwd();
        if (!security.isPathAllowed(cwd, 'write')) return fail(`工作目录被路径守卫拒绝: ${cwd}`);
        if (a.script && !security.isPathAllowed(resolvePath(a.script), 'read')) {
          return fail(`脚本路径被路径守卫拒绝: ${a.script}`);
        }

        // 候选顺序：捆绑解释器（安装即用）→ 系统解释器（PATH）
        const envBin = getPythonEnv()?.resolve()?.bin;
        const systemBins = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
        const candidates = [...new Set([...(envBin ? [envBin] : []), ...systemBins])];
        let lastErr = '';
        for (const bin of candidates) {
          // 守卫形态用规范命令名（bundled 绝对路径按 'python' 判定）：
          // 用户 deny 规则按 "python *" 等命令名书写，绝对路径形态会绕过规则
          const guardName = bin.includes('\\') || bin.includes('/') ? 'python' : bin;
          const guardForm = a.code ? `${guardName} -c <code>` : `${guardName} ${a.script}`;
          if (!security.isCommandAllowed(guardForm)) continue;
          try {
            // py 启动器需 ['-3','-c',code]；python/python3 直接 ['-c',code]
            const argv = bin === 'py'
              ? (a.code ? ['-3', '-c', a.code] : ['-3', a.script as string])
              : (a.code ? ['-c', a.code] : [a.script as string]);
            const result = await runShell(bin, argv, { cwd, readOnly: a.readOnly === true, timeout: 0, sessionId: ctx.sessionId, ...(ctx.signal ? {signal: ctx.signal} : {}) });
            if ((result.data as { errorCode?: string } | undefined)?.errorCode === 'ENOENT') {
              lastErr = result.error || 'ENOENT';
              continue;
            }
            return result;
          } catch (e) {
            const err = e as { code?: string; stdout?: string; stderr?: string; message?: string };
            // 仅"解释器不存在"才尝试下一候选；代码本身报错（exit 非 0）立即返回，
            // 防止同一份代码被多个解释器重复执行（副作用双跑）
            if (err.code !== 'ENOENT') {
              return failWithOutput(
                `Python 代码执行失败（${bin}）: ${(err.message ?? '').split('\n')[0]}`,
                err.stdout ?? '', err.stderr ?? '',
              );
            }
            lastErr = err.message ?? 'ENOENT';
          }
        }
        const hint = getPythonEnv()?.missingHint() ?? '未找到可用的 Python 解释器。';
        return fail(`Python 执行失败（解释器不可用或被命令守卫拒绝）: ${lastErr || hint}`);
      },
    },

    // ═══ node ═══
    {
      name: 'node',
      description: '执行Node.js代码（需审批）。通过 node -e 运行JavaScript代码，适用于脚本执行、数据处理等。',
      category: 'command',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的Node.js代码' },
          readOnly: { type: 'boolean', description: '纯查询设为 true，跳过撤销快照；修改文件时不要设置' },
          script: { type: 'string', description: '要执行的Node.js脚本路径（与code二选一，须在白名单内）' },
          cwd: { type: 'string', description: '工作目录，默认当前目录（须在白名单内）' },
        },
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { code?: string; script?: string; cwd?: string; readOnly?: boolean };
        if (!a.code && !a.script) return fail('必须提供 code 或 script 参数');
        const cwd = a.cwd || ctx.workspace || process.cwd();
        if (!security.isPathAllowed(cwd, 'write')) return fail(`工作目录被路径守卫拒绝: ${cwd}`);
        if (a.script && !security.isPathAllowed(resolvePath(a.script), 'read')) {
          return fail(`脚本路径被路径守卫拒绝: ${a.script}`);
        }
        const guardForm = a.code ? 'node -e <code>' : `node ${a.script}`;
        if (!security.isCommandAllowed(guardForm)) {
          return fail('node 命令被命令守卫拒绝（请配置规则如 "node *"）');
        }
        try {
          const argv = a.code ? ['-e', a.code] : [a.script as string];
          return await runShell(process.execPath, argv, { cwd, readOnly: a.readOnly === true, timeout: 0, sessionId: ctx.sessionId, ...(ctx.signal ? {signal: ctx.signal} : {}) });
        } catch (e) {
          return failWithOutput(`Node 执行失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
            (e as { stdout?: string }).stdout ?? '', (e as { stderr?: string }).stderr ?? '');
        }
      },
    },

    // ═══ code_build ═══
    {
      name: 'code_build',
      description:
        '构建代码项目（需审批）。自动检测项目类型（npm run build 或 make），也可指定构建命令。执行前会进行安全检查。',
      category: 'command',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '构建命令，默认根据项目类型自动选择(npm run build 或 make)' },
          cwd: { type: 'string', description: '工作目录，默认当前目录' },
        },
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { command?: string; cwd?: string };
        const cwd = resolvePath(a.cwd || ctx.workspace || process.cwd());
        if (!security.isPathAllowed(cwd, 'write')) return fail(`工作目录被路径守卫拒绝: ${cwd}`);

        let cmd = a.command;
        if (!cmd) {
          if (existsSync(join(cwd, 'package.json'))) cmd = 'npm run build';
          else if (existsSync(join(cwd, 'Makefile'))) cmd = 'make';
          else return fail('无法识别项目类型：目录下无 package.json 或 Makefile，请显式指定 command');
        }
        if (!security.isCommandAllowed(cmd)) return fail(`构建命令被命令守卫拒绝: ${cmd}`);

        try {
          // cmd.exe parses its own quoting. CRT escaping turns quoted scripts into
          // string literals (e.g. node -e "process.exit(7)" can falsely exit 0).
          if (process.platform === 'win32') return await runShell('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd, timeout: 0, sessionId: ctx.sessionId, ...(ctx.signal ? {signal: ctx.signal} : {}), windowsVerbatimArguments: true });
          const segments = parseCommandSegments(cmd);
          if (!segments) return fail('Unsupported shell syntax; use an explicit build script.');
          let result: ToolResult = { success: true }, output = '';
          for (let index = 0; index < segments.length; index++) {
            const segment = segments[index]!;
            if (index > 0 && ((segment.joiner === '&&' && !result.success) || (segment.joiner === '||' && result.success))) continue;
            result = await runShell(segment.argv[0]!, segment.argv.slice(1), { cwd, timeout: 0, sessionId: ctx.sessionId, ...(ctx.signal ? {signal: ctx.signal} : {}) });
            output += result.output || '';
            if ((result.data as { cancelled?: boolean; timedOut?: boolean } | undefined)?.cancelled || (result.data as { timedOut?: boolean } | undefined)?.timedOut) break;
          }
          return { ...result, output };
        } catch (e) {
          return failWithOutput(`构建失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
            (e as { stdout?: string }).stdout ?? '', (e as { stderr?: string }).stderr ?? '');
        }
      },
    },

    // ═══ git_operation ═══
    {
      name: 'git_operation',
      description:
        '执行Git操作（白名单校验）。支持常用git命令(add/status/log/diff/commit/push/pull/branch/checkout等)；不含 clone/clean（请走 bash 工具并经审批）。',
      category: 'command',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'git命令(如 status/log -3/commit -m "x" 等)' },
          repoPath: { type: 'string', description: '仓库路径，默认当前目录' },
        },
        required: ['command'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { command?: string; repoPath?: string };
        if (!a.command) return fail('必须提供 command 参数');
        const cwd = resolvePath(a.repoPath || ctx.workspace || process.cwd());
        if (!security.isPathAllowed(cwd, 'write')) return fail(`仓库路径被路径守卫拒绝: ${cwd}`);

        const parts = a.command.trim().split(/\s+/);
        const sub = parts[0];
        if (!GIT_COMMAND_ALLOWLIST.has(sub)) {
          return fail(`git 子命令不在白名单: ${sub}（允许: ${[...GIT_COMMAND_ALLOWLIST].sort().join('/')}；clone/clean/config 请走 bash 工具）`);
        }
        try {
          // 引号分组解析（支持 commit -m "message"、add "my file.txt"），
          // 管道/重定向等 shell 特性拒绝；子命令白名单已在上文校验
          const segments = parseCommandSegments(a.command.trim());
          if (!segments || segments.length !== 1) {
            return fail('git 命令含不支持的 shell 特性（管道/重定向/分号/复合命令），请拆分执行');
          }
          const argv = (segments[0] as { argv: string[] }).argv;
          if (argv[0] !== sub) return fail('git 命令解析异常');
          return await runShell('git', argv, { cwd, timeout: 0, sessionId: ctx.sessionId, ...(ctx.signal ? {signal: ctx.signal} : {}) });
        } catch (e) {
          return failWithOutput(`git ${sub} 失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
            (e as { stdout?: string }).stdout ?? '', (e as { stderr?: string }).stderr ?? '');
        }
      },
    },

    // ═══ agent_reach_doctor ═══
    {
      name: 'agent_reach_doctor',
      description:
        'Agent Reach 平台连通性体检（并行探测，≤5s）。检测各平台 API 是否可访问。返回每个平台的状态(ok/fail)和汇总。无需任何配置即可运行。',
      category: 'network',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: '可选：只检测指定平台(web/v2ex/bilibili/github/rss/exa)。不填则全部检测。' },
        },
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { platform?: string };
        const all: Array<{ id: string; url: string }> = [
          { id: 'web', url: 'https://www.baidu.com/robots.txt' },
          { id: 'v2ex', url: 'https://www.v2ex.com/api/topics/hot.json' },
          { id: 'bilibili', url: 'https://api.bilibili.com/x/web-interface/ranking/v2' },
          { id: 'github', url: 'https://api.github.com/zen' },
          { id: 'rss', url: 'https://rsshub.app/robots.txt' },
          { id: 'exa', url: 'https://api.exa.ai/' },
        ];
        const targets = a.platform ? all.filter((p) => p.id === a.platform) : all;
        if (targets.length === 0) return fail(`未知平台: ${a.platform}（可选: web/v2ex/bilibili/github/rss/exa）`);

        // 并行探测（Promise.allSettled），单平台 4s 超时，总预算 ≈ 4s
        const settled = await Promise.allSettled(
          targets.map(async (t) => {
            const res = await http.get<string>(t.url, { timeout: 4000, responseType: 'text' });
            return { platform: t.id, status: 'ok', httpStatus: res.status };
          }),
        );
        const results = settled.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : {
                platform: targets[i].id,
                status: 'fail',
                // SSRF/超时等错误消息可能含完整 URL（含凭证），只保留首行
                error: r.reason instanceof Error ? r.reason.message.split('\n')[0] : String(r.reason),
              },
        );
        const okCount = results.filter((r) => r['status'] === 'ok').length;
        return {
          success: true,
          output: JSON.stringify({ summary: `${okCount}/${results.length} 可达`, results }, null, 2),
          data: { summary: `${okCount}/${results.length}`, results } as unknown as Record<string, unknown>,
        };
      },
    },

    // ═══ plugin_install ═══
    {
      name: 'plugin_install',
      description: '安装插件。从本地路径安装插件。',
      category: 'plugin',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '插件来源（本地路径）' },
        },
        required: ['source'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { source?: string };
        if (!a.source) return fail('必须提供 source 参数');
        if (!security.isPathAllowed(resolvePath(a.source), 'read')) return fail(`插件路径被路径守卫拒绝: ${a.source}`);

        const plugins = resolve(PluginService);
        if (!plugins) return fail('PluginService 未初始化，插件安装不可用');
        try {
          const info = await plugins.installPlugin(a.source);
          return {
            success: true,
            output: `插件已安装: ${JSON.stringify(info)}`,
            data: info as unknown as Record<string, unknown>,
          };
        } catch (e) {
          return fail(`插件安装失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        }
      },
    },

    // ═══ plugin_search ═══
    {
      name: 'plugin_search',
      description: '搜索可用插件。在本地插件目录中按关键词搜索插件（返回脱敏信息）。',
      category: 'plugin',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: { type: 'string', description: '插件类型过滤' },
        },
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { query?: string; type?: string };
        const plugins = resolve(PluginService);
        if (!plugins) return fail('PluginService 未初始化，插件搜索不可用');
        try {
          // listPlugins() 返回脱敏 PluginInfo（不含 _manifest/_path 等内部字段）
          const list = plugins.listPlugins();
          const q = (a.query ?? '').toLowerCase();
          const filtered = list.filter((p) => {
            const rec = p as unknown as Record<string, unknown>;
            const name = String(rec['name'] ?? rec['id'] ?? '').toLowerCase();
            const desc = String(rec['description'] ?? '').toLowerCase();
            const typeOk = !a.type || rec['type'] === a.type;
            return typeOk && (!q || name.includes(q) || desc.includes(q));
          });
          return {
            success: true,
            output: JSON.stringify({ total: filtered.length, plugins: filtered }, null, 2),
            data: { total: filtered.length, plugins: filtered } as unknown as Record<string, unknown>,
          };
        } catch (e) {
          return fail(`插件搜索失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        }
      },
    },

    // ═══ ask_user ═══
    {
      name: 'ask_user',
      description:
        '向用户提问并等待选择或输入，直到用户回复、取消回答或停止任务。前端同时提供选项和自由输入框，可填写文件路径；multiple=true 允许多选。适合需求不确定时澄清，等待期间不能自行假设用户已同意；用户取消回答也不代表批准替代方案。',
      category: 'interactive',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '候选选项列表（建议 2-4 个；空数组或不传表示自由输入）',
          },
          multiple: { type: 'boolean', description: '是否允许多选，默认 false' },
        },
        required: ['question'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { question?: string; options?: string[]; multiple?: boolean };
        if (!a.question || typeof a.question !== 'string') return fail('必须提供 question 参数');
        const askUser = resolve(AskUserService);
        if (!askUser) return fail('AskUserService 未初始化，用户提问不可用');
        const options = Array.isArray(a.options)
          ? a.options.filter((o) => typeof o === 'string')
          : [];
        const r = await askUser.askUser({
          sessionId: ctx.sessionId,
          question: a.question,
          options,
          ...(a.multiple !== undefined ? { multiple: a.multiple } : {}),
        }, ctx.signal);
        if (!r.answered || !r.answer || r.answer.length === 0) return fail(r.error ?? '用户未回复');
        return { success: true, output: r.answer.join('\n') };
      },
    },

    // ═══ notification ═══
    {
      name: 'notification',
      description:
        '发送系统桌面通知（Windows Toast/Balloon Tip、macOS 通知中心、Linux notify-send），并同步经 WebSocket 广播给已连接的前端客户端。用于提醒用户重要事件或任务完成。',
      category: 'interactive',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '通知标题' },
          body: { type: 'string', description: '通知内容' },
        },
        required: ['title'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { title?: string; body?: string };
        const title = typeof a.title === 'string' && a.title ? a.title : 'SkyalyticWing';
        const body = typeof a.body === 'string' ? a.body : '';
        if (!body) return fail('请提供通知内容（body）');

        // WebSocket 广播给前端客户端（未注入 ws 时跳过，仅系统桌面通知）
        if (ws) {
          ws.broadcast({
            type: 'notification',
            data: { title, message: body, level: 'info', sessionId: ctx.sessionId },
          });
        }

        // 系统桌面通知（失败降级为错误信息，不 throw）
        const sysErr = await sendDesktopNotification(title, body);
        if (sysErr) {
          return ws
            ? { success: true, output: 'WebSocket 通知已广播；系统桌面通知失败: ' + sysErr }
            : fail('系统桌面通知失败: ' + sysErr);
        }
        return { success: true, output: '通知已发送: ' + title };
      },
    },

    // ═══ browser_open ═══
    {
      name: 'browser_open',
      description: '使用系统默认浏览器打开指定 URL（仅允许 http/https 协议，经 SSRF 校验）。',
      category: 'network',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的 URL（仅 http/https）' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { url?: string };
        const url = typeof a.url === 'string' ? a.url.trim() : '';
        if (!url) return fail('必须提供 url 参数');
        // 仅允许 http/https 协议（阻止 file:///、javascript:、data: 等）
        if (!/^https?:\/\//i.test(url)) return fail('仅允许 http/https URL');
        // URL 含双引号会破坏 Windows cmd 引号包裹（防注入）
        if (url.includes('"')) return fail('URL 含非法字符（双引号）');
        // SSRF 校验（同步快速通道，fail-close）
        if (!security.checkUrlSync(url)) return fail('URL 被 SSRF 防护拒绝: ' + url);
        try {
          // Windows 下双引号包裹 URL，防止 & | ; 等被 cmd 解析为命令分隔符（对齐旧版 network.cjs）
          const child =
            process.platform === 'win32'
              ? spawn('cmd.exe', ['/c', 'start', '', '"' + url + '"'], {
                  detached: true,
                  stdio: 'ignore',
                  windowsHide: true,
                })
              : process.platform === 'darwin'
                ? spawn('open', [url], { detached: true, stdio: 'ignore', windowsHide: true })
                : spawn('xdg-open', [url], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          return { success: true, output: '已在系统默认浏览器打开: ' + url };
        } catch (e) {
          return fail('打开浏览器失败: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)));
        }
      },
    },

    // ═══ api_call ═══
    {
      name: 'api_call',
      description:
        '调用外部 API 接口（简化版）。发送 HTTP 请求并返回状态码与响应正文（经 SSRF 防护校验，正文截断至 50KB）。',
      category: 'network',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP 方法，默认 GET',
          },
          url: { type: 'string', description: '请求 URL（仅 http/https）' },
          headers: { type: 'object', description: '自定义请求头（键值对）' },
          body: { type: 'string', description: '请求体（字符串或 JSON 对象）' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as {
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          body?: unknown;
        };
        const url = typeof a.url === 'string' ? a.url.trim() : '';
        if (!url) return fail('必须提供 url 参数');
        if (!/^https?:\/\//i.test(url)) return fail('仅允许 http/https URL');
        const rawMethod = typeof a.method === 'string' && a.method ? a.method.toUpperCase() : 'GET';
        if (!(HTTP_METHODS as readonly string[]).includes(rawMethod)) {
          return fail('不支持的 HTTP 方法: ' + a.method + '（允许: ' + HTTP_METHODS.join('/') + '）');
        }
        // SSRF 校验：同步快速通道 + 异步完整校验（含 DNS 解析，fail-close）
        if (!security.checkUrlSync(url)) return fail('URL 被 SSRF 防护拒绝: ' + url);
        try {
          const ssrf = await security.checkUrl(url);
          if (!ssrf.safe) return fail('SSRF防护: ' + (ssrf.reason || '不允许访问该地址'));
        } catch (e) {
          return fail('SSRF检查失败，请求被拒绝: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)));
        }

        const headers =
          a.headers && typeof a.headers === 'object' && !Array.isArray(a.headers)
            ? a.headers
            : undefined;
        try {
          const res = await http.request<string>(
            rawMethod as AllowedHttpMethod,
            url,
            {
              ...(headers ? { headers } : {}),
              responseType: 'text',
              timeout: 30_000,
            },
            a.body,
          );
          const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
          const bodyText =
            text.length > API_CALL_BODY_LIMIT
              ? text.slice(0, API_CALL_BODY_LIMIT) + '\n...(响应正文超过 50KB 已截断)'
              : text;
          return {
            success: true,
            output: 'HTTP ' + res.status + '\n' + (bodyText || '(空响应)'),
            data: { status: res.status },
          };
        } catch (e) {
          return fail('API 调用失败: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)));
        }
      },
    },

    // ═══ agent_list ═══
    {
      name: 'agent_list',
      description:
        '列出所有可用的母代理（id/名称/描述/类型/能力）。用于选择通信目标或了解当前代理阵容，可按能力过滤。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          capability: { type: 'string', description: '按能力过滤（如 code/doc/data/ops/search）' },
        },
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { capability?: string };
        const agentSvc = resolve(AgentService);
        if (!agentSvc) return fail('AgentService 未初始化，代理列表不可用');
        const cap = typeof a.capability === 'string' ? a.capability.toLowerCase() : '';
        const agents = agentSvc
          .listAgents()
          .filter((ag) => !cap || (ag.capabilities ?? []).some((c) => c.toLowerCase().includes(cap)))
          .map((ag) => ({
            id: ag.id,
            name: ag.name,
            description: ag.description,
            type: ag.type ?? 'specialist',
            capabilities: ag.capabilities ?? [],
          }));
        if (agents.length === 0) return { success: true, output: '(没有匹配的代理)' };
        const lines = agents.map(
          (ag) =>
            '- ' + ag.id + ' | ' + ag.name + ' | 类型: ' + ag.type + ' | 能力: ' + (ag.capabilities.join(',') || '-') + '\n  ' + (ag.description || '(无描述)'),
        );
        return {
          success: true,
          output: '共 ' + agents.length + ' 个代理:\n' + lines.join('\n'),
          data: { total: agents.length, agents },
        };
      },
    },

    // ═══ tool_policy_list ═══
    {
      name: 'tool_policy_list',
      description: '列出所有工具策略（名称与 allow/deny 规则数量）。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        const policySvc = resolve(ToolPolicyService);
        if (!policySvc) return fail('ToolPolicyService 未初始化，策略列表不可用');
        const policies = policySvc.listPolicies();
        if (policies.length === 0) return { success: true, output: '(暂无策略)' };
        const lines = policies.map(
          (pl) => '- ' + pl.name + ': allow ' + pl.allow + ' 条 / deny ' + pl.deny + ' 条',
        );
        return {
          success: true,
          output: '共 ' + policies.length + ' 条策略:\n' + lines.join('\n'),
          data: { total: policies.length, policies },
        };
      },
    },

    // ═══ tool_policy_create ═══
    {
      name: 'tool_policy_create',
      description:
        '创建（或覆盖）自定义工具策略。allow/deny 均为工具名 glob 模式（支持 * 与 ?），deny 优先；allow 为空数组表示放行全部。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '策略名称' },
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: '允许的工具名列表（空数组=允许全部）',
          },
          deny: {
            type: 'array',
            items: { type: 'string' },
            description: '禁止的工具名列表（支持通配符如 desktop_*）',
          },
        },
        required: ['name'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { name?: string; allow?: string[]; deny?: string[] };
        if (!a.name || typeof a.name !== 'string') return fail('必须提供 name 参数');
        const policySvc = resolve(ToolPolicyService);
        if (!policySvc) return fail('ToolPolicyService 未初始化，策略创建不可用');
        const allow = Array.isArray(a.allow) ? a.allow.filter((x) => typeof x === 'string') : [];
        const deny = Array.isArray(a.deny) ? a.deny.filter((x) => typeof x === 'string') : [];
        try {
          policySvc.registerPolicy(a.name, { allow, deny });
          return {
            success: true,
            output: '策略已创建: ' + a.name + '（allow ' + allow.length + ' 条 / deny ' + deny.length + ' 条）',
          };
        } catch (e) {
          return fail('创建策略失败: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)));
        }
      },
    },
  ];
}
