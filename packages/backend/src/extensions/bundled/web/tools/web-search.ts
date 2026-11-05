import type { ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import { ConfigService } from '../../../../modules/core/config/config.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';

function fail(error: string): ToolResult {
  return { success: false, error };
}

interface WebSearchArgs {
  query: string;
  numResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 搜索请求头（对齐旧版 web_search） */
const SEARCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** SearXNG 配置（config.web.search 段） */
interface SearchProviderConfig {
  searchProvider?: 'duckduckgo' | 'searxng';
  searxngUrl?: string;
}

/** 读取 config.web 段（缺失容忍） */
function readWebConfig(config: ConfigService): SearchProviderConfig {
  try {
    const web = config.get<Record<string, unknown>>('web');
    if (!web || typeof web !== 'object') return {};
    const search = web['search'];
    if (search && typeof search === 'object') return search as SearchProviderConfig;
    return {};
  } catch {
    return {};
  }
}

/** HTML 标签清洗 + 实体解码 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** DuckDuckGo HTML 端点解析（对齐旧版 result__a / result__snippet 正则） */
function parseDuckDuckGo(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re =
    /class="result__title"[^>]*><a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < max) {
    const url = m[1] || '';
    const title = stripTags(m[2]);
    let snippet = '';
    const snipStart = html.indexOf('class="result__snippet">', m.index);
    if (snipStart > m.index && snipStart < m.index + 2000) {
      const snipEnd = html.indexOf('</', snipStart + 25);
      if (snipEnd > 0) snippet = stripTags(html.substring(snipStart + 25, snipEnd));
    }
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** SearXNG JSON API 解析 */
function parseSearxng(data: unknown, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const list = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(list)) return results;
  for (const item of list) {
    if (results.length >= max) break;
    const r = item as { title?: string; url?: string; content?: string };
    if (typeof r.url === 'string' && typeof r.title === 'string') {
      results.push({ title: r.title, url: r.url, snippet: typeof r.content === 'string' ? r.content : '' });
    }
  }
  return results;
}

/**
 * web_search 工具：通用网页搜索（移植自旧版 start.cjs executeWebTool('web_search')）。
 *
 * 搜索源优先级：
 *   1. config.web.search 配置（searchProvider=searxng + searxngUrl，JSON API）
 *   2. DuckDuckGo HTML 端点（https://html.duckduckgo.com/html/?q=，免 Key）
 *
 * 安全：所有请求经 HttpClientService（内置 SSRF fail-close）；结果数上限 10。
 * 失败时返回配置指引（不抛错）。
 */
export function createWebSearchTool(
  security: SecurityManagerService,
  http: HttpClientService,
  config: ConfigService,
): ToolDefinition {
  return {
    name: 'web_search',
    description:
      '通用网页搜索：返回标题/URL/摘要结果列表（默认前 10 条）。' +
      '优先使用 config.web.search 配置的搜索提供商（searxng），未配置时使用 DuckDuckGo HTML 端点。' +
      '所有请求经 SSRF 防护。',
    category: 'web',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        numResults: { type: 'number', description: '返回结果数（默认 10，上限 10）' },
      },
      required: ['query'],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const a = (args || {}) as WebSearchArgs;
      if (typeof a.query !== 'string' || a.query.length === 0) {
        return fail('Parameter "query" is required');
      }
      const max = Math.max(1, Math.min(10, Math.floor(a.numResults || 10)));
      const query = encodeURIComponent(a.query);
      const webCfg = readWebConfig(config);
      const errors: string[] = [];

      // 1) SearXNG（配置了才用）
      if (webCfg.searchProvider === 'searxng' && webCfg.searxngUrl) {
        const url = `${webCfg.searxngUrl.replace(/\/$/, '')}/search?q=${query}&format=json`;
        if (security.checkUrlSync(url)) {
          try {
            const resp = await http.get<unknown>(url, {
              headers: SEARCH_HEADERS,
              responseType: 'json',
              timeout: 15_000,
            });
            if (resp.status < 400) {
              const results = parseSearxng(resp.data, max);
              if (results.length > 0) {
                return jsonOut({ engine: 'searxng', query: a.query, results });
              }
            }
          } catch (err) {
            errors.push(`searxng: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          errors.push('searxng: URL 被 SSRF 守卫拦截');
        }
      }

      // 2) DuckDuckGo HTML 端点
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${query}`;
      try {
        const resp = await http.get<string>(ddgUrl, {
          headers: SEARCH_HEADERS,
          responseType: 'text',
          timeout: 15_000,
        });
        if (resp.status < 400 && typeof resp.data === 'string') {
          const results = parseDuckDuckGo(resp.data, max);
          if (results.length > 0) {
            return jsonOut({ engine: 'duckduckgo', query: a.query, results });
          }
          errors.push('duckduckgo: 无解析结果（页面结构可能变更）');
        } else {
          errors.push(`duckduckgo: HTTP ${resp.status}`);
        }
      } catch (err) {
        errors.push(`duckduckgo: ${err instanceof Error ? err.message : String(err)}`);
      }

      return fail(
        '搜索失败：' + errors.join('；') +
        '。指引：可在 config.web.search 配置 searchProvider=searxng 与 searxngUrl' +
        '（自建 SearXNG 实例 JSON API），或检查网络连通性后重试。',
      );
    },
  };
}
