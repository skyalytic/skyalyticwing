# 职场招聘

LinkedIn。

## LinkedIn (linkedin-scraper-mcp，需登录)

```bash
# 获取个人资料
mcporter call 'linkedin-scraper.get_person_profile(linkedin_url: "https://linkedin.com/in/username")'

# 搜索人才
mcporter call 'linkedin-scraper.search_people(keyword: "AI engineer", limit: 10)'

# 获取公司资料
mcporter call 'linkedin-scraper.get_company_profile(linkedin_url: "https://linkedin.com/company/xxx")'

# 搜索职位
mcporter call 'linkedin-scraper.search_jobs(keyword: "software engineer", limit: 10)'
```

> **需要登录**: LinkedIn scraper 需要有效的登录态。
> 安装: `pip install linkedin-scraper-mcp`，然后 `linkedin-scraper-mcp --login --no-headless`

## Fallback 方案

如果 MCP 不可用，可以用原生工具读公开页面：

```
web_read({ url: "https://linkedin.com/in/username" })
```

> Jina Reader 能读取 LinkedIn 公开页面，但完整功能(职位搜索等)需要 linkedin-scraper-mcp。
