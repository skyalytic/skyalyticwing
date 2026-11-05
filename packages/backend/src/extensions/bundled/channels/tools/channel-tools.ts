import type { ToolDefinition, ToolResult, WsEvent } from '@skyalyticwing/shared';
import { createHmac } from 'node:crypto';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import { WebSocketService } from '../../../../modules/core/websocket/websocket.service.js';
import { ConfigService } from '../../../../modules/core/config/config.service.js';
import { ssrfCheck, jsonOut } from '../../reach/tools/agent-reach.js';
import { gmailApi } from '../../shared/tools/gmail-api.js';

/** http_request / webhook_send 允许的 HTTP 方法白名单 */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
/** 通用 HTTP 超时上限 */
const MAX_TIMEOUT_MS = 60_000;
/** 响应体输出截断（字符） */
const BODY_MAX = 100_000;

/**
 * 渠道/HTTP 域内置工具（移植自旧版 network.cjs / misc.cjs）：
 * gmail_search / gmail_send / webhook_send / http_request / show_message。
 *
 * 网络类全部经 HttpClientService（SSRF fail-close + 超时 + 大小上限）。
 */
export function createChannelTools(
  security: SecurityManagerService,
  http: HttpClientService,
  ws: WebSocketService,
  config: ConfigService,
): ToolDefinition[] {
  return [
    // ═══ gmail_search ═══
    {
      name: 'gmail_search',
      description: '搜索 Gmail 邮件（Gmail API）。需要 Google OAuth 凭据，未配置时返回配置指引。',
      category: 'channel',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail 搜索查询（如 "from:someone subject:hello"）' },
          maxResults: { type: 'number', description: '最大结果数，默认 10' },
          labelIds: { type: 'array', items: { type: 'string' }, description: '标签过滤（如 INBOX/SENT）' },
        },
        required: ['query'],
      },
      async execute(args: unknown): Promise<ToolResult> { return gmailApi('search', (args || {}) as Record<string,unknown>, config, http); },
    },

    // ═══ gmail_send ═══
    {
      name: 'gmail_send',
      description: '发送 Gmail 邮件（Gmail API）。需要 Google OAuth 凭据，未配置时返回配置指引。',
      category: 'channel',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱（多个用逗号分隔）' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文' },
          cc: { type: 'string', description: '抄送（可选）' },
          bcc: { type: 'string', description: '密送（可选）' },
        },
        required: ['to', 'subject', 'body'],
      },
      async execute(args: unknown): Promise<ToolResult> { return gmailApi('send', (args || {}) as Record<string,unknown>, config, http); },
    },

    // ═══ webhook_send ═══
    {
      name: 'webhook_send',
      description:
        '向指定 URL 发送 Webhook 请求（默认 POST JSON），用于与外部系统集成。' +
        '支持 HMAC-SHA256 签名（secret 参数，签名写入 X-Signature-256 头）。SSRF 防护。',
      category: 'channel',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Webhook URL（http/https）' },
          method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'GET'], description: 'HTTP 方法，默认 POST' },
          headers: { type: 'object', description: '自定义请求头（可选）' },
          body: { type: 'object', description: '请求体 JSON（可选）' },
          secret: { type: 'string', description: 'HMAC 签名密钥（可选）' },
          timeout: { type: 'number', description: '超时毫秒数，默认 30000' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as {
          url?: string; method?: string; headers?: Record<string, string>;
          body?: unknown; secret?: string; timeout?: number;
        };
        if (!a || typeof a.url !== 'string' || a.url.length === 0) {
          return { success: false, error: 'Parameter "url" is required' };
        }
        const method = (a.method || 'POST').toUpperCase() as (typeof WEBHOOK_METHODS)[number];
        if (!WEBHOOK_METHODS.includes(method)) {
          return { success: false, error: `不支持的方法: ${method}（允许 ${WEBHOOK_METHODS.join('/')}）` };
        }
        const blocked = await ssrfCheck(security, a.url);
        if (blocked) return { success: false, error: blocked, blocked: true };
        const bodyStr = a.body !== undefined ? JSON.stringify(a.body) : '';
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'SkyalyticWing/webhook',
          ...(a.headers || {}),
        };
        if (a.secret && bodyStr) {
          headers['X-Signature-256'] = `sha256=${createHmac('sha256', a.secret).update(bodyStr).digest('hex')}`;
        }
        try {
          const resp = await http.request<unknown>(method, a.url, {
            responseType: 'text',
            timeout: Math.min(a.timeout || 30_000, MAX_TIMEOUT_MS),
            headers,
          }, bodyStr || undefined);
          const responseBody = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
          return jsonOut({
            statusCode: resp.status,
            response: (responseBody || '').slice(0, 2000),
            sentAt: new Date().toISOString(),
          });
        } catch (err) {
          return { success: false, error: `Webhook 发送失败: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },

    // ═══ http_request ═══
    {
      name: 'http_request',
      description:
        '发送通用 HTTP 请求并返回响应（方法白名单 GET/POST/PUT/PATCH/DELETE/HEAD，' +
        '超时上限 60s，响应体截断 100k 字符）。SSRF 防护。',
      category: 'channel',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL（http/https）' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP 方法，默认 GET' },
          headers: { type: 'object', description: '请求头（可选）' },
          body: { description: '请求体：字符串或可 JSON 序列化对象（可选）' },
          timeout: { type: 'number', description: '超时毫秒数，默认 30000，上限 60000' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as {
          url?: string; method?: string; headers?: Record<string, string>;
          body?: unknown; timeout?: number;
        };
        if (!a || typeof a.url !== 'string' || a.url.length === 0) {
          return { success: false, error: 'Parameter "url" is required' };
        }
        const method = (a.method || 'GET').toUpperCase() as (typeof HTTP_METHODS)[number];
        if (!HTTP_METHODS.includes(method)) {
          return { success: false, error: `不支持的方法: ${method}（允许 ${HTTP_METHODS.join('/')}）` };
        }
        const blocked = await ssrfCheck(security, a.url);
        if (blocked) return { success: false, error: blocked, blocked: true };
        try {
          const resp = await http.request<unknown>(method, a.url, {
            responseType: 'text',
            timeout: Math.min(a.timeout || 30_000, MAX_TIMEOUT_MS),
            headers: a.headers || {},
          }, a.body);
          const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
          return {
            success: true,
            output: (bodyText || '').slice(0, BODY_MAX),
            data: { status: resp.status, headers: resp.headers },
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ show_message ═══
    {
      name: 'show_message',
      description:
        '向前端推送一条即时消息（WebSocket broadcast show_message 事件），用于在用户界面弹出提示。' +
        '与 notify 的区别：show_message 面向对话内即时展示，notify 面向系统通知中心。',
      category: 'channel',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '消息标题（默认"消息"）' },
          message: { type: 'string', description: '消息内容' },
          type: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: '消息类型，默认 info' },
        },
        required: ['message'],
      },
      async execute(args: unknown, ctx): Promise<ToolResult> {
        const a = (args || {}) as { title?: string; message?: string; type?: string };
        if (typeof a.message !== 'string' || a.message.length === 0) {
          return { success: false, error: 'Parameter "message" is required' };
        }
        const title = a.title || '消息';
        const msgType: 'info' | 'success' | 'warning' | 'error' =
          a.type === 'success' || a.type === 'warning' || a.type === 'error' ? a.type : 'info';
        try {
          const event: WsEvent = {
            type: 'show_message',
            data: { title, message: a.message, messageType: msgType, sessionId: ctx.sessionId },
          };
          ws.broadcast(event);
          return { success: true, output: `Message shown: [${msgType}] ${title}` };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
