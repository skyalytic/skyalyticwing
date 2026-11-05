import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from '../packages/cli/src/args.js';
import { normalizeBaseUrl } from '../packages/cli/src/http.js';
import { readEvents } from '../packages/cli/src/commands/run.js';

let server: Server, base: string;
const requests: Array<{ path: string; body: any; authorization?: string }> = [];
const cli = resolve('packages/cli/dist/cli.js');
function run(
  args: string[],
  input = '',
  onStderr?: (chunk: string) => void,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--base-url', base], {
      windowsHide: true,
      env: {
        ...process.env,
        SKYALYTICWING_AUTH_TOKEN: 'test-token',
        SKYALYTICWING_CLI_NO_AUTOSTART: '1',
      },
    });
    let out = '',
      err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
      onStderr?.(String(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    const json = (data: unknown) => res.end(JSON.stringify({ success: true, data }));
    if (req.url === '/api/health') return json({ status: 'ok' });
    if (req.headers.authorization !== 'Bearer test-token') {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url === '/api/sessions' && req.method === 'POST') return json({ id: 'cli-test' });
    if (req.url === '/api/sessions/existing')
      return json({ id: 'existing', model: 'saved-model', agent: 'saved-agent' });
    if (req.url === '/api/files/project') return json({ path: body.path });
    if (req.url === '/api/cli/turn') {
      res.setHeader('content-type', 'application/x-ndjson');
      if (body.message === 'delayed') await new Promise((resolve) => setTimeout(resolve, 500));
      if (body.message === 'approval') {
        res.write(
          JSON.stringify({
            type: 'approval_request',
            request: { id: 'approval-1', toolName: 'write_file' },
          }) + '\n',
        );
        return;
      }
      res.write(
        JSON.stringify({ type: 'tool_call', toolName: 'browser', args: {}, callId: 't1' }) + '\n',
      );
      res.write(
        JSON.stringify({
          type: 'tool_result',
          toolName: 'browser',
          result: { success: true },
          callId: 't1',
        }) + '\n',
      );
      res.write(JSON.stringify({ type: 'assistant_message', content: '中文任务完成' }) + '\n');
      if (body.message !== 'truncate')
        res.write(JSON.stringify({ type: 'done', usage: { totalTokens: 42 } }) + '\n');
      return res.end();
    }
    if (req.url?.startsWith('/api/approvals/'))
      return json({ id: 'approval-1', decision: body.decision });
    if (req.url === '/api/mcp/servers') return json([{ id: 'local-fixture' }]);
    return json({});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Wing CLI executable integration', () => {
  it('shows waiting feedback before the first model response, then tool activity', async () => {
    let waitingShown = false;
    const result = await run(['exec', 'delayed'], '', (chunk) => {
      if (chunk.includes('正在等待 AI 回复')) waitingShown = true;
      if (chunk.includes('正在执行工具')) expect(waitingShown).toBe(true);
    });
    expect(result.code, result.err).toBe(0);
    expect(waitingShown).toBe(true);
    expect(result.err).toContain('正在提交任务');
    expect(result.err).toContain('正在执行工具：browser');
    expect(result.out.trim()).toBe('中文任务完成');
    expect(result.out).not.toContain('正在');
  });
  it('parses repeated attachments, separator, and rejects invalid flags', () => {
    expect(parseArgs(['exec', '--file', 'a', '--image=b', '--', '--literal']).positional).toEqual([
      '--literal',
    ]);
    expect(parseArgs(['exec', '--file', 'a', '--image=b']).options.files).toEqual(['a', 'b']);
    expect(parseArgs(['exec', '--json=true']).error).toBeTruthy();
  });
  it('rejects credential-bearing and insecure remote origins', () => {
    for (const value of [
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com/path',
    ])
      expect(() => normalizeBaseUrl(value)).toThrow();
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
  });
  it('runs full event stream, binds fresh workspace, and uses auth', async () => {
    const result = await run(['exec', '测试', '--json', '--cwd', process.cwd()]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      sessionId: 'cli-test',
      content: '中文任务完成',
      usage: { totalTokens: 42 },
    });
    expect(requests.find((r) => r.path === '/api/files/project')?.body.sessionId).toBe('cli-test');
    expect(requests.find((r) => r.path === '/api/cli/turn')?.authorization).toBe(
      'Bearer test-token',
    );
  });
  it('resumes exact session and saved model without rebinding workspace', async () => {
    const start = requests.length;
    const result = await run(['exec', '继续', '--session', 'existing', '--jsonl']);
    expect(result.code, result.err).toBe(0);
    const events = result.out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'assistant_message',
      'done',
      'result',
    ]);
    expect(requests.slice(start).some((r) => r.path === '/api/files/project')).toBe(false);
    expect(requests.slice(start).find((r) => r.path === '/api/cli/turn')?.body).toMatchObject({
      session: 'existing',
      model: 'saved-model',
      agent: 'saved-agent',
    });
  });
  it('reads task from stdin and lists backend MCP servers', async () => {
    expect((await run(['exec', '-', '--json'], '管道任务')).code).toBe(0);
    const result = await run(['mcp', 'list', '--json']);
    expect(JSON.parse(result.out)).toEqual([{ id: 'local-fixture' }]);
  });
  it('never retries an interrupted stream or reports partial output as success', async () => {
    const start = requests.length;
    const result = await run(['exec', 'truncate', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).ok).toBe(false);
    expect(requests.slice(start).filter((r) => r.path === '/api/cli/turn')).toHaveLength(1);
  });
  it('denies rather than silently approving in unattended execution', async () => {
    const result = await run(['exec', 'approval', '--json']);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.out).error).toContain('需要审批');
    expect(requests.find((r) => r.path === '/api/approvals/approval-1')?.body.decision).toBe(
      'denied',
    );
  });
  it('decodes UTF8 split over packets and rejects truncated event JSON', async () => {
    const bytes = new TextEncoder().encode('{"type":"assistant_message","content":"中"}\n');
    const stream = new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    });
    const events = [];
    for await (const e of readEvents(
      new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
    ))
      events.push(e);
    expect(events[0]?.content).toBe('中');
    await expect(async () => {
      for await (const _e of readEvents(
        new Response('{"type":', { headers: { 'content-type': 'application/x-ndjson' } }),
      )) {
        /* exhaust */
      }
    }).rejects.toThrow('截断');
  });
});
