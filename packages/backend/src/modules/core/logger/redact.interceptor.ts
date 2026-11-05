import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { isTokenMetric } from './token-metric.util.js';

/**
 * 需要从响应中脱敏（替换为 ***）的字段名，小写匹配。
 *
 * 覆盖清单（设计文档 4.4 安全脱敏要求）：
 *   - authToken / apiKey / token / secret / password：凭据类字段（含子串匹配，
 *     mcp.servers[].env.* 中的 *_API_KEY / *_TOKEN 环境变量键名亦命中）
 *   - tls.key：证书私钥（'.' 键按最后一段 'key' 精确匹配）
 *   - hooks.url：webhook 地址（可能内嵌签名 token，按最后一段 'url' 精确匹配，
 *     不做子串匹配以避免误伤普通 URL 字段如 avatarUrl）
 */
const REDACT_KEYS = [
  'authtoken',
  'apikey',
  'tls.key',
  'hooks.url',
  'password',
  'secret',
  'token',
];

const REDACTED = '***';
const CREDENTIAL_RESPONSE_FIELDS = 'wing:credential-response-fields';

/** Explicit credential issuance endpoints only. Does not alter request authentication or log redaction. */
export const CredentialResponse = (...fields: string[]) => SetMetadata(CREDENTIAL_RESPONSE_FIELDS, fields);

/**
 * RedactInterceptor - 响应脱敏拦截器
 *
 * 在响应返回客户端前递归遍历对象，将 authToken / apiKey / tls.key / password / secret / token
 * 等敏感字段的值替换为 ***。适用于全局注册：
 *
 *   app.useGlobalInterceptors(new RedactInterceptor());
 *
 * 组合键（tls.key / hooks.url）按"父键.键"路径精确匹配：仅脱敏 tls 对象下的
 * key、hooks 对象下的 url。此前实现用 last 段（'key'/'url'）做全局精确匹配，
 * 会误杀一切恰好叫 url 的普通字段（如聊天附件 attachment.url），
 * 导致前端图片 src 变为 *** 显示破损图。
 */
@Injectable()
export class RedactInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const handler = context.getHandler?.();
    const fields: string[] = handler ? Reflect.getMetadata(CREDENTIAL_RESPONSE_FIELDS, handler) ?? [] : [];
    return next.handle().pipe(map((data: T) => redact(data, undefined, fields)));
  }
}

export function redact(value: unknown, parentKey?: string, allowedRootFields: readonly string[] = []): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, parentKey));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // MySQL returns this public account-state flag as 0/1. Masking it as
      // "***" makes an activated member look pending in the renderer.
      if (k === 'mustChangePassword' && (typeof v === 'boolean' || v === 0 || v === 1 || v === '0' || v === '1')) {
        result[k] = v === true || v === 1 || v === '1';
      } else if (k === 'maskedApiKey' && typeof v === 'string' && /^(?:[^\r\n]{4}\*{4}|\*{4}|\$\{[A-Z_][A-Z0-9_]*\})$/.test(v)) {
        // Only a validated, already masked display value or environment reference.
        result[k] = v;
      } else if (!allowedRootFields.includes(k) && !isTokenMetric(k, v) && isRedactableKey(k, parentKey) && (typeof v === 'string' || typeof v === 'number')) {
        result[k] = REDACTED;
      } else {
        result[k] = redact(v, k);
      }
    }
    return result;
  }
  // 非普通对象（StreamableFile / Buffer / Date / 类实例等）原样透传：
  // Object.entries 重建会破坏类实例——StreamableFile 被展开成普通对象后
  // Nest 不再走流式响应而是 JSON.stringify，/files/serve 返回 JSON
  // 导致前端图片全部裂图（Content-Type 谎报 image/png 实为 JSON）
  return value;
}

/** 是否为普通对象（原型为 Object.prototype 或 null）。类实例/Buffer/流等返回 false */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** 键是否需要脱敏。parentKey 为所在对象的键（用于 tls.key / hooks.url 路径匹配） */
export function isRedactableKey(key: string, parentKey?: string): boolean {
  const lower = key.toLowerCase();
  for (const rk of REDACT_KEYS) {
    if (rk.includes('.')) {
      // 组合键：父键.键 全路径精确匹配（tls 下的 key / hooks 下的 url），
      // 不做 last 段全局匹配，避免误杀普通 url/key 字段
      const [parent, child] = rk.split('.');
      if (lower === child && parentKey && parentKey.toLowerCase() === parent) return true;
    } else if (lower.replace(/[_-]/g, '').includes(rk)) {
      return true;
    }
  }
  return false;
}
