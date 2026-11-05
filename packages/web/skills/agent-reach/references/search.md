# 搜索工具

Exa AI 搜索引擎。

## Exa AI 搜索 (原生工具)

高质量 AI 搜索引擎，擅长技术和代码搜索。

```
exa_search({ query: "query", numResults: 5 })
exa_search({ query: "code question", includeContents: true })
```

### 使用场景

| 场景 | 参数 |
|-----|------|
| 网页搜索 | `exa_search({ query: "...", numResults: 5 })` |
| 含正文搜索 | `exa_search({ query: "...", includeContents: true })` |

### 特点

- 擅长英文内容和技术文档
- 支持代码上下文搜索
- 结果质量高
- 需配置 `general.exaApiKey` (免费: https://console.exa.ai)

## 与其他搜索工具对比

| 工具 | 来源 | 适用场景 |
|-----|------|---------|
| Exa | agent-reach 原生 | 英文/技术/代码搜索 |
| GitHub 搜索 | agent-reach 原生 (github_search) | 仓库/代码搜索 |
| web_read | agent-reach 原生 | 读取已知URL网页内容 |
