import { Injectable } from '@nestjs/common';
import { request as httpRequest, RequestOptions as NodeHttpRequestOptions, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { HTTP_MAX_RESPONSE_SIZE, HTTP_TIMEOUT_MS } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../security/security-manager.service.js';
import type { HttpMethod, HttpResponse, RequestOptions } from './http-client.types.js';

// 类型已提取至 http-client.types.ts，此处重新导出以保持原有公开 API 向后兼容
export type { HttpMethod, HttpResponse, RequestOptions };

const DEFAULT_TIMEOUT = HTTP_TIMEOUT_MS;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_RESPONSE_SIZE = HTTP_MAX_RESPONSE_SIZE;

/**
 * HttpClientService - 统一 HTTP 客户端
 *
 * 合并了原 web/server 中的 _httpAjax / _httpFetch / httpGet 三个调用入口，
 * 内置安全约束：
 *   - 30s 默认超时
 *   - 50MB 响应大小限制
 *   - SSRF fail-close（通过 SecurityManagerService.checkUrl）
 *   - 最多 5 次重定向
 */
@Injectable()
export class HttpClientService {
  constructor(private readonly security: SecurityManagerService) {}

  async get<T>(url: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, options);
  }

  async post<T>(url: string, body: unknown, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, options, body);
  }

  async request<T>(
    method: HttpMethod,
    url: string,
    options?: RequestOptions,
    body?: unknown,
  ): Promise<HttpResponse<T>> {
    const opts = this.normalizeOptions(options);
    return this.dispatch<T>(method, url, opts, body, opts.maxRedirects);
  }

  private normalizeOptions(options?: RequestOptions): Required<RequestOptions> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const responseType = options?.responseType ?? 'json';
    const headers = options?.headers ?? {};
    return { timeout, maxRedirects, responseType, headers };
  }

  private async dispatch<T>(
    method: HttpMethod,
    url: string,
    opts: Required<RequestOptions>,
    body: unknown,
    remainingRedirects: number,
  ): Promise<HttpResponse<T>> {
    // SSRF fail-close：URL 校验失败立即拒绝（含 DNS 解析，必须 await 取回结果）
    const ssrfCheck = await this.security.checkUrl(url);
    if (!ssrfCheck.safe) {
      // 错误消息只保留 origin+pathname，剥离 query/path 中的凭证（如 telegram token）
      let safeUrl = url;
      try {
        const u = new URL(url);
        safeUrl = `${u.origin}${u.pathname}`;
      } catch { /* 保底：截断至首行 */ }
      throw new Error(`URL blocked by SSRF guard (${ssrfCheck.reason}): ${safeUrl}`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const nodeOptions: NodeHttpRequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { ...opts.headers },
    };

    // 准备请求体
    let bodyBuffer: Buffer | undefined;
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (Buffer.isBuffer(body)) {
        bodyBuffer = body;
      } else if (typeof body === 'string') {
        bodyBuffer = Buffer.from(body, 'utf-8');
      } else {
        bodyBuffer = Buffer.from(JSON.stringify(body), 'utf-8');
        if (!nodeOptions.headers) nodeOptions.headers = {};
        (nodeOptions.headers as Record<string, string>)['Content-Type'] =
          (nodeOptions.headers as Record<string, string>)['Content-Type'] || 'application/json';
      }
      if (bodyBuffer) {
        (nodeOptions.headers as Record<string, string>)['Content-Length'] =
          String(bodyBuffer.length);
      }
    }

    return new Promise<HttpResponse<T>>((resolve, reject) => {
      const req = reqFn(nodeOptions, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;

        // 处理重定向
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location !== undefined &&
          remainingRedirects > 0
        ) {
          // 取消当前响应读取
          res.resume();
          const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
          const redirectHeaders = { ...opts.headers };
          if (new URL(redirectUrl).origin !== parsedUrl.origin) {
            for (const key of Object.keys(redirectHeaders)) {
              if (/^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(key)) {
                delete redirectHeaders[key];
              }
            }
          }
          resolve(this.dispatch<T>(method, redirectUrl, { ...opts, headers: redirectHeaders }, body, remainingRedirects - 1));
          return;
        }

        if (
          status >= 300 &&
          status < 400 &&
          (res.headers.location === undefined || remainingRedirects <= 0)
        ) {
          res.resume();
          if (res.headers.location === undefined) {
            reject(new Error(`Redirect status ${status} without Location header`));
          } else {
            reject(new Error('Too many redirects'));
          }
          return;
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        let exceeded = false;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_RESPONSE_SIZE) {
            exceeded = true;
            try { req.destroy(); } catch {}
            reject(new Error('Response size exceeds 50MB limit'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (exceeded) return;
          const buffer = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          const data = this.parseResponse<T>(buffer, opts.responseType);
          resolve({ status, headers, data });
        });

        res.on('error', (err: Error) => {
          reject(err);
        });
      });

      req.setTimeout(opts.timeout, () => {
        try { req.destroy(); } catch {}
        reject(new Error(`Request timeout (${opts.timeout}ms)`));
      });

      req.on('error', (err: Error) => {
        reject(err);
      });

      if (bodyBuffer) {
        req.write(bodyBuffer);
      }
      req.end();
    });
  }

  private parseResponse<T>(buffer: Buffer, responseType: 'json' | 'text' | 'buffer'): T {
    if (responseType === 'buffer') {
      return buffer as unknown as T;
    }
    const text = buffer.toString('utf-8');
    if (responseType === 'text') {
      return text as unknown as T;
    }
    // json
    if (text.length === 0) return null as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // JSON 解析失败时退化为字符串
      return text as unknown as T;
    }
  }
}
