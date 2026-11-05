import { runShell } from '../../shared/tools/shell-runner.js';
import { createTuiTools } from '../../shared/tools/tui-tools.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { SafetyManagerService } from '../../../../modules/core/security/safety-manager.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { SubagentService } from '../../../../modules/ai/agent/subagent.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';
import { PythonEnvService } from '../../../../modules/core/python/python-env.service.js';


/** cli_anything 执行超时 */



function fail(error: string): ToolResult {
  return { success: false, error };
}

/** 清洗 cli-anything 的软件名/命令参数（对齐旧版字符白名单） */
function sanitizeToken(s: unknown, allowSpace = false): string {
  const pattern = allowSpace ? /[^a-zA-Z0-9_\-.:/\s="']/g : /[^a-zA-Z0-9_\-.:/]/g;
  return String(s || '').replace(pattern, '');
}

/**
 * 杂项域内置工具（移植自旧版 misc.cjs / file.cjs）：
 * btw_ask / cli_anything / apply_patch / diff / tui_*。
 *
 * - cli_anything：命令经 SecurityManagerService.isCommandAllowed（CommandGuard）
 * - apply_patch / diff：路径经 PathGuard（isPathAllowed），补丁解析复用 SafetyManagerService
 * - tui_*：本地文字交互会话与模型任务
 */
export function createMiscTools(
  security: SecurityManagerService,
  safety: SafetyManagerService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  return [
    // ═══ btw_ask ═══
    {
      name: 'btw_ask',
      description:
        '旁路提问（/btw）：不打断当前主对话，由轻量隔离 LLM 会话快速回答一个临时问题，' +
        '不使用工具、不影响主任务流程。',
      category: 'interactive',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '旁路问题' },
        },
        required: ['question'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = args as { question?: string };
        if (!a || typeof a.question !== 'string' || a.question.length === 0) {
          return fail('Parameter "question" is required');
        }
        const subagent = resolve(SubagentService);
        if (!subagent) return fail('SubagentService 未初始化，旁路提问不可用');
        try {
          const r = await subagent.handleBtw(a.question, ctx.sessionId);
          return jsonOut(r);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ cli_anything ═══
    {
      name: 'cli_anything',
      description:
        '通过 CLI-Anything 操作桌面软件（gimp/blender/libreoffice/obs 等，pip 包 cli-anything-<software>）。' +
        '将 GUI 软件转为命令行操作。action=list/run/install/search/info。命令须经命令守卫校验。',
      category: 'shell',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'run', 'install', 'search', 'info'],
            description: 'list=列出已装 CLI；run=执行命令；install=安装；search=搜索；info=CLI 详情',
          },
          software: { type: 'string', description: '软件名（如 gimp/blender/libreoffice/obs）' },
          command: { type: 'string', description: 'CLI 子命令（如 "project new --width 1920"）' },
          jsonOutput: { type: 'boolean', description: 'JSON 输出模式（默认 true）' },
          args: { type: 'string', description: '额外参数' },
        },
        required: ['action'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as {
          action?: string; software?: string; command?: string; jsonOutput?: boolean; args?: string;
        };
        const action = a.action || 'list';
        const software = sanitizeToken(a.software);
        const command = sanitizeToken(a.command, true);
        const useJson = a.jsonOutput !== false;

        const runCli = async (cmd: string, cliArgs: string[]) => {
          if (!security.isCommandAllowed([cmd, ...cliArgs].join(' '))) {
            return { success: false as const, error: `Command blocked by guard: ${cmd} ${cliArgs.join(' ')}`, blocked: true };
          }
          const result = await runShell(cmd, cliArgs, {cwd:ctx.workspace || process.cwd(), sessionId:ctx.sessionId, ...(ctx.signal ? {signal:ctx.signal} : {})});
          if (!result.success) return {success:false as const,error:result.error || result.output || 'Command failed'};
          return { success: true as const, stdout: result.output || '' };
        };

        try {
          if (action === 'list') {
            const python = resolve(PythonEnvService)?.resolve();
            if (!python) return fail('CLI-Anything 需要可用的 Python 和 pip，请先配置 Python 环境。');
            const r = await runCli(python.bin, ['-m', 'pip', 'list', '--format=json']);
            if (!r.success) return fail(r.error);
            let pkgs: Array<{ name?: string; version?: string }> = [];
            try {
              pkgs = JSON.parse(r.stdout || '[]');
            } catch {
              pkgs = [];
            }
            const cliPkgs = pkgs.filter((p) => (p.name || '').includes('cli-anything'));
            if (cliPkgs.length === 0) {
              return jsonOut({
                installed: [],
                note: 'CLI-Anything 未安装。使用 action=install 安装，或运行: pip install cli-anything-<software>',
              });
            }
            return jsonOut({ installed: cliPkgs.map((p) => ({ name: p.name, version: p.version })) });
          }
          if (action === 'search') {
            const r = await runCli('cli-hub', ['search', software, '--json']);
            if (!r.success) return fail(r.error);
            try {
              return jsonOut({ results: JSON.parse(r.stdout || '[]') });
            } catch {
              return jsonOut({ results: r.stdout });
            }
          }
          if (action === 'install') {
            if (!software) return fail('请提供 software（如 gimp/blender/libreoffice）');
            const python = resolve(PythonEnvService)?.resolve();
            if (!python) return fail('CLI-Anything 需要可用的 Python 和 pip，请先配置 Python 环境。');
            const r = await runCli(python.bin, ['-m', 'pip', 'install', `cli-anything-${software}`]);
            if (!r.success) return fail(r.error);
            return jsonOut({ installed: `cli-anything-${software}`, output: r.stdout.trim() });
          }
          if (action === 'info') {
            if (!software) return fail('请提供 software');
            const r = await runCli(`cli-anything-${software}`, ['--help']);
            if (!r.success) return fail(r.error);
            return jsonOut({ software, help: r.stdout.trim() });
          }
          if (action === 'run') {
            if (!software) return fail('请提供 software');
            if (!command) return fail('请提供 command（如 "project new --width 1920"）');
            const cliArgs = [
              ...(useJson ? ['--json'] : []),
              ...command.split(/\s+/).filter(Boolean),
              ...sanitizeToken(a.args, true).split(/\s+/).filter(Boolean),
            ];
            const r = await runCli(`cli-anything-${software}`, cliArgs);
            if (!r.success) return fail(r.error);
            if (useJson) {
              try {
                return jsonOut({ software, command, result: JSON.parse(r.stdout) });
              } catch {
                // 非合法 JSON 时按原样返回
              }
            }
            return { success: true, output: r.stdout.trim() };
          }
          return fail(`未知 action: ${action}`);
        } catch (err) {
          const e = err as { stderr?: string; code?: number | string; message?: string };
          return fail(`Command failed: ${(e.stderr || e.message || '').slice(0, 1000)}`);
        }
      },
    },

    // ═══ apply_patch ═══
    {
      name: 'apply_patch',
      description:
        '一次应用多块文件补丁（比 file-edit 更高效）。支持 search/replace 补丁列表与' +
        'unified diff 格式（SafetyManager 补丁解析），search 未命中时按编辑距离模糊匹配兜底。' +
        '路径须经 PathGuard 白名单。',
      category: 'file',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件绝对路径' },
          patches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: '要查找的文本' },
                replace: { type: 'string', description: '替换后的文本' },
              },
              required: ['search', 'replace'],
            },
            description: '补丁列表（与 unified_diff 二选一）',
          },
          unified_diff: { type: 'string', description: 'unified diff 格式补丁（与 patches 二选一）' },
        },
        required: ['file_path'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as {
          file_path?: string; patches?: Array<{ search?: string; replace?: string }>; unified_diff?: string;
        };
        if (typeof a.file_path !== 'string' || a.file_path.length === 0) {
          return fail('缺少 file_path');
        }
        const patches = Array.isArray(a.patches) ? a.patches : [];
        const diffText = typeof a.unified_diff === 'string' ? a.unified_diff : '';
        if (patches.length === 0 && !diffText) return fail('缺少 patches 或 unified_diff');
        const filePath = resolvePath(ctx.workspace, a.file_path);
        if (!security.isPathAllowed(filePath, 'write')) {
          return { success: false, error: `路径不在白名单内: ${filePath}`, blocked: true };
        }
        try {
          if (!existsSync(filePath)) return fail(`文件不存在: ${a.file_path}`);
          let content = readFileSync(filePath, 'utf-8');
          let applied = 0;

          // 模式 1: unified diff（SafetyManagerService 补丁解析）
          if (diffText) {
            const hunks = safety.parseUnifiedDiff(diffText);
            if (hunks.length > 0) {
              content = safety.applyHunks(content, hunks);
              applied = hunks.length;
            }
          }

          // 模式 2: search/replace 补丁（精确 → 模糊兜底）
          for (const p of patches) {
            if (typeof p.search !== 'string' || typeof p.replace !== 'string') continue;
            const idx = content.indexOf(p.search);
            if (idx >= 0) {
              content = content.substring(0, idx) + p.replace + content.substring(idx + p.search.length);
              applied++;
            } else {
              const fuzzy = safety.fuzzyFind(content, p.search, Math.floor(p.search.length * 0.15));
              if (fuzzy.found && fuzzy.start >= 0 && fuzzy.match) {
                content =
                  content.substring(0, fuzzy.start) + p.replace +
                  content.substring(fuzzy.start + fuzzy.match.length);
                applied++;
              }
            }
          }

          writeFileSync(filePath, content, 'utf-8');
          ctx.log('info', `apply_patch: ${applied} applied to ${a.file_path}`);
          return jsonOut({ applied, total: patches.length || applied, file: a.file_path });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ diff ═══
    {
      name: 'diff',
      description:
        '比较两个文件（或两段文本）的差异，输出行级变更（- 旧行 / + 新行）。' +
        '文件路径须经 PathGuard 读白名单。',
      category: 'file',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          file1: { type: 'string', description: '第一个文件路径（与 text1 二选一）' },
          file2: { type: 'string', description: '第二个文件路径（与 text2 二选一）' },
          text1: { type: 'string', description: '第一段文本（可选）' },
          text2: { type: 'string', description: '第二段文本（可选）' },
          label1: { type: 'string', description: '第一个文件标签（可选）' },
          label2: { type: 'string', description: '第二个文件标签（可选）' },
        },
        required: [],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as {
          file1?: string; file2?: string; text1?: string; text2?: string; label1?: string; label2?: string;
        };
        try {
          let t1 = typeof a.text1 === 'string' ? a.text1 : undefined;
          let t2 = typeof a.text2 === 'string' ? a.text2 : undefined;
          if (a.file1) {
            const p1 = resolvePath(ctx.workspace, a.file1);
            if (!security.isPathAllowed(p1, 'read')) {
              return { success: false, error: `路径不在白名单内: ${p1}`, blocked: true };
            }
            if (!existsSync(p1)) return fail(`文件不存在: ${a.file1}`);
            t1 = readFileSync(p1, 'utf-8');
          }
          if (a.file2) {
            const p2 = resolvePath(ctx.workspace, a.file2);
            if (!security.isPathAllowed(p2, 'read')) {
              return { success: false, error: `路径不在白名单内: ${p2}`, blocked: true };
            }
            if (!existsSync(p2)) return fail(`文件不存在: ${a.file2}`);
            t2 = readFileSync(p2, 'utf-8');
          }
          if (t1 === undefined && t2 === undefined) return fail('请提供 file1/file2 或 text1/text2');
          const l1 = (t1 || '').split('\n');
          const l2 = (t2 || '').split('\n');
          const out: string[] = [];
          let changes = 0;
          const max = Math.max(l1.length, l2.length);
          for (let i = 0; i < max; i++) {
            const x = i < l1.length ? l1[i] : undefined;
            const y = i < l2.length ? l2[i] : undefined;
            if (x !== y) {
              changes++;
              if (x !== undefined) out.push(`- ${i + 1}: ${x}`);
              if (y !== undefined) out.push(`+ ${i + 1}: ${y}`);
            }
          }
          return jsonOut({
            changes,
            diff: out.join('\n'),
            labels: { left: a.label1 || a.file1 || 'text1', right: a.label2 || a.file2 || 'text2' },
            lines: { left: l1.length, right: l2.length },
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    ...createTuiTools(resolve),
  ];
}
