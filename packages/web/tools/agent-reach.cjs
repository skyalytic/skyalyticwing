/**
 * Agent Reach 原生工具模块 (热加载)
 *
 * 将 Agent-Reach 的 15 平台互联网能力中"零配置"部分原生集成到 SkyalyticWing，
 * 无需用户安装 Python / agent-reach CLI 即可使用：
 *   - web_read        : 通用网页阅读 (Jina Reader)
 *   - rss_read        : RSS/Atom 订阅源阅读
 *   - v2ex_hot        : V2EX 热门/节点/主题/回复
 *   - bilibili_search : B站搜索 API 直连 (零登录)
 *   - github_search   : GitHub 仓库/代码/Issue 搜索 (REST API)
 *   - exa_search      : Exa AI 搜索 (可选 API Key)
 *   - agent_reach_doctor : 平台连通性体检
 *
 * 需登录态的平台 (Twitter/小红书/Reddit/Facebook/Instagram/雪球/LinkedIn/小宇宙)
 * 见 skills/agent-reach/SKILL.md，AI 通过 bash 调用外部 CLI (opencli/twitter/rdt 等)。
 *
 * 上下文 (ctx) 需提供: log, SecurityManager, configStore, APP_VERSION
 */

var https = require('https');
var http = require('http');

// ═══ 内部辅助 ═══════════════════════════════════════════════

function _httpGet(url, options, timeout) {
  // 返回 Promise<{statusCode, headers, body}>
  options = options || {};
  timeout = timeout || 30000;
  return new Promise(function(resolve) {
    var mod = url.indexOf('https://') === 0 ? https : http;
    var reqOptions = { method: 'GET', headers: options.headers || {} };
    var req = mod.get(url, reqOptions, function(res) {
      var body = '';
      var oversized = false;
      res.on('data', function(chunk) {
        if (oversized) return;
        body += chunk.toString();
        if (body.length > 1500000) {
          oversized = true;
          req.destroy();
          resolve({ statusCode: res.statusCode, headers: res.headers, body: body.substring(0, 1500000), error: '响应体过大(>1.5MB)已截断' });
        }
      });
      res.on('end', function() {
        if (!oversized) resolve({ statusCode: res.statusCode, headers: res.headers, body: body });
      });
      res.on('error', function(e) {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: body, error: e.message });
      });
    });
    req.on('error', function(e) { resolve({ statusCode: 0, headers: {}, body: '', error: e.message }); });
    req.setTimeout(timeout, function() { req.destroy(); resolve({ statusCode: 0, headers: {}, body: '', error: '请求超时(' + timeout + 'ms)' }); });
  });
}

function _httpPost(url, body, options, timeout) {
  options = options || {};
  timeout = timeout || 30000;
  return new Promise(function(resolve) {
    var mod = url.indexOf('https://') === 0 ? https : http;
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
    var reqOptions = { method: options.method || 'POST', headers: headers };
    var req = mod.request(url, reqOptions, function(res) {
      var respBody = '';
      var oversized = false;
      res.on('data', function(chunk) {
        if (oversized) return;
        respBody += chunk.toString();
        if (respBody.length > 1500000) { oversized = true; req.destroy(); resolve({ statusCode: res.statusCode, headers: res.headers, body: respBody.substring(0, 1500000), error: '响应体过大已截断' }); }
      });
      res.on('end', function() { if (!oversized) resolve({ statusCode: res.statusCode, headers: res.headers, body: respBody }); });
      res.on('error', function(e) { resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: respBody, error: e.message }); });
    });
    req.on('error', function(e) { resolve({ statusCode: 0, headers: {}, body: '', error: e.message }); });
    req.setTimeout(timeout, function() { req.destroy(); resolve({ statusCode: 0, headers: {}, body: '', error: '请求超时(' + timeout + 'ms)' }); });
    req.write(bodyStr);
    req.end();
  });
}

async function _safeCheck(SecurityManager, url) {
  if (SecurityManager && typeof SecurityManager.checkUrl === 'function') {
    try {
      var check = await SecurityManager.checkUrl(url);
      if (check && !check.safe) return check.reason || '不允许访问该地址';
    } catch(e) { return 'SSRF检查失败: ' + e.message; }
  }
  return null;
}

