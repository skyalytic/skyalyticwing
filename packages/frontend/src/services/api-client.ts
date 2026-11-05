import { wt } from '@/i18n/workbench-text';
// HTTP API 客户端：fetch 封装，统一错误处理，30s 超时
import { API_PREFIX, HTTP_TIMEOUT_MS } from '@/utils/constants';
import type { ApiResponse } from '@/types';
import { authHeaders } from './auth-token';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 当为 true 时，直接返回原始 JSON（不做 ApiResponse 解包） */
  raw?: boolean;
}

function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = import.meta.env.VITE_API_BASE ?? API_PREFIX;
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${prefix}${tail}`;
}

function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abort = () => controller.abort();
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, cancel: () => { if (timer) clearTimeout(timer); external?.removeEventListener('abort', abort); } };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(path);
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const { signal, cancel } = withTimeout(timeoutMs, options.signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    cancel();
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(wt('请求超时 ({{v0}}ms)', { v0: timeoutMs }), 408, 'TIMEOUT');
    }
    throw new ApiError(
      e instanceof Error ? wt('网络错误: {{v0}}', { v0: e.message }) : wt('网络错误'),
      0,
      'NETWORK',
    );
  }
  cancel();

  if (response.status === 401) window.dispatchEvent(new Event('sky-auth-expired'));

  const contentType = response.headers.get('content-type') ?? '';

  // 非 JSON 响应（如文本/空）
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(`HTTP ${response.status}`, response.status);
    }
    const text = await response.text();
    return (text || undefined) as unknown as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
    return undefined as unknown as T;
  }

  if (options.raw) {
    if (!response.ok) {
      throw new ApiError(`HTTP ${response.status}`, response.status);
    }
    return payload as T;
  }

  // ApiResponse 解包
  const apiResp = payload as ApiResponse<T>;
  if (apiResp && typeof apiResp === 'object' && 'success' in apiResp) {
    if (!apiResp.success || !response.ok) {
      const msg = apiResp.error ?? `HTTP ${response.status}`;
      throw new ApiError(msg, response.status, apiResp.code);
    }
    return apiResp.data as T;
  }

  if (!response.ok) {
    const details = payload as { message?: unknown };
    throw new ApiError(
      typeof details?.message === 'string' ? details.message : `HTTP ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

/** HTTP API 客户端 */
export const apiClient = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('GET', path, undefined, options);
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('POST', path, body, options);
  },
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, body, options);
  },
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, undefined, options);
  },
  /** 流式请求：返回可读流，逐块产出文本 */
  async *stream(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): AsyncGenerator<string, void, unknown> {
    const url = buildUrl(path);
    const timeoutMs = options?.timeoutMs ?? 0; // 流式默认不超时
    const ctrl = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) ctrl.abort();
      else options.signal.addEventListener('abort', () => ctrl.abort());
    }
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        throw new ApiError(`HTTP ${res.status}`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

export type ApiClient = typeof apiClient;
