import type { ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import { ConfigService } from '../../../../modules/core/config/config.service.js';

const FETCH_TIMEOUT = 30_000;
/** web_read 输出截断（字符），对齐旧版 */
const WEB_READ_MAX = 100_000;

interface GeneralConfig {
  exaApiKey?: string;
  githubToken?: string;
  openWeatherApiKey?: string;
}

/** 读取 general 配置段（缺失容忍） */
function readGeneral(config: ConfigService): GeneralConfig {
  try {
    return config.get<GeneralConfig>('general') || {};
  } catch {
    return {};
  }
}

/** SSRF 双重校验（同步主机名校验 + 异步 DNS 校验），与 web-fetch.ts 一致 */
export async function ssrfCheck(
  security: SecurityManagerService,
  url: string,
): Promise<string | null> {
  if (!security.checkUrlSync(url)) return `URL blocked by SSRF guard: ${url}`;
  try {
    const dns = await security.checkUrl(url);
    if (!dns.safe) return `URL blocked by SSRF DNS check: ${url}`;
  } catch {
    return `URL blocked by SSRF DNS check: ${url}`;
  }
  return null;
}

/** JSON 输出统一序列化 */
export function jsonOut(data: unknown): ToolResult {
  return { success: true, data, output: JSON.stringify(data, null, 2) };
}

/** IP 定位：ipapi.co → ipinfo.io 回退，返回城市名（失败返回空串） */
async function ipLocate(http: HttpClientService, security: SecurityManagerService): Promise<string> {
  const endpoints = ['https://ipapi.co/json/', 'https://ipinfo.io/json'];
  for (const ep of endpoints) {
    try {
      const blocked = await ssrfCheck(security, ep);
      if (blocked) continue;
      const resp = await http.get<{ city?: string; loc?: string; latitude?: number; longitude?: number }>(ep, {
        responseType: 'json',
        timeout: 10_000,
      });
      if (resp.status !== 200) continue;
      const d = resp.data || {};
      if (d.city) return d.city;
      if (d.latitude && d.longitude) return `${d.latitude},${d.longitude}`;
      if (d.loc) return d.loc;
    } catch {
      // 尝试下一个
    }
  }
  return '';
}

// ─── 轻量 XML → 节点树（仅满足 RSS 2.0 / Atom 解析） ───────────────

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode[] {
  const cleaned = xml
    .replace(/<\?xml[\s\S]*?\?>/, '')
    .replace(/<!DOCTYPE[\s\S]*?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return parseNodes(cleaned);
}

function parseNodes(str: string): XmlNode[] {
  const nodes: XmlNode[] = [];
  let i = 0;
  while (i < str.length) {
    const open = str.indexOf('<', i);
    if (open === -1) break;
    if (str.charAt(open + 1) === '/') {
      i = open + 1;
      continue;
    }
    const close = str.indexOf('>', open);
    if (close === -1) break;
    const tagContent = str.substring(open + 1, close);
    const tagName = tagContent.split(/[\s/]/)[0] || '';
    const attrs: Record<string, string> = {};
    const attrMatches = tagContent.match(/(\w[\w-]*)\s*=\s*"([^"]*)"/g) || [];
    for (const m of attrMatches) {
      const parts = m.match(/(\w[\w-]*)\s*=\s*"([^"]*)"/);
      if (parts) attrs[parts[1] || ''] = parts[2] || '';
    }
    const selfClosing = tagContent.charAt(tagContent.length - 1) === '/';
    const node: XmlNode = { name: tagName, attrs, children: [], text: '' };
    if (selfClosing) {
      nodes.push(node);
      i = close + 1;
      continue;
    }
    const closeTag = `</${tagName}>`;
    const endIdx = str.indexOf(closeTag, close + 1);
    if (endIdx === -1) {
      i = close + 1;
      continue;
    }
    const inner = str.substring(close + 1, endIdx).trim();
    if (inner.indexOf('<') === -1) {
      node.text = decodeEntities(inner);
    } else {
      node.children = parseNodes(inner);
    }
    nodes.push(node);
    i = endIdx + closeTag.length;
  }
  return nodes;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function childText(node: XmlNode, name: string): string {
  const c = node.children.find((x) => x.name === name);
  if (!c) return '';
  return c.text || (c.children.length > 0 ? c.children[0].text : '');
}

/**
 * Agent Reach 域内置工具（移植自旧版 agent-reach.cjs 零配置部分）：
 * web_read / rss_read / v2ex_hot / bilibili_search / github_search / exa_search / weather。
 *
 * 网络请求统一走 HttpClientService（内置 SSRF fail-close、30s 超时、50MB 上限），
 * 外加 SecurityManagerService 双重校验。
 */
export function createAgentReachTools(
  security: SecurityManagerService,
  http: HttpClientService,
  config: ConfigService,
): ToolDefinition[] {
  return [
    // ═══ web_read ═══
    {
      name: 'web_read',
      description:
        '读取任意网页正文并转为 Markdown（基于 Jina Reader r.jina.ai，免配置）。' +
        '适合读取文章、文档、博客；与 web-fetch 互补（web_read 返回正文 Markdown，web-fetch 返回原始内容）。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL（含 http:// 或 https://）' },
          timeout: { type: 'number', description: '超时毫秒数，默认 30000' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { url?: string; timeout?: number };
        if (!a || typeof a.url !== 'string' || a.url.length === 0) {
          return { success: false, error: 'Parameter "url" is required' };
        }
        const jinaUrl = `https://r.jina.ai/${a.url}`;
        const blocked = await ssrfCheck(security, jinaUrl);
        if (blocked) return { success: false, error: blocked, blocked: true };
        try {
          const resp = await http.get<string>(jinaUrl, {
            responseType: 'text',
            timeout: Math.min(a.timeout || FETCH_TIMEOUT, 60_000),
            headers: { 'User-Agent': 'SkyalyticWing-agent-reach/1.0', Accept: 'text/plain' },
          });
          if (resp.status !== 200) {
            return { success: false, error: `Jina Reader 返回 HTTP ${resp.status}` };
          }
          const content = String(resp.data || '').slice(0, WEB_READ_MAX);
          return {
            success: true,
            output: content,
            data: { url: a.url, length: content.length, source: 'jina-reader' },
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ rss_read ═══
    {
      name: 'rss_read',
      description: '读取 RSS 2.0 / Atom 订阅源，返回标题与条目列表（标题/链接/摘要/日期）。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'RSS/Atom feed URL' },
          limit: { type: 'number', description: '返回条目数量，默认 10' },
        },
        required: ['url'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { url?: string; limit?: number };
        if (!a || typeof a.url !== 'string' || a.url.length === 0) {
          return { success: false, error: 'Parameter "url" is required' };
        }
        const blocked = await ssrfCheck(security, a.url);
        if (blocked) return { success: false, error: blocked, blocked: true };
        try {
          const resp = await http.get<string>(a.url, {
            responseType: 'text',
            timeout: FETCH_TIMEOUT,
            headers: {
              'User-Agent': 'SkyalyticWing-agent-reach/1.0',
              Accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml',
            },
          });
          if (resp.status !== 200) {
            return { success: false, error: `HTTP ${resp.status}` };
          }
          const roots = parseXml(String(resp.data || ''));
          if (roots.length === 0) return { success: false, error: 'XML 解析失败' };
          const root = roots[0];
          const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 10;
          let title = '';
          let items: Array<{ title: string; link: string; description: string; pubDate: string }>;
          if (root.name === 'rss') {
            const channel = root.children.find((c) => c.name === 'channel') || root;
            title = childText(channel, 'title');
            items = channel.children
              .filter((c) => c.name === 'item')
              .slice(0, limit)
              .map((item) => ({
                title: childText(item, 'title'),
                link: childText(item, 'link'),
                description: childText(item, 'description').slice(0, 500),
                pubDate: childText(item, 'pubDate'),
              }));
          } else if (root.name === 'feed') {
            title = childText(root, 'title');
            items = root.children
              .filter((c) => c.name === 'entry')
              .slice(0, limit)
              .map((entry) => ({
                title: childText(entry, 'title'),
                link: entry.children.find((c) => c.name === 'link')?.attrs['href'] || '',
                description: (childText(entry, 'summary') || childText(entry, 'content')).slice(0, 500),
                pubDate: childText(entry, 'published') || childText(entry, 'updated'),
              }));
          } else {
            return { success: false, error: `未识别的 feed 格式: ${root.name}` };
          }
          return jsonOut({ url: a.url, format: root.name, title, count: items.length, items });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ v2ex_hot ═══
    {
      name: 'v2ex_hot',
      description:
        '获取 V2EX 热门主题 / 节点主题 / 主题详情 / 主题回复 / 用户信息。公开 API，无需认证。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['hot', 'node', 'topic', 'replies', 'member'],
            description: 'hot=热门主题；node=节点主题；topic=主题详情；replies=主题回复；member=用户信息',
          },
          node_name: { type: 'string', description: 'action=node 时的节点名（如 python/tech/jobs/qna）' },
          topic_id: { type: 'number', description: 'action=topic/replies 时的主题 ID' },
          username: { type: 'string', description: 'action=member 时的用户名' },
          limit: { type: 'number', description: '返回条目数量，默认 20' },
        },
        required: ['action'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as {
          action?: string; node_name?: string; topic_id?: number; username?: string; limit?: number;
        };
        let apiUrl = '';
        switch (a.action) {
          case 'hot':
            apiUrl = 'https://www.v2ex.com/api/topics/hot.json';
            break;
          case 'node':
            if (!a.node_name) return { success: false, error: 'action=node 需提供 node_name' };
            apiUrl = `https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(a.node_name)}&page=1`;
            break;
          case 'topic':
            if (!a.topic_id) return { success: false, error: 'action=topic 需提供 topic_id' };
            apiUrl = `https://www.v2ex.com/api/topics/show.json?id=${a.topic_id}`;
            break;
          case 'replies':
            if (!a.topic_id) return { success: false, error: 'action=replies 需提供 topic_id' };
            apiUrl = `https://www.v2ex.com/api/replies/show.json?topic_id=${a.topic_id}&page=1`;
            break;
          case 'member':
            if (!a.username) return { success: false, error: 'action=member 需提供 username' };
            apiUrl = `https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(a.username)}`;
            break;
          default:
            return { success: false, error: `未知 action: ${a.action}` };
        }
        const blocked = await ssrfCheck(security, apiUrl);
        if (blocked) return { success: false, error: blocked, blocked: true };
        try {
          const resp = await http.get<unknown>(apiUrl, {
            responseType: 'json',
            timeout: 20_000,
            headers: { 'User-Agent': 'SkyalyticWing-agent-reach/1.0' },
          });
          if (resp.status !== 200) {
            return { success: false, error: `V2EX API 返回 HTTP ${resp.status}` };
          }
          let data = resp.data;
          const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 20;
          if (Array.isArray(data)) {
            data = (data as Array<Record<string, unknown>>).slice(0, limit).map((t) => ({
              id: t['id'],
              title: t['title'],
              node: (t['node'] as { title?: string } | undefined)?.title || '',
              author: (t['member'] as { username?: string } | undefined)?.username || '',
              replies: t['replies'],
              url: `https://www.v2ex.com/t/${t['id']}`,
            }));
          }
          return jsonOut({ action: a.action, count: Array.isArray(data) ? data.length : 1, data });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ bilibili_search ═══
    {
      name: 'bilibili_search',
      description:
        'B 站视频搜索（公开搜索 API，自动获取匿名 cookie）。返回标题、UP 主、播放量、BV 号等。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          page: { type: 'number', description: '页码，默认 1' },
          limit: { type: 'number', description: '返回条目数量，默认 10' },
        },
        required: ['keyword'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { keyword?: string; page?: number; limit?: number };
        if (!a || typeof a.keyword !== 'string' || a.keyword.length === 0) {
          return { success: false, error: 'Parameter "keyword" is required' };
        }
        const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        try {
          // Step 1: 访问首页获取匿名 cookie（失败不阻断，降级为无 cookie 搜索）
          const blockedHome = await ssrfCheck(security, 'https://www.bilibili.com/');
          if (blockedHome) return { success: false, error: blockedHome, blocked: true };
          let cookies = '';
          try {
            const home = await http.get<unknown>('https://www.bilibili.com/', {
              responseType: 'text',
              timeout: 15_000,
              headers: { 'User-Agent': UA },
            });
            const setCookie = home.headers['set-cookie'] || '';
            if (setCookie) {
              cookies = setCookie
                .split(',')
                .map((c) => c.split(';')[0].trim())
                .filter((c) => {
                  const key = c.split('=')[0] || '';
                  return c.includes('=') && !/^(path|expires|domain|max-age|samesite|secure|httponly)$/i.test(key);
                })
                .slice(0, 4)
                .join('; ');
            }
          } catch {
            // 降级：无 cookie
          }
          // Step 2: 调用搜索 API
          const searchUrl = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(a.keyword)}&page=${a.page || 1}`;
          const blocked = await ssrfCheck(security, searchUrl);
          if (blocked) return { success: false, error: blocked, blocked: true };
          const resp = await http.get<BiliResp>(searchUrl, {
            responseType: 'json',
            timeout: 20_000,
            headers: {
              'User-Agent': UA,
              Referer: 'https://www.bilibili.com/',
              ...(cookies ? { Cookie: cookies } : {}),
            },
          });
          if (resp.status !== 200) {
            return { success: false, error: `B 站 API 返回 HTTP ${resp.status}` };
          }
          const body = resp.data;
          if (!body || body.code !== 0) {
            return { success: false, error: `B 站 API 错误 code=${body?.code}: ${body?.message || ''}` };
          }
          const results: Array<Record<string, unknown>> = [];
          for (const block of body.data?.result || []) {
            if (block.result_type === 'video' && Array.isArray(block.data)) {
              for (const v of block.data) {
                results.push({
                  bvid: v['bvid'],
                  title: String(v['title'] || '').replace(/<[^>]+>/g, ''),
                  author: v['author'],
                  play: v['play'],
                  review: v['review'],
                  favorites: v['favorites'],
                  duration: v['duration'],
                  pubdate: v['pubdate'],
                  tag: v['tag'],
                  url: `https://www.bilibili.com/video/${v['bvid']}`,
                });
              }
            }
          }
          const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 10;
          return jsonOut({
            keyword: a.keyword,
            page: a.page || 1,
            count: Math.min(results.length, limit),
            videos: results.slice(0, limit),
          });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ github_search ═══
    {
      name: 'github_search',
      description:
        'GitHub 搜索：仓库 / 代码 / Issue（REST API）。未认证 60 次/小时，' +
        '配置 general.githubToken 或环境变量 GITHUB_TOKEN 后 5000 次/小时。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['repos', 'code', 'issues'], description: '搜索类型' },
          query: {
            type: 'string',
            description: '搜索查询（支持 GitHub 搜索语法，如 "language:python stars:>100"）',
          },
          sort: { type: 'string', description: '排序字段（可选）' },
          order: { type: 'string', enum: ['desc', 'asc'], description: '排序方向，默认 desc' },
          limit: { type: 'number', description: '返回条目数量，默认 10（最大 30）' },
        },
        required: ['type', 'query'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as {
          type?: 'repos' | 'code' | 'issues'; query?: string; sort?: string; order?: 'desc' | 'asc'; limit?: number;
        };
        if (!a || !a.query) return { success: false, error: 'Parameter "query" is required' };
        const type = a.type || 'repos';
        const limit = Math.min(typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 10, 30);
        const sort = a.sort || (type === 'repos' ? 'stars' : type === 'issues' ? 'created' : 'indexed');
        const order = a.order || 'desc';
        const apiUrl =
          `https://api.github.com/search/${type}?q=${encodeURIComponent(a.query)}` +
          `&sort=${encodeURIComponent(sort)}&order=${order}&per_page=${limit}`;
        const blocked = await ssrfCheck(security, apiUrl);
        if (blocked) return { success: false, error: blocked, blocked: true };
        const general = readGeneral(config);
        const token = general.githubToken || process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || '';
        const headers: Record<string, string> = {
          'User-Agent': 'SkyalyticWing-agent-reach/1.0',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
        try {
          const resp = await http.get<GithubSearchResp>(apiUrl, {
            responseType: 'json',
            timeout: 20_000,
            headers,
          });
          if (resp.status === 403) {
            return {
              success: false,
              error: 'GitHub API 速率限制（未认证 60 次/小时）。配置 general.githubToken 可解锁 5000 次/小时。',
            };
          }
          if (resp.status !== 200) {
            return { success: false, error: `GitHub API 返回 HTTP ${resp.status}` };
          }
          const data = resp.data;
          const items = (data.items || []).slice(0, limit).map((item) => {
            if (type === 'repos') {
              return {
                full_name: item.full_name,
                description: item.description,
                url: item.html_url,
                stars: item.stargazers_count,
                forks: item.forks_count,
                language: item.language,
                updated: item.updated_at,
              };
            }
            if (type === 'code') {
              return {
                name: item.name,
                path: item.path,
                repo: item.repository?.full_name || '',
                url: item.html_url,
              };
            }
            return {
              title: item.title,
              number: item.number,
              state: item.state,
              repo: String(item.repository_url || '').replace('https://api.github.com/repos/', ''),
              url: item.html_url,
              created: item.created_at,
              comments: item.comments,
              author: item.user?.login || '',
            };
          });
          return jsonOut({
            type,
            query: a.query,
            total_count: data.total_count,
            count: items.length,
            items,
            rateLimitRemaining: resp.headers['x-ratelimit-remaining'] || '?',
            authenticated: !!token,
          });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ exa_search ═══
    {
      name: 'exa_search',
      description:
        'Exa AI 神经搜索（擅长英文技术文档与代码）。需配置 general.exaApiKey 或环境变量 EXA_API_KEY。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索查询' },
          numResults: { type: 'number', description: '结果数量，默认 5（最大 10）' },
          type: {
            type: 'string',
            enum: ['auto', 'keyword', 'neural'],
            description: '搜索类型，默认 auto',
          },
          includeContents: { type: 'boolean', description: '是否包含页面正文，默认 false' },
        },
        required: ['query'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { query?: string; numResults?: number; type?: 'auto' | 'keyword' | 'neural'; includeContents?: boolean };
        if (!a || typeof a.query !== 'string' || a.query.length === 0) {
          return { success: false, error: 'Parameter "query" is required' };
        }
        const general = readGeneral(config);
        const exaKey = general.exaApiKey || process.env['EXA_API_KEY'] || '';
        if (!exaKey) {
          return {
            success: false,
            error: '未配置 Exa API Key。请在配置 general.exaApiKey 或环境变量 EXA_API_KEY 中设置（免费 Key: https://console.exa.ai）。',
          };
        }
        const apiUrl = 'https://api.exa.ai/search';
        const blocked = await ssrfCheck(security, apiUrl);
        if (blocked) return { success: false, error: blocked, blocked: true };
        const body = {
          query: a.query,
          numResults: Math.min(a.numResults || 5, 10),
          type: a.type || 'auto',
          ...(a.includeContents ? { contents: { text: true } } : {}),
        };
        try {
          const resp = await http.post<ExaResp>(apiUrl, body, {
            responseType: 'json',
            timeout: 25_000,
            headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
          });
          if (resp.status !== 200) {
            return { success: false, error: `Exa API 返回 HTTP ${resp.status}` };
          }
          const results = (resp.data?.results || []).map((r) => ({
            title: r.title || '',
            url: r.url || '',
            publishedDate: r.publishedDate || '',
            author: r.author || '',
            score: r.score,
            ...(r.text ? { text: r.text.slice(0, 2000) } : {}),
          }));
          return jsonOut({ query: a.query, count: results.length, results });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    // ═══ weather ═══
    {
      name: 'weather',
      description:
        '查询天气。未配置 API Key 时使用 wttr.in 免费源；配置 general.openWeatherApiKey 后走 OpenWeatherMap。' +
        '不指定地点时自动 IP 定位。',
      category: 'web',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '城市名（如"北京"、"Tokyo"），缺省自动 IP 定位' },
          days: { type: 'number', description: '预报天数（1-7，仅 wttr.in 源支持），默认 1' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { location?: string; days?: number };
        const general = readGeneral(config);
        const owmKey = general.openWeatherApiKey || process.env['OPENWEATHER_API_KEY'] || '';
        const days = Math.min(Math.max(typeof a.days === 'number' ? Math.floor(a.days) : 1, 1), 7);
        try {
          let location = a.location || '';
          if (!location) {
            location = await ipLocate(http, security);
            if (!location) return { success: false, error: 'IP 定位失败，请提供 location 参数' };
          }
          if (owmKey) {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${owmKey}&units=metric`;
            const blocked = await ssrfCheck(security, url);
            if (blocked) return { success: false, error: blocked, blocked: true };
            const resp = await http.get<OwmResp>(url, { responseType: 'json', timeout: 15_000 });
            if (resp.status !== 200 || !resp.data || resp.data.cod !== 200) {
              return { success: false, error: `OpenWeatherMap 查询失败: HTTP ${resp.status}` };
            }
            return jsonOut({
              location,
              source: 'openweathermap',
              temperature: `${resp.data.main?.temp ?? 'N/A'}°C`,
              description: resp.data.weather?.[0]?.description || 'N/A',
              humidity: resp.data.main?.humidity ?? 'N/A',
              wind: `${resp.data.wind?.speed ?? 'N/A'} m/s`,
            });
          }
          // wttr.in 免费源
          const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
          const blocked = await ssrfCheck(security, url);
          if (blocked) return { success: false, error: blocked, blocked: true };
          const resp = await http.get<WttrResp>(url, { responseType: 'json', timeout: 20_000 });
          if (resp.status !== 200) {
            return { success: false, error: `wttr.in 返回 HTTP ${resp.status}` };
          }
          const cur = resp.data?.current_condition?.[0];
          if (!cur) return { success: false, error: '天气数据解析失败' };
          const result: Record<string, unknown> = {
            location,
            source: 'wttr.in',
            temperature: `${cur.temp_C ?? 'N/A'}°C`,
            feelsLike: cur.FeelsLikeC ? `${cur.FeelsLikeC}°C` : undefined,
            description: cur.weatherDesc?.[0]?.value || 'N/A',
            humidity: cur.humidity || 'N/A',
            wind: cur.windspeedKmph ? `${cur.windspeedKmph} km/h` : 'N/A',
          };
          if (days > 1) {
            result['forecast'] = (resp.data?.weather || []).slice(0, days).map((w) => ({
              date: w.date,
              maxTemp: `${w.maxtempC}°C`,
              minTemp: `${w.mintempC}°C`,
              avgTemp: `${w.avgtempC}°C`,
            }));
          }
          return jsonOut(result);
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

// ─── 外部 API 响应类型（仅声明使用的字段） ─────────────────────────

interface BiliResp {
  code: number;
  message?: string;
  data?: {
    result?: Array<{ result_type?: string; data?: Array<Record<string, unknown>> }>;
  };
}

interface GithubSearchResp {
  total_count: number;
  items?: Array<{
    full_name?: string;
    description?: string;
    html_url?: string;
    stargazers_count?: number;
    forks_count?: number;
    language?: string;
    updated_at?: string;
    name?: string;
    path?: string;
    repository?: { full_name?: string };
    title?: string;
    number?: number;
    state?: string;
    repository_url?: string;
    created_at?: string;
    comments?: number;
    user?: { login?: string };
  }>;
}

interface ExaResp {
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    author?: string;
    score?: number;
    text?: string;
  }>;
}

interface OwmResp {
  cod: number;
  main?: { temp?: number; humidity?: number };
  weather?: Array<{ description?: string }>;
  wind?: { speed?: number };
}

interface WttrResp {
  current_condition?: Array<{
    temp_C?: string;
    FeelsLikeC?: string;
    weatherDesc?: Array<{ value: string }>;
    humidity?: string;
    windspeedKmph?: string;
  }>;
  weather?: Array<{ date: string; maxtempC: string; mintempC: string; avgtempC: string }>;
}
