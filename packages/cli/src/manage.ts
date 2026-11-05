import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareSession, bindProject } from './commands/run.js';
import type { TurnEvent } from './commands/run.js';
import { watchToolApprovals } from './tool-approval.js';
import { TurnProgress } from './progress.js';
import type { CliOptions } from './args.js';
import { apiFetch, DEFAULT_BASE_URL, type ApiFetchInit } from './http.js';

export async function manage(
  command: string,
  args: string[],
  options: CliOptions,
  approve?: (event: TurnEvent) => Promise<string>,
): Promise<void> {
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const call = async (path: string, init?: ApiFetchInit) => {
    const result = await apiFetch(base, path, init);
    console.log(JSON.stringify(result.data, null, options.jsonl ? undefined : 2));
    return result.data;
  };
  const encoded = (value?: string) => {
    if (!value) throw new Error('缺少 ID 或参数');
    return encodeURIComponent(value);
  };
  const session = () => encoded(options.session);
  const payload = async () => {
    if (!options.dataFile)
      throw new Error('请用 --data-file 指定 JSON 文件（密钥不要直接放在命令行）');
    return JSON.parse(await readFile(options.dataFile, 'utf8')) as unknown;
  };
  const tool = async (name: string, input: Record<string, unknown>) => {
    const fresh = !options.session;
    await prepareSession(options);
    await bindProject(options, fresh);
    if (fresh) console.error(`会话：${options.session}（后续预览应用使用 --session）`);
    const controller = new AbortController();
    const stop = () => {
      console.error('正在停止命令…');
      void apiFetch(base, '/api/chat/stop', {
        method: 'POST',
        body: { sessionId: options.session },
      })
        .catch((error) => console.error(String(error)))
        .finally(() => controller.abort());
    };
    process.once('SIGINT', stop);
    const progress = new TurnProgress(!options.json && !options.jsonl);
    progress.set(`正在执行 ${name}…（Ctrl+C 停止）`);
    const approvals = watchToolApprovals(base, options.session!, controller.signal, approve);
    try {
      return await call('/api/tool/execute', {
        method: 'POST',
        body: { tool: name, args: input, sessionId: options.session },
        timeoutMs: 0,
        signal: controller.signal,
      });
    } finally {
      controller.abort();
      progress.stop();
      process.removeListener('SIGINT', stop);
      await approvals;
    }
  };
  switch (command) {
    case 'lsp': {
      if (!args[0] || args[0] === 'servers') {
        await call('/api/lsp/servers');
        return;
      }
      if (args[0] === 'apply') {
        if (!options.session || !args[1])
          throw new Error('lsp apply <预览ID> --session <原会话ID>');
        await tool('lsp_apply', { id: args[1] });
        return;
      }
      const input = options.dataFile
        ? ((await payload()) as Record<string, unknown>)
        : {
            file: args[1],
            line: args[2] ? Number(args[2]) : 1,
            col: args[3] ? Number(args[3]) : 1,
            ...(args[4] ? { newName: args[4] } : {}),
          };
      if (typeof input['file'] !== 'string')
        throw new Error('lsp <操作> <文件> [行 列 新名称]，或 --data-file JSON');
      await tool('lsp_query', {
        ...input,
        action: args[0],
        file: resolve(options.cwd ?? process.cwd(), input['file']),
        root: resolve(options.cwd ?? process.cwd()),
      });
      return;
    }
    case 'repo': {
      const root = resolve(options.cwd ?? process.cwd());
      if (!args[0] || args[0] === 'inspect') {
        await tool('repo_inspect', { root });
        return;
      }
      if (args[0] === 'verify') {
        const input = options.dataFile
          ? ((await payload()) as Record<string, unknown>)
          : { command: args[1], args: args.slice(2) };
        if (typeof input['command'] !== 'string')
          throw new Error('repo verify <程序> [参数...]，或 --data-file JSON');
        await tool('repo_verify', { ...input, root });
        return;
      }
      break;
    }
    case 'journal':
      if (!options.session) throw new Error('journal --session <会话ID>');
      await tool('task_journal', {});
      return;
    case 'sessions':
      await call('/api/sessions');
      return;
    case 'history':
      await call(`/api/sessions/${session()}/messages`);
      return;
    case 'status':
      await call('/api/status/full');
      return;
    case 'tools':
      await call('/api/tools');
      return;
    case 'skills':
      if (!args[0] || args[0] === 'list') {
        await call('/api/skills');
        return;
      }
      if (args[0] === 'show') {
        await call(`/api/skill-content?id=${encoded(args[1])}`);
        return;
      }
      if (args[0] === 'add' || args[0] === 'update') {
        await call('/api/skills', {
          method: args[0] === 'add' ? 'POST' : 'PUT',
          body: await payload(),
        });
        return;
      }
      if (args[0] === 'remove') {
        await call(`/api/skills/${encoded(args[1])}`, { method: 'DELETE' });
        return;
      }
      break;
    case 'mcp':
      if (!args[0] || args[0] === 'list') {
        await call('/api/mcp/servers');
        return;
      }
      if (args[0] === 'add') {
        await call('/api/mcp/servers', { method: 'POST', body: await payload() });
        return;
      }
      if (args[0] === 'update') {
        await call(`/api/mcp/servers/${encoded(args[1])}`, {
          method: 'PUT',
          body: await payload(),
        });
        return;
      }
      if (args[0] === 'remove') {
        await call(`/api/mcp/servers/${encoded(args[1])}`, { method: 'DELETE' });
        return;
      }
      if (['start', 'stop', 'tools'].includes(args[0])) {
        await call(`/api/mcp/servers/${encoded(args[1])}/${args[0]}`, {
          method: args[0] === 'tools' ? 'GET' : 'POST',
        });
        return;
      }
      break;
    case 'plugins':
      await call('/api/plugins');
      return;
    case 'memory':
      await call(
        args.length
          ? `/api/memory/search?q=${encodeURIComponent(args.join(' '))}&agentId=${encodeURIComponent(options.agent ?? 'main')}`
          : '/api/memory/knowledge',
      );
      return;
    case 'permissions':
      if (args[0]) {
        if (!['ask', 'auto', 'yolo'].includes(args[0]))
          throw new Error('权限模式：ask | auto | yolo（与桌面端共用设置）');
        await call('/api/permissions/mode', { method: 'PUT', body: { mode: args[0] } });
      } else await call('/api/permissions');
      return;
    case 'approvals':
      if (!args[0]) await call('/api/approvals');
      else {
        if (!['allow-once', 'allow-always', 'denied', 'deny-always'].includes(args[1] ?? ''))
          throw new Error('请指定审批 ID 和决策 allow-once | allow-always | denied | deny-always');
        await call(`/api/approvals/${encoded(args[0])}`, {
          method: 'POST',
          body: { decision: args[1] },
        });
      }
      return;
    case 'compact':
      await call('/api/compact', {
        method: 'POST',
        body: { sessionId: decodeURIComponent(session()), model: options.model },
      });
      return;
    case 'stop':
      await call('/api/chat/stop', {
        method: 'POST',
        body: { sessionId: decodeURIComponent(session()) },
      });
      return;
    case 'steer':
      if (!args.length) throw new Error('请提供补充指令');
      await call('/api/steer', {
        method: 'POST',
        body: { session: decodeURIComponent(session()), message: args.join(' ') },
      });
      return;
    case 'changes':
      await call(`/api/files/changes?dir=${encodeURIComponent(options.cwd ?? process.cwd())}`);
      return;
    case 'diff':
      await call(`/api/files/changes/${encoded(args[0])}`);
      return;
    case 'undo':
    case 'redo': {
      const path = `/api/files/changes/${encoded(args[0])}`;
      const detail = (await apiFetch<Record<string, unknown>>(base, path)).data;
      const state = detail?.['state'];
      if (typeof state !== 'string') throw new Error('变更记录没有可恢复状态');
      if ((command === 'undo' && state === 'undone') || (command === 'redo' && state !== 'undone'))
        throw new Error('变更状态不适用于此操作');
      await call(`${path}/restore`, { method: 'POST', body: { state } });
      return;
    }
    case 'api': {
      const method = args[0]?.toUpperCase(),
        path = args[1];
      if (
        !method ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
        !path?.startsWith('/api/') ||
        path.includes('..') ||
        path.includes('#') ||
        path.includes('\\')
      )
        throw new Error('用法：api GET|POST|PUT|PATCH|DELETE /api/... [--data-file 文件]');
      await call(path, {
        method: method as NonNullable<ApiFetchInit['method']>,
        ...(options.dataFile ? { body: await payload() } : {}),
      });
      return;
    }
  }
  throw new Error(`不支持的命令：${command} ${args.join(' ')}`);
}
