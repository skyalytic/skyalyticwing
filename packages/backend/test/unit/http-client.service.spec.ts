import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import { HttpClientService } from '../../src/modules/core/http/http-client.service.js';
import type { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';

/**
 * HttpClientService 单元测试（设计点名 P0）：
 *   - mock SecurityManager.checkUrl 返回 {safe, reason}
 *   - mock node:http / node:https 的 request，验证：
 *     SSRF 拒绝 / GET-POST 请求构造 / json-text-buffer 响应解析 /
 *     超时 / 重定向跟随（每跳 SSRF 复检）/ 50MB 响应上限
 *
 * 内建模块导出不可 spyOn（Cannot redefine property），经 jest.mock 工厂替换 request。
 */
jest.mock('node:http', () => ({
  ...jest.requireActual('node:http'),
  request: jest.fn(),
}));
jest.mock('node:https', () => ({
  ...jest.requireActual('node:https'),
  request: jest.fn(),
}));

const httpRequestMock = http.request as unknown as jest.Mock;
const httpsRequestMock = https.request as unknown as jest.Mock;

/** 捕获到的一次底层请求 */
interface CapturedRequest {
  options: Record<string, unknown>;
  callback: (res: EventEmitter & { statusCode?: number; headers?: Record<string, unknown> }) => void;
  req: {
    setTimeout: jest.Mock;
    on: jest.Mock;
    write: jest.Mock;
    end: jest.Mock;
    destroy: jest.Mock;
    __timeoutCb?: () => void;
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('HttpClientService 单元测试', () => {
  let capturedHttp: CapturedRequest[];
  let capturedHttps: CapturedRequest[];
  let checkUrl: jest.Mock;
  let service: HttpClientService;

  beforeEach(() => {
    capturedHttp = [];
    capturedHttps = [];
    checkUrl = jest.fn().mockResolvedValue({ safe: true, reason: '' });

    const makeReq = (): CapturedRequest['req'] => {
      const req = {
        setTimeout: jest.fn().mockImplementation((_ms: number, cb: () => void) => {
          (req as CapturedRequest['req']).__timeoutCb = cb;
        }),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
      };
      return req as CapturedRequest['req'];
    };

    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation((options: Record<string, unknown>, cb: never) => {
      const entry: CapturedRequest = { options, callback: cb as never, req: makeReq() };
      capturedHttp.push(entry);
      return entry.req as never;
    });

    httpsRequestMock.mockReset();
    httpsRequestMock.mockImplementation((options: Record<string, unknown>, cb: never) => {
      const entry: CapturedRequest = { options, callback: cb as never, req: makeReq() };
      capturedHttps.push(entry);
      return entry.req as never;
    });

    service = new HttpClientService({ checkUrl } as unknown as SecurityManagerService);
  });

  /** 驱动一次模拟响应 */
  const respond = (
    entry: CapturedRequest,
    spec: { status?: number; headers?: Record<string, unknown>; chunks?: Buffer[]; location?: string },
  ): void => {
    const res = new EventEmitter() as EventEmitter & {
      statusCode?: number;
      headers?: Record<string, unknown>;
      resume: jest.Mock;
    };
    res.statusCode = spec.status ?? 200;
    res.headers =
      spec.location !== undefined
        ? { ...(spec.headers ?? {}), location: spec.location }
        : { ...(spec.headers ?? {}) };
    res.resume = jest.fn();
    entry.callback(res);
    process.nextTick(() => {
      for (const chunk of spec.chunks ?? []) {
        res.emit('data', chunk);
      }
      res.emit('end');
    });
  };

  it('SSRF 校验失败时立即拒绝，不发起底层请求', async () => {
    checkUrl.mockResolvedValue({ safe: false, reason: 'private IP 127.0.0.1' });

    await expect(service.get('http://127.0.0.1:8080/secret')).rejects.toThrow(
      'URL blocked by SSRF guard (private IP 127.0.0.1): http://127.0.0.1:8080/secret',
    );
    expect(checkUrl).toHaveBeenCalledTimes(1);
    expect(capturedHttp).toHaveLength(0);
  });

  it('GET 经 node:http 发起：hostname/path/method 透传，json 响应自动解析', async () => {
    const promise = service.get<{ ok: boolean }>('http://example.com/path?q=1');
    await flush();
    expect(capturedHttp).toHaveLength(1);
    expect(capturedHttp[0].options).toMatchObject({
      hostname: 'example.com',
      port: 80,
      path: '/path?q=1',
      method: 'GET',
    });
    expect(capturedHttp[0].req.end).toHaveBeenCalledTimes(1);
    expect(capturedHttp[0].req.write).not.toHaveBeenCalled();

    respond(capturedHttp[0], { chunks: [Buffer.from('{"ok":true}')] });
    const res = await promise;
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });

  it('https URL 经 node:https 发起（默认端口 443）', async () => {
    const promise = service.get('https://secure.example.com/x');
    await flush();
    expect(capturedHttp).toHaveLength(0);
    expect(capturedHttps).toHaveLength(1);
    expect(capturedHttps[0].options).toMatchObject({
      hostname: 'secure.example.com',
      port: 443,
      method: 'GET',
    });
    respond(capturedHttps[0], { chunks: [Buffer.from('{}')] });
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it('POST JSON body：自动设置 Content-Type/Content-Length 并写入 Buffer', async () => {
    const promise = service.post('http://example.com/api', { a: 1, b: 'x' });
    await flush();
    expect(capturedHttp).toHaveLength(1);
    const entry = capturedHttp[0];
    expect(entry.options['method']).toBe('POST');
    expect(entry.options['headers']).toMatchObject({
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(JSON.stringify({ a: 1, b: 'x' }))),
    });
    expect(entry.req.write).toHaveBeenCalledTimes(1);
    expect(entry.req.write.mock.calls[0][0]).toBeInstanceOf(Buffer);

    respond(entry, { status: 201, chunks: [Buffer.from('{"id":9}')] });
    const res = await promise;
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ id: 9 });
  });

  it('responseType：text 返回字符串、buffer 返回 Buffer、非法 JSON 退化为字符串', async () => {
    const p1 = service.get('http://example.com/t1', { responseType: 'text' });
    await flush();
    respond(capturedHttp[0], { chunks: [Buffer.from('plain text')] });
    await expect(p1).resolves.toMatchObject({ data: 'plain text' });

    const p2 = service.get('http://example.com/t2', { responseType: 'buffer' });
    await flush();
    respond(capturedHttp[1], { chunks: [Buffer.from([1, 2, 3])] });
    const res2 = await p2;
    expect(Buffer.isBuffer(res2.data)).toBe(true);
    expect((res2.data as Buffer).length).toBe(3);

    const p3 = service.get<{ weird: string }>('http://example.com/t3');
    await flush();
    respond(capturedHttp[2], { chunks: [Buffer.from('not-json{')] });
    const res3 = await p3;
    expect(res3.data).toBe('not-json{');
  });

  it('超时：触发 setTimeout 回调后销毁请求并拒绝', async () => {
    const promise = service.get('http://example.com/slow', { timeout: 1500 });
    await flush();
    const entry = capturedHttp[0];
    expect(entry.req.setTimeout).toHaveBeenCalledWith(1500, expect.any(Function));

    entry.req.__timeoutCb!();
    await expect(promise).rejects.toThrow('Request timeout (1500ms)');
    expect(entry.req.destroy).toHaveBeenCalledTimes(1);
  });

  it('重定向跟随：302 → 新 URL 重新请求，每一跳均做 SSRF 复检', async () => {
    const promise = service.get<{ final: boolean }>('http://example.com/a');
    await flush();
    expect(checkUrl).toHaveBeenCalledTimes(1);
    expect(capturedHttp).toHaveLength(1);

    respond(capturedHttp[0], { status: 302, location: 'http://cdn.example.com/b' });
    await flush();
    // 第二跳：URL 变化后再次 SSRF 校验并重新发起请求
    expect(checkUrl).toHaveBeenCalledTimes(2);
    expect(checkUrl).toHaveBeenNthCalledWith(2, 'http://cdn.example.com/b');
    expect(capturedHttp).toHaveLength(2);
    expect(capturedHttp[0].options['path']).toBe('/a');
    expect(capturedHttp[1].options['hostname']).toBe('cdn.example.com');

    respond(capturedHttp[1], { chunks: [Buffer.from('{"final":true}')] });
    const res = await promise;
    expect(res.data).toEqual({ final: true });
  });

  it('重定向跳数耗尽时拒绝（Too many redirects）', async () => {
    const promise = service.get('http://example.com/loop', { maxRedirects: 0 });
    await flush();
    respond(capturedHttp[0], { status: 302, location: 'http://example.com/next' });
    await expect(promise).rejects.toThrow('Too many redirects');
  });

  it.each([
    ['https://example.com/next', true],
    ['https://other.example.com/next', false],
    ['http://example.com/next', false],
  ])('redirect credentials: %s preserves=%s', async (destination, preserves) => {
    const headers = { aUtHoRiZaTiOn: 'Bearer private', Cookie: 'session=private', 'X-API-Key': 'private', Accept: 'application/json' };
    const promise = service.get('https://example.com/start', { headers });
    await flush();
    respond(capturedHttps[0], { status: 302, location: destination });
    await flush();
    const next = destination.startsWith('https:') ? capturedHttps[1] : capturedHttp[0];
    expect(next.options['headers']).toEqual(preserves ? headers : { Accept: 'application/json' });
    expect(headers.aUtHoRiZaTiOn).toBe('Bearer private');
    respond(next, { chunks: [Buffer.from('{}')] });
    await promise;
  });

  it('响应超过 50MB 上限时销毁请求并拒绝', async () => {
    const promise = service.get('http://example.com/big', { responseType: 'buffer' });
    await flush();
    const entry = capturedHttp[0];

    // 两个 26MB chunk 共 52MB > 50MB
    respond(entry, { chunks: [Buffer.alloc(26 * 1024 * 1024), Buffer.alloc(26 * 1024 * 1024)] });
    await expect(promise).rejects.toThrow('Response size exceeds 50MB limit');
    expect(entry.req.destroy).toHaveBeenCalledTimes(1);
  });
});
