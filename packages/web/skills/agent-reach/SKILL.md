---
name: agent-reach
description: "🌐 互联网能力路由器 - 调研/搜索/查/找/读网页/社交媒体平台。15平台多后端路由，6个零配置平台原生可用(web_read/rss_read/v2ex_hot/bilibili_search/github_search/exa_search)"
emoji: "🌐"
---

# Agent Reach — 互联网能力路由器

15 平台互联网访问能力。**零配置平台已原生集成(无需安装Python)，登录态平台通过外部CLI调用。**

## 常驻规则

1. **动手前先体检**：多后端/登录态平台先调用 `agent_reach_doctor()` 检查可用后端。
2. **声明你在用什么**：开始干活前说一句「使用 agent-reach 的 X 平台 / Y 后端」。
3. **优先用原生工具**：零配置平台用原生工具(见下表)，登录态平台用 bash 调外部 CLI。
4. **失败按 references 重试链处理**，不要瞎猜命令。
5. **全网调研类任务**：组合多平台(Exa搜索 + Twitter/Reddit 看讨论 + 小红书/B站看中文场景)，并行收集再汇总。

## 路由表

| 用户意图 | 原生工具 | 详细文档 |
|---------|---------|---------|
| 网页阅读 | `web_read` | [references/web.md](references/web.md) |
| RSS订阅 | `rss_read` | [references/web.md](references/web.md) |
| 网页搜索(英文/技术) | `exa_search` | [references/search.md](references/search.md) |
| GitHub搜索 | `github_search` | [references/dev.md](references/dev.md) |
| V2EX热门/节点 | `v2ex_hot` | [references/social.md](references/social.md) |
| B站视频搜索 | `bilibili_search` | [references/video.md](references/video.md) |
| Twitter/小红书/Reddit/Facebook/Instagram | bash + 外部CLI | [references/social.md](references/social.md) |
| YouTube字幕 | bash + yt-dlp | [references/video.md](references/video.md) |
| LinkedIn | bash + mcporter | [references/career.md](references/career.md) |
| 小宇宙播客转录 | bash + transcribe.sh | [references/video.md](references/video.md) |

## 零配置原生工具 (无需任何安装)

### web_read — 通用网页阅读
```
web_read({ url: "https://example.com/article" })
```
基于 Jina Reader，返回 Markdown 格式正文。适合文章、文档、博客。

### rss_read — RSS/Atom 订阅
```
rss_read({ url: "https://blog.example.com/feed.xml", limit: 10 })
```
返回标题、链接、摘要、发布时间。

### v2ex_hot — V2EX 社区
```
v2ex_hot({ action: "hot", limit: 20 })              // 热门主题
v2ex_hot({ action: "node", node_name: "python" })   // 节点主题
v2ex_hot({ action: "topic", topic_id: 1234567 })    // 主题详情
v2ex_hot({ action: "replies", topic_id: 1234567 })  // 主题回复
v2ex_hot({ action: "member", username: "Livid" })   // 用户信息
```

### bilibili_search — B站视频搜索
```
bilibili_search({ keyword: "AI教程", limit: 10 })
```
零登录，返回标题/UP主/播放量/BV号/链接。自动获取cookie。

### github_search — GitHub 搜索
```
github_search({ type: "repos", query: "language:python stars:>1000", limit: 10 })
github_search({ type: "code", query: "useState react" })
github_search({ type: "issues", query: "label:bug repo:owner/repo" })
```
未认证60次/小时，配置 `general.githubToken` 后5000次/小时。

### exa_search — Exa AI 搜索
```
exa_search({ query: "how to use react hooks", numResults: 5 })
exa_search({ query: "code example", includeContents: true })
```
需配置 `general.exaApiKey` (免费: https://console.exa.ai)。

### agent_reach_doctor — 体检
```
agent_reach_doctor()                          // 全部检测
agent_reach_doctor({ platform: "bilibili" }) // 单平台检测
```

## 需登录态平台 (通过 bash 调外部 CLI)

这些平台需 cookies/登录态，先用 `agent_reach_doctor()` 检测外部 CLI 是否安装。

### 安装外部 CLI (可选)
```bash
# 安装 agent-reach (Python，可选，用于安装/体检上游工具)
pipx install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto

# 各平台 CLI
pipx install twitter-cli      # Twitter
pipx install bilibili-cli     # B站完整版(bili hot/rank/video)
# opencli 需 Chrome 扩展: https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
```

### Twitter/X
```bash
twitter search "query" -n 10
twitter feed -n 20
twitter user-posts @username -n 20
```

### 小红书 (桌面用 OpenCLI)
```bash
opencli xiaohongshu search "query" -f yaml
opencli xiaohongshu note "NOTE_URL" -f yaml
```

### Reddit (必须登录态)
```bash
opencli reddit search "query" -f yaml    # 桌面
rdt search "query" --limit 10            # 服务器
```

### Facebook / Instagram (桌面 OpenCLI)
```bash
opencli facebook search "query" -f yaml
opencli instagram user nasa -f yaml
```

### YouTube 字幕
```bash
yt-dlp --write-sub --skip-download -o "/tmp/%(id)s" "URL"
```

### 小宇宙播客转录
```bash
~/.agent-reach/tools/xiaoyuzhou/transcribe.sh "https://www.xiaoyuzhoufm.com/episode/xxx"
```

## 工作区规则

临时文件用 `/tmp/`(Windows 用 `%TEMP%`)，持久数据用 `~/.agent-reach/`。不要在 workspace 创建文件。

## 详细文档

- [搜索工具](references/search.md) — Exa AI 搜索
- [社交媒体](references/social.md) — 小红书/Twitter/B站/V2EX/Reddit/Facebook/Instagram
- [职场招聘](references/career.md) — LinkedIn
- [开发工具](references/dev.md) — GitHub CLI
- [网页阅读](references/web.md) — Jina Reader, RSS
- [视频播客](references/video.md) — YouTube, B站, 小宇宙