// 简易 XML → JSON 解析 (仅满足 RSS/Atom 解析需要)
function _parseXml(xml) {
  // 去声明与注释
  var cleaned = xml.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!DOCTYPE[\s\S]*?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  function parseNode(str) {
    var nodes = [];
    var i = 0;
    while (i < str.length) {
      var open = str.indexOf('<', i);
      if (open === -1) break;
      if (str.charAt(open + 1) === '/') { i = open + 1; continue; }
      var close = str.indexOf('>', open);
      if (close === -1) break;
      var tagContent = str.substring(open + 1, close);
      var tagName = tagContent.split(/[\s\/]/)[0];
      var attrs = {};
      var attrMatch = tagContent.match(/(\w[\w-]*)\s*=\s*"([^"]*)"/g);
      if (attrMatch) {
        for (var a = 0; a < attrMatch.length; a++) {
          var parts = attrMatch[a].match(/(\w[\w-]*)\s*=\s*"([^"]*)"/);
          if (parts) attrs[parts[1]] = parts[2];
        }
      }
      var selfClosing = tagContent.charAt(tagContent.length - 1) === '/';
      var node = { name: tagName, attrs: attrs, children: [], text: '' };
      if (selfClosing) { nodes.push(node); i = close + 1; continue; }
      var closeTag = '</' + tagName + '>';
      var endIdx = str.indexOf(closeTag, close + 1);
      if (endIdx === -1) { i = close + 1; continue; }
      var inner = str.substring(close + 1, endIdx).trim();
      if (inner.indexOf('<') === -1) {
        node.text = inner;
      } else {
        node.children = parseNode(inner);
      }
      nodes.push(node);
      i = endIdx + closeTag.length;
    }
    return nodes;
  }
  return parseNode(cleaned);
}

function _rssToJson(xml) {
  var roots = _parseXml(xml);
  if (!roots.length) return { error: 'XML解析失败' };
  var root = roots[0];
  // RSS 2.0: rss/channel/item
  if (root.name === 'rss') {
    var channel = root.children.filter(function(c){return c.name==='channel';})[0] || root;
    var items = channel.children.filter(function(c){return c.name==='item';}).map(function(item) {
      var obj = {};
      item.children.forEach(function(c) { obj[c.name] = c.text || (c.children.length ? c.children[0].text : ''); });
      return obj;
    });
    return { format: 'rss', title: (channel.children.filter(function(c){return c.name==='title';})[0]||{}).text || '', items: items };
  }
  // Atom: feed/entry
  if (root.name === 'feed') {
    var entries = root.children.filter(function(c){return c.name==='entry';}).map(function(entry) {
      var obj = {};
      entry.children.forEach(function(c) {
        if (c.name === 'link') { obj.link = c.attrs.href || ''; return; }
        obj[c.name] = c.text || (c.children.length ? c.children[0].text : '');
      });
      return obj;
    });
    var feedTitle = (root.children.filter(function(c){return c.name==='title';})[0]||{}).text || '';
    return { format: 'atom', title: feedTitle, items: entries };
  }
  return { error: '未识别的feed格式: ' + root.name };
}

