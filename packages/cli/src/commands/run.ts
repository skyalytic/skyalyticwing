import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { CliOptions } from '../args.js';
import { apiFetch, authHeaders, DEFAULT_BASE_URL, normalizeBaseUrl } from '../http.js';
import { TurnProgress } from '../progress.js';

export interface TurnEvent {
  type: string;
  sessionId?: string;
  content?: string;
  error?: string;
  toolName?: string;
  args?: unknown;
  result?: { success?: boolean; error?: string };
  usage?: unknown;
  attachments?: unknown[];
  request?: { id: string; toolName?: string; args?: unknown; reason?: string };
}
export interface TurnHooks {
  signal?: AbortSignal;
  approval?: (event: TurnEvent) => Promise<string>;
  progress?: (message: string) => void;
}
export async function prepareSession(options: CliOptions): Promise<string> {
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  if (options.session) {
    const existing = await apiFetch<{ id: string; model?: string; agent?: string }>(
      base,
      `/api/sessions/${encodeURIComponent(options.session)}`,
    );
    if (!existing.data) throw new Error('会话不存在');
    if (!options.model && existing.data.model) options.model = existing.data.model;
    if (!options.agent && existing.data.agent) options.agent = existing.data.agent;
  } else {
    const created = await apiFetch<{ id: string }>(base, '/api/sessions', {
      method: 'POST',
      body: { title: 'CLI 会话' },
    });
    if (!created.data?.id) throw new Error('后端未返回会话 ID');
    options.session = created.data.id;
  }
  return options.session;
}

export async function bindProject(options: CliOptions, fresh: boolean): Promise<void> {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(options.baseUrl ?? DEFAULT_BASE_URL).hostname,
  );
  if (!local && !options.cwd) return;
  if (options.cwd || fresh)
    await apiFetch(options.baseUrl ?? DEFAULT_BASE_URL, '/api/files/project', {
      method: 'POST',
      body: {
        path: local ? resolve(options.cwd ?? process.cwd()) : options.cwd,
        sessionId: options.session,
      },
    });
}

export async function attachments(files: string[] = []): Promise<unknown[]> {
  const results: unknown[] = [];
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  let total = 0;
  for (const file of files) {
    const path = resolve(file),
      info = await stat(path);
    if (!info.isFile() || (total += info.size) > 16 * 1024 * 1024)
      throw new Error('附件必须是文件，合计不超过 16 MiB');
    const mimeType = types[extname(path).toLowerCase()];
    if (mimeType)
      results.push({
        type: 'image',
        name: basename(path),
        mimeType,
        size: info.size,
        url: `data:${mimeType};base64,${(await readFile(path)).toString('base64')}`,
      });
    else results.push({ type: 'file', name: basename(path), path, size: info.size });
  }
  return results;
}

export async function* readEvents(response: Response): AsyncGenerator<TurnEvent> {
  if (!response.ok)
    throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 400)}`);
  if (!response.headers.get('content-type')?.includes('application/x-ndjson'))
    throw new Error('后端不支持 CLI 事件流，请更新本机后端');
  if (!response.body) throw new Error('后端没有返回事件流');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 32 * 1024 * 1024) throw new Error('后端单条事件过大');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) yield JSON.parse(line) as TurnEvent;
      }
      if (done) {
        if (pending.trim()) throw new Error('事件流被截断');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function cmdRun(
  prompt: string,
  options: CliOptions,
  hooks: TurnHooks = {},
): Promise<number> {
  const progress = new TurnProgress(!options.json && !options.jsonl, hooks.progress);
  progress.set('正在提交任务…');
  try {
    return await runTurn(prompt, options, hooks, progress);
  } finally {
    progress.stop();
  }
}

async function runTurn(
  prompt: string,
  options: CliOptions,
  hooks: TurnHooks,
  progress: TurnProgress,
): Promise<number> {
  const base = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (
    options.files?.length &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)
  ) {
    for (const file of options.files) {
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(file).toLowerCase()))
        throw new Error(
          '远程后端无法读取本机文件路径；请先将文件上传到远程工作区。图片可直接附加。',
        );
    }
  }
  const fresh = !options.session;
  if (!options.session) await prepareSession(options);
  await bindProject(options, fresh);
  const session = options.session!;
  if (options.model || options.agent)
    await apiFetch(base, `/api/sessions/${encodeURIComponent(session)}/meta`, {
      method: 'PUT',
      body: { model: options.model, agent: options.agent },
    });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const sigint = () => {
    console.error('\n已请求停止当前任务');
    cancel();
  };
  hooks.signal?.addEventListener('abort', cancel, { once: true });
  if (hooks.signal?.aborted) cancel();
  if (!hooks.signal) process.once('SIGINT', sigint);
  let content = '',
    done = false,
    failure = '',
    usage: unknown,
    media: unknown[] | undefined;
  if (!options.json && !options.jsonl) console.error(`Wing · 会话 ${session}`);
  try {
    const files = await attachments(options.files);
    progress.set('正在等待 AI 回复…（Ctrl+C 停止）');
    const response = await fetch(`${base}/api/cli/turn`, {
      method: 'POST',
      headers: authHeaders(),
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({
        session,
        message: prompt,
        model: options.model,
        agent: options.agent,
        attachments: files,
      }),
    });
    for await (const event of readEvents(response)) {
      if (options.jsonl) console.log(JSON.stringify(event));
      if (event.type === 'assistant_message') {
        progress.stop();
        content = event.content ?? '';
        media = event.attachments;
        if (!options.json && !options.jsonl) console.log(content);
      } else if (event.type === 'tool_call' && !options.json && !options.jsonl) {
        progress.set(`正在执行工具：${event.toolName}`);
      } else if (event.type === 'tool_result' && !options.json && !options.jsonl) {
        console.error(
          `  ${event.result?.success ? '✓' : '✗'} ${event.toolName}${event.result?.error ? ': ' + event.result.error : ''}`,
        );
        progress.set('正在处理工具结果，等待 AI 回复…');
      } else if (event.type === 'approval_request' && event.request) {
        progress.stop();
        if (!hooks.approval) {
          failure = '需要审批；请使用交互模式，或通过 approvals 命令处理。未自动批准。';
          await apiFetch(base, `/api/approvals/${encodeURIComponent(event.request.id)}`, {
            method: 'POST',
            body: { decision: 'denied' },
          });
          cancel();
          break;
        }
        const decision = await hooks.approval(event);
        await apiFetch(base, `/api/approvals/${encodeURIComponent(event.request.id)}`, {
          method: 'POST',
          body: { decision },
        });
        progress.set('审批已提交，等待任务继续…');
      } else if (event.type === 'done') {
        progress.stop();
        done = true;
        usage = event.usage;
      } else if (event.type === 'error') {
        progress.stop();
        failure = event.error ?? '执行失败';
      }
    }
    if (!done && !failure) failure = '连接已结束，但任务未完成；可 resume 查看历史，未自动重试任务';
  } catch (error) {
    failure ||= controller.signal.aborted
      ? '任务已中断'
      : error instanceof Error
        ? error.message
        : String(error);
  } finally {
    hooks.signal?.removeEventListener('abort', cancel);
    if (!hooks.signal) process.off('SIGINT', sigint);
  }
  const result = {
    ok: done && !failure,
    sessionId: session,
    content,
    usage,
    attachments: media,
    ...(failure ? { error: failure } : {}),
  };
  if (options.json || options.jsonl)
    console.log(JSON.stringify(options.jsonl ? { type: 'result', ...result } : result));
  else if (failure) console.error(failure);
  return result.ok ? 0 : controller.signal.aborted ? 130 : 1;
}
