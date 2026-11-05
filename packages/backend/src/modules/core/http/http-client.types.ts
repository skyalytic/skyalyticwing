/**
 * HttpClient 相关类型定义
 *
 * 从 http-client.service.ts 提取，供 service 及其调用方共享。
 */

/** HTTP 方法类型 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

/** HTTP 请求选项 */
export interface RequestOptions {
  headers?: Record<string, string>;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 最大重定向次数，默认 5 */
  maxRedirects?: number;
  /** 响应类型：json 自动 JSON.parse，text 返回字符串，buffer 返回 Buffer */
  responseType?: "json" | "text" | "buffer";
}

/** HTTP 响应 */
export interface HttpResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}
