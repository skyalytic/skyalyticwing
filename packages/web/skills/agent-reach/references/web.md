# 网页阅读

通用网页、RSS。

## 通用网页 (Jina Reader - 原生工具)

```
# 读取任意网页内容 (Markdown 格式)
web_read({ url: "https://example.com/article" })
```

**适用场景**: 大多数网页可以直接用 Jina Reader 读取，无需配置。

## RSS/Atom 订阅 (原生工具)

```
# 读取 RSS/Atom feed
rss_read({ url: "https://blog.example.com/feed.xml", limit: 10 })
```

返回标题、链接、摘要、发布时间。支持 RSS 2.0 和 Atom 格式。

**适用场景**: 订阅博客、新闻源、播客等 RSS feed。

## 选择指南

| 场景 | 推荐工具 |
|-----|---------|
| 通用网页 | `web_read` (Jina Reader) |
| RSS 订阅 | `rss_read` |
| 英文/技术搜索 | `exa_search` (需Key) |
