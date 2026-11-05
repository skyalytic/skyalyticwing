/**
 * 后端 HTTP API 访问封装（基于 Node 22 内置 fetch，零依赖）
 *
 * 所有后端响应均为 ApiResponse 包装：{ success, data?, error?, code? }。
 * 本模块负责：超时控制、非 2xx 与 success=false 的统一抛错（ApiError）。
 */

/** 与 @skyalyticwing/shared 的 ApiResponse 对齐的响应包装 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/** 后端默认地址（Gateway 计划任务常驻运行的 sidecar 端口） */
export const DEFAULT_BASE_URL =
  process.env['SKYALYTICWING_URL'] ||
  'http://127.0.0.1:19111';

export function authHeaders(): Record<string, string> {
  const token = process.env['SKYALYTICWING_AUTH_TOKEN'] || process.env['WING_TUI_TOKEN'];
  const cookie = process.env['SKYALYTICWING_COOKIE'] || process.env['WING_TUI_COOKIE'];
  return {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/** API 调用失败（网络错误 / 非 2xx / success=false） */
export class ApiError extends Error {
  /** HTTP 状态码（网络层失败时为 undefined） */
  readonly status?: number;
  readonly data?: unknown;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    if (status !== undefined) this.status = status;
    this.data = data;
  }
}

/** 去除末尾斜杠，得到规范的 base URL */
export function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')
    throw new Error('后端地址必须是无凭据的 origin');
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  )
    throw new Error('远程后端必须使用 HTTPS');
  return parsed.origin;
}

/** apiFetch 的可选参数 */
export interface ApiFetchInit {
  /** 请求方法，默认 GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 请求体（POST 时自动 JSON 序列化） */
  body?: unknown;
  /** 超时毫秒数，默认 10s；对话类长请求请显式调大 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 请求后端 API 并解包 ApiResponse。
 * 网络失败 / 非 2xx / success=false 时抛出 ApiError。
 */
export async function apiFetch<T>(
  baseUrl: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<ApiResponse<T>> {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  const { method = 'GET', body, timeoutMs = 10_000 } = init;

  let res: Response;
  // 按 exactOptionalPropertyTypes 要求条件展开可选字段（headers/body 仅 POST 场景携带）
  const reqInit: RequestInit = {
    method,
    headers: authHeaders(),
    redirect: 'error',
    ...(timeoutMs > 0
      ? {
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        }
      : init.signal
        ? { signal: init.signal }
        : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  try {
    res = await fetch(url, reqInit);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(`无法连接后端 ${url}：${reason}`);
  }

  if (!res.ok) {
    // 尽力从响应体提取 error 字段，便于定位后端返回的业务错误
    let detail = '';
    try {
      const payload = (await res.json()) as ApiResponse<unknown>;
      if (payload && typeof payload.error === 'string') detail = payload.error;
    } catch {
      // 响应体非 JSON 时忽略
    }
    throw new ApiError(
      `HTTP ${res.status} ${res.statusText}${detail ? `：${detail}` : ''}`,
      res.status,
    );
  }

  const payload = (await res.json()) as ApiResponse<T>;
  if (payload.success === false) {
    throw new ApiError(payload.error ?? '后端返回 success=false', res.status, payload.data);
  }
  return payload.success === true ? payload : { success: true, data: payload as T };
}