module.exports = [

  // ═══ agent_reach_doctor ═══════════════════════════════════
  {
    name: 'agent_reach_doctor',
    description: 'Agent Reach 平台连通性体检。检测各平台 API 是否可访问、外部 CLI 是否可用。返回每个平台的状态(ok/fail/skip)和可用后端。无需任何配置即可运行。',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '可选：只检测指定平台(web/v2ex/bilibili/github/rss/exa)。不填则全部检测。' }
      },
      required: []
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var execSync = ctx.execSync;
      var platforms = ['web', 'v2ex', 'bilibili', 'github', 'rss', 'exa'];
      if (args.platform) platforms = [args.platform];
      var results = {};

      async function checkHttp(name, url, headers) {
        var ssrf = await _safeCheck(SecurityManager, url);
        if (ssrf) { results[name] = { status: 'fail', reason: 'SSRF拦截: ' + ssrf }; return; }
        var resp = await _httpGet(url, { headers: headers || {} }, 15000);
        if (resp.error) { results[name] = { status: 'fail', reason: resp.error }; return; }
        if (resp.statusCode >= 200 && resp.statusCode < 400) {
          results[name] = { status: 'ok', statusCode: resp.statusCode, backend: 'native' };
        } else {
          results[name] = { status: 'fail', reason: 'HTTP ' + resp.statusCode, backend: 'native' };
        }
      }

      // 检测外部 CLI 是否存在
      function checkCli(name, cmd) {
        if (!execSync) { results[name + '_cli'] = { status: 'skip', reason: '无 execSync 上下文' }; return; }
        try {
          var IS_WIN = ctx.IS_WIN;
          var check = IS_WIN ? 'where ' + cmd : 'command -v ' + cmd;
          execSync(check, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
          results[name + '_cli'] = { status: 'ok', backend: cmd };
        } catch(e) {
          results[name + '_cli'] = { status: 'skip', reason: cmd + ' 未安装(可选)' };
        }
      }

      for (var i = 0; i < platforms.length; i++) {
        var p = platforms[i];
        if (p === 'web') {
          await checkHttp('web', 'https://r.jina.ai/https://example.com', { 'User-Agent': 'SkyalyticWing-agent-reach/1.0' });
        } else if (p === 'v2ex') {
          await checkHttp('v2ex', 'https://www.v2ex.com/api/topics/hot.json', { 'User-Agent': 'SkyalyticWing-agent-reach/1.0' });
        } else if (p === 'bilibili') {
          await checkHttp('bilibili', 'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=test&page=1', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
          checkCli('bili', 'bili');
        } else if (p === 'github') {
          await checkHttp('github', 'https://api.github.com/search/repositories?q=test&per_page=1', { 'User-Agent': 'SkyalyticWing-agent-reach/1.0', 'Accept': 'application/vnd.github+json' });
          checkCli('gh', 'gh');
        } else if (p === 'rss') {
          results['rss'] = { status: 'ok', reason: 'RSS解析器内置(无需外部API)' };
        } else if (p === 'exa') {
          var exaKey = (ctx.configStore && ctx.configStore.general && ctx.configStore.general.exaApiKey) || process.env.EXA_API_KEY || '';
          if (exaKey) {
            results['exa'] = { status: 'ok', reason: '已配置API Key', backend: 'exa-mcp' };
          } else {
            results['exa'] = { status: 'skip', reason: '未配置 exaApiKey (可选，见 SKILL.md)' };
          }
        }
      }
      // 外部 CLI 检测 (登录态平台)
      if (!args.platform) {
        ['twitter', 'opencli', 'rdt', 'yt-dlp', 'mcporter', 'agent-reach'].forEach(function(cmd) {
          checkCli(cmd, cmd);
        });
      }
      var okCount = Object.keys(results).filter(function(k){return results[k].status==='ok';}).length;
      var total = Object.keys(results).length;
      return { ok: true, platforms: results, summary: okCount + '/' + total + ' 可用', nativeNote: '零配置平台(web/v2ex/bilibili/github/rss)原生可用，登录态平台需外部CLI(见SKILL.md)' };
    }
  },

  // ═══ web_read ═════════════════════════════════════════════
  {
    name: 'web_read',
    description: '读取任意网页内容(转Markdown)。基于 Jina Reader (r.jina.ai)，无需配置。适合读取文章、文档、博客等。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的网页URL (含http://或https://)' },
        timeout: { type: 'number', description: '超时毫秒数，默认30000' }
      },
      required: ['url']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var targetUrl = args.url;
      if (!targetUrl) return { ok: false, error: '请提供 url 参数' };
      var jinaUrl = 'https://r.jina.ai/' + targetUrl;
      var ssrf = await _safeCheck(SecurityManager, jinaUrl);
      if (ssrf) return { ok: false, error: 'SSRF防护: ' + ssrf };
      var resp = await _httpGet(jinaUrl, { headers: { 'User-Agent': 'SkyalyticWing-agent-reach/1.0', 'Accept': 'text/plain' } }, args.timeout || 30000);
      if (resp.error) return { ok: false, error: '读取失败: ' + resp.error, url: targetUrl };
      if (resp.statusCode !== 200) return { ok: false, error: 'Jina Reader 返回 HTTP ' + resp.statusCode, url: targetUrl };
      var content = resp.body.substring(0, 100000);
      return { ok: true, url: targetUrl, content: content, length: resp.body.length, source: 'jina-reader' };
    }
  },

  // ═══ rss_read ═════════════════════════════════════════════
  {
    name: 'rss_read',
    description: '读取 RSS/Atom 订阅源，返回标题和条目列表。适合博客、新闻、播客等订阅源。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RSS/Atom feed URL' },
        limit: { type: 'number', description: '返回条目数量，默认10' },
        timeout: { type: 'number', description: '超时毫秒数，默认30000' }
      },
      required: ['url']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var feedUrl = args.url;
      if (!feedUrl) return { ok: false, error: '请提供 url 参数' };
      var ssrf = await _safeCheck(SecurityManager, feedUrl);
      if (ssrf) return { ok: false, error: 'SSRF防护: ' + ssrf };
      var resp = await _httpGet(feedUrl, { headers: { 'User-Agent': 'SkyalyticWing-agent-reach/1.0', 'Accept': 'application/xml,text/xml,application/rss+xml,application/atom+xml' } }, args.timeout || 30000);
      if (resp.error) return { ok: false, error: '读取失败: ' + resp.error, url: feedUrl };
      if (resp.statusCode !== 200) return { ok: false, error: 'HTTP ' + resp.statusCode, url: feedUrl };
      var parsed = _rssToJson(resp.body);
      if (parsed.error) return { ok: false, error: parsed.error, url: feedUrl };
      var limit = args.limit || 10;
      parsed.items = (parsed.items || []).slice(0, limit).map(function(item) {
        return {
          title: item.title || '',
          link: item.link || item.url || '',
          description: (item.description || item.summary || '').substring(0, 500),
          pubDate: item.pubDate || item.published || item.updated || ''
        };
      });
      parsed.url = feedUrl;
      parsed.ok = true;
      return parsed;
    }
  },

  // ═══ v2ex_hot ═════════════════════════════════════════════
  {
    name: 'v2ex_hot',
    description: '获取 V2EX 热门主题、节点主题、主题详情或回复。V2EX 公开 API，无需认证。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hot', 'node', 'topic', 'replies', 'member'], description: 'hot=热门主题; node=指定节点主题; topic=主题详情; replies=主题回复; member=用户信息' },
        node_name: { type: 'string', description: 'action=node 时的节点名(如 python/tech/jobs/qna)' },
        topic_id: { type: 'number', description: 'action=topic 或 replies 时的主题ID' },
        username: { type: 'string', description: 'action=member 时的用户名' },
        limit: { type: 'number', description: '返回条目数量，默认20' }
      },
      required: ['action']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var action = args.action;
      var apiUrl = '';
      if (action === 'hot') apiUrl = 'https://www.v2ex.com/api/topics/hot.json';
      else if (action === 'node') { if (!args.node_name) return { ok: false, error: 'action=node 需提供 node_name' }; apiUrl = 'https://www.v2ex.com/api/topics/show.json?node_name=' + encodeURIComponent(args.node_name) + '&page=1'; }
      else if (action === 'topic') { if (!args.topic_id) return { ok: false, error: 'action=topic 需提供 topic_id' }; apiUrl = 'https://www.v2ex.com/api/topics/show.json?id=' + args.topic_id; }
      else if (action === 'replies') { if (!args.topic_id) return { ok: false, error: 'action=replies 需提供 topic_id' }; apiUrl = 'https://www.v2ex.com/api/replies/show.json?topic_id=' + args.topic_id + '&page=1'; }
      else if (action === 'member') { if (!args.username) return { ok: false, error: 'action=member 需提供 username' }; apiUrl = 'https://www.v2ex.com/api/members/show.json?username=' + encodeURIComponent(args.username); }
      else return { ok: false, error: '未知 action: ' + action };

      var ssrf = await _safeCheck(SecurityManager, apiUrl);
      if (ssrf) return { ok: false, error: 'SSRF防护: ' + ssrf };
      var resp = await _httpGet(apiUrl, { headers: { 'User-Agent': 'SkyalyticWing-agent-reach/1.0' } }, 20000);
      if (resp.error) return { ok: false, error: '请求失败: ' + resp.error };
      if (resp.statusCode !== 200) return { ok: false, error: 'V2EX API 返回 HTTP ' + resp.statusCode };
      try {
        var data = JSON.parse(resp.body);
        var limit = args.limit || 20;
        if (Array.isArray(data)) {
          data = data.slice(0, limit).map(function(t) {
            return {
              id: t.id, title: t.title, node: t.node ? t.node.title : '', node_name: t.node_name,
              author: t.member ? t.member.username : '', replies: t.replies,
              created: t.created, last_modified: t.last_modified, url: 'https://www.v2ex.com/t/' + t.id
            };
          });
        }
        return { ok: true, action: action, count: Array.isArray(data) ? data.length : 1, data: data, source: 'v2ex-api' };
      } catch(e) { return { ok: false, error: '解析V2EX响应失败: ' + e.message }; }
    }
  },

  // ═══ bilibili_search ══════════════════════════════════════
  {
    name: 'bilibili_search',
    description: 'B站视频搜索(零登录API直连)。返回视频标题、UP主、播放量、BV号等。基于B站公开搜索API，自动获取cookie。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        page: { type: 'number', description: '页码，默认1' },
        limit: { type: 'number', description: '返回条目数量，默认10' }
      },
      required: ['keyword']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var keyword = args.keyword;
      if (!keyword) return { ok: false, error: '请提供 keyword 参数' };
      var page = args.page || 1;
      var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      // Step 1: 访问B站首页获取 cookie
      var ssrf1 = await _safeCheck(SecurityManager, 'https://www.bilibili.com/');
      if (ssrf1) return { ok: false, error: 'SSRF防护: ' + ssrf1 };
      var homeResp = await _httpGet('https://www.bilibili.com/', { headers: { 'User-Agent': UA } }, 15000);
      var cookies = '';
      if (homeResp.headers && homeResp.headers['set-cookie']) {
        var setCookies = Array.isArray(homeResp.headers['set-cookie']) ? homeResp.headers['set-cookie'] : [homeResp.headers['set-cookie']];
        cookies = setCookies.map(function(c) { return c.split(';')[0]; }).join('; ');
      }

      // Step 2: 调用搜索 API
      var searchUrl = 'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=' + encodeURIComponent(keyword) + '&page=' + page;
      var ssrf2 = await _safeCheck(SecurityManager, searchUrl);
      if (ssrf2) return { ok: false, error: 'SSRF防护: ' + ssrf2 };
      var searchResp = await _httpGet(searchUrl, { headers: { 'User-Agent': UA, 'Cookie': cookies, 'Referer': 'https://www.bilibili.com/' } }, 20000);
      if (searchResp.error) return { ok: false, error: '搜索失败: ' + searchResp.error };
      if (searchResp.statusCode !== 200) return { ok: false, error: 'B站API返回 HTTP ' + searchResp.statusCode };
      try {
        var data = JSON.parse(searchResp.body);
        if (data.code !== 0) return { ok: false, error: 'B站API错误 code=' + data.code + ': ' + (data.message || '') };
        var results = [];
        var resultObj = data.data && data.data.result;
        if (Array.isArray(resultObj)) {
          for (var ri = 0; ri < resultObj.length; ri++) {
            if (resultObj[ri].result_type === 'video' && Array.isArray(resultObj[ri].data)) {
              var videos = resultObj[ri].data;
              for (var vi = 0; vi < videos.length; vi++) {
                var v = videos[vi];
                results.push({
                  bvid: v.bvid,
                  aid: v.aid,
                  title: (v.title || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ''),
                  author: v.author,
                  play: v.play,
                  review: v.review,
                  video_review: v.video_review,
                  favorites: v.favorites,
                  duration: v.duration,
                  pubdate: v.pubdate,
                  tag: v.tag,
                  description: v.description,
                  url: 'https://www.bilibili.com/video/' + v.bvid
                });
              }
            }
          }
        }
        var limit = args.limit || 10;
        results = results.slice(0, limit);
        return { ok: true, keyword: keyword, page: page, count: results.length, videos: results, source: 'bilibili-api' };
      } catch(e) { return { ok: false, error: '解析B站响应失败: ' + e.message }; }
    }
  },

  // ═══ github_search ════════════════════════════════════════
  {
    name: 'github_search',
    description: 'GitHub 搜索：仓库/代码/Issue。基于 GitHub REST API，未认证每小时60次请求，配置 token 后5000次/小时。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['repos', 'code', 'issues'], description: '搜索类型：repos=仓库, code=代码, issues=Issue' },
        query: { type: 'string', description: '搜索查询 (支持 GitHub 搜索语法，如 "language:python stars:>100")' },
        sort: { type: 'string', description: '排序字段：repos 用 stars/forks/updated；code 用 indexed；issues 用 comments/created/updated' },
        order: { type: 'string', enum: ['desc', 'asc'], description: '排序方向，默认desc' },
        limit: { type: 'number', description: '返回条目数量，默认10(最大30)' }
      },
      required: ['type', 'query']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var configStore = ctx.configStore;
      var type = args.type;
      var query = args.query;
      if (!query) return { ok: false, error: '请提供 query 参数' };
      var limit = Math.min(args.limit || 10, 30);
      var sort = args.sort || (type === 'repos' ? 'stars' : (type === 'issues' ? 'created' : 'indexed'));
      var order = args.order || 'desc';
      var apiUrl = 'https://api.github.com/search/' + type + '?q=' + encodeURIComponent(query) + '&sort=' + sort + '&order=' + order + '&per_page=' + limit;

      var ssrf = await _safeCheck(SecurityManager, apiUrl);
      if (ssrf) return { ok: false, error: 'SSRF防护: ' + ssrf };

      var headers = {
        'User-Agent': 'SkyalyticWing-agent-reach/1.0',
        'Accept': 'application/vnd.github+json'
      };
      var token = (configStore && configStore.general && configStore.general.githubToken) || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var resp = await _httpGet(apiUrl, { headers: headers }, 20000);
      if (resp.error) return { ok: false, error: '请求失败: ' + resp.error };
      if (resp.statusCode === 403) return { ok: false, error: 'GitHub API 速率限制(未认证60次/小时)。请在配置中设置 githubToken 解锁5000次/小时。' };
      if (resp.statusCode !== 200) return { ok: false, error: 'GitHub API 返回 HTTP ' + resp.statusCode + ': ' + resp.body.substring(0, 500) };
      try {
        var data = JSON.parse(resp.body);
        var items = (data.items || []).slice(0, limit);
        var formatted = items.map(function(item) {
          if (type === 'repos') {
            return {
              full_name: item.full_name, description: item.description,
              url: item.html_url, stars: item.stargazers_count, forks: item.forks_count,
              language: item.language, updated: item.updated_at, license: item.license ? item.license.name : null
            };
          } else if (type === 'code') {
            return {
              name: item.name, path: item.path, repo: item.repository ? item.repository.full_name : '',
              url: item.html_url, score: item.score
            };
          } else { // issues
            return {
              title: item.title, number: item.number, state: item.state,
              repo: item.repository_url ? item.repository_url.replace('https://api.github.com/repos/', '') : '',
              url: item.html_url, created: item.created_at, comments: item.comments,
              author: item.user ? item.user.login : ''
            };
          }
        });
        return {
          ok: true, type: type, query: query, total_count: data.total_count,
          count: formatted.length, items: formatted, rateLimit: resp.headers['x-ratelimit-remaining'] || '?',
          source: 'github-api', authenticated: !!token
        };
      } catch(e) { return { ok: false, error: '解析GitHub响应失败: ' + e.message }; }
    }
  },

  // ═══ exa_search ═══════════════════════════════════════════
  {
    name: 'exa_search',
    description: 'Exa AI 搜索引擎，擅长英文内容、技术文档和代码搜索。需要 Exa API Key (配置 general.exaApiKey 或环境变量 EXA_API_KEY)。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        numResults: { type: 'number', description: '返回结果数量，默认5(最大10)' },
        type: { type: 'string', enum: ['auto', 'keyword', 'neural'], description: '搜索类型：auto/keyword/neural，默认auto' },
        includeContents: { type: 'boolean', description: '是否包含页面正文内容，默认false' }
      },
      required: ['query']
    },
    category: 'network',
    dangerous: false,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      var configStore = ctx.configStore;
      var query = args.query;
      if (!query) return { ok: false, error: '请提供 query 参数' };
      var exaKey = (configStore && configStore.general && configStore.general.exaApiKey) || process.env.EXA_API_KEY || '';
      if (!exaKey) return { ok: false, error: '未配置 Exa API Key。请在 设置→通用→exaApiKey 中配置，或设置 EXA_API_KEY 环境变量。获取免费Key: https://console.exa.ai' };

      var apiUrl = 'https://api.exa.ai/search';
      var body = {
        query: query,
        numResults: Math.min(args.numResults || 5, 10),
        type: args.type || 'auto',
        contents: args.includeContents ? { text: true } : undefined
      };
      var ssrf = await _safeCheck(SecurityManager, apiUrl);
      if (ssrf) return { ok: false, error: 'SSRF防护: ' + ssrf };
      var resp = await _httpPost(apiUrl, body, { headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' } }, 25000);
      if (resp.error) return { ok: false, error: '搜索失败: ' + resp.error };
      if (resp.statusCode !== 200) return { ok: false, error: 'Exa API 返回 HTTP ' + resp.statusCode + ': ' + resp.body.substring(0, 500) };
      try {
        var data = JSON.parse(resp.body);
        var results = (data.results || []).map(function(r) {
          return {
            title: r.title || '', url: r.url || '',
            publishedDate: r.publishedDate || '', author: r.author || '',
            score: r.score, text: r.text ? r.text.substring(0, 2000) : undefined
          };
        });
        return { ok: true, query: query, count: results.length, results: results, source: 'exa-api' };
      } catch(e) { return { ok: false, error: '解析Exa响应失败: ' + e.message }; }
    }
  }

];
