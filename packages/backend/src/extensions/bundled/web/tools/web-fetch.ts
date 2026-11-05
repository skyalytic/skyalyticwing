import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';

interface WebFetchArgs {
  url: string;
  format?: 'text' | 'json' | 'html';
}

/** HTTP 请求超时（30s），与 HttpClientService 默认一致 */
const FETCH_TIMEOUT = 30_000;

/**
 * web-fetch 工具：抓取 URL 内容。
 * 安全：SecurityManagerService.checkUrl 进行 SSRF fail-close 校验
 *       （HttpClientService 内部亦会再次校验，双重防护）。
 * 超时 30s、响应大小限制 50MB（由 HttpClientService 强制）。
 */
export function createWebFetchTool(
  security: SecurityManagerService,
  http: HttpClientService,
): ToolDefinition {
  return {
    name: 'web-fetch',
    description: '抓取 URL 内容（http/https），支持 text/json/html 格式。SSRF fail-close。',
    category: 'web',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http/https URL' },
        format: {
          type: 'string',
          enum: ['text', 'json', 'html'],
          description: '响应格式：text 返回纯文本，json 自动解析，html 返回原始 HTML（默认 text）',
        },
      },
      required: ['url'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as WebFetchArgs;
      if (!a || typeof a.url !== 'string' || a.url.length === 0) {
        return { success: false, error: 'Parameter "url" is required and must be a non-empty string' };
      }
      // SSRF fail-close（同步主机名校验 + 异步 DNS 校验）
      if (!security.checkUrlSync(a.url)) {
        return { success: false, error: `URL blocked by SSRF guard: ${a.url}`, blocked: true };
      }
      let dnsOk: boolean;
      try {
        dnsOk = (await security.checkUrl(a.url)).safe;
      } catch {
        dnsOk = false;
      }
      if (!dnsOk) {
        return { success: false, error: `URL blocked by SSRF DNS check: ${a.url}`, blocked: true };
      }
      const format = a.format ?? 'text';
      const responseType = format === 'json' ? 'json' : 'text';
      try {
        const resp = await http.get<unknown>(a.url, {
          responseType,
          timeout: FETCH_TIMEOUT,
        });
        if (resp.status >= 400) {
          return {
            success: false,
            error: `HTTP ${resp.status}`,
            output: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
          };
        }
        const output =
          typeof resp.data === 'string'
            ? resp.data
            : JSON.stringify(resp.data, null, 2);
        return { success: true, output };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
