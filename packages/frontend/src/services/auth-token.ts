// 鉴权 token 读取：localStorage（用户在设置页保存）优先，回退 VITE_AUTH_TOKEN 构建期注入
// 后端未开启 token 鉴权（security.auth.mode !== 'token'）时不校验，携带此值无副作用。

/** localStorage 中保存服务端鉴权 token 的键（SettingsPage 安全设置写入） */
export const AUTH_TOKEN_STORAGE_KEY = 'skyalyticwing.auth.token';

/** 读取鉴权 token：localStorage → VITE_AUTH_TOKEN，均无则返回空字符串 */
export function getAuthToken(): string {
  try {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : null;
    if (stored) return stored;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  // Vite 的 import.meta.env 为索引签名类型，须用方括号访问（TS4111）
  const envToken = import.meta.env['VITE_AUTH_TOKEN'];
  return typeof envToken === 'string' ? envToken : '';
}

/** 保存/清除鉴权 token（null 或空字符串时移除） */
export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 构造鉴权请求头：存在 token 时附加 Authorization: Bearer */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 为 WS 连接 URL 附加 token 查询参数（与后端 WS 网关 ?token= 传参方式对齐） */
export function withWsTokenParam(url: string): string {
  const token = getAuthToken();
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}
