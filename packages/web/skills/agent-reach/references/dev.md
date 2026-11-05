# 开发工具

GitHub CLI + 原生搜索。

## GitHub 搜索 (原生工具)

```
github_search({ type: "repos", query: "language:python stars:>1000", limit: 10 })
github_search({ type: "code", query: "useState react", limit: 10 })
github_search({ type: "issues", query: "label:bug repo:owner/repo", limit: 10 })
```

支持 GitHub 搜索语法。未认证60次/小时，配置 `general.githubToken` 后5000次/小时。

## GitHub CLI (gh，完整操作)

认证、仓库、Issue、PR、Actions 等：

```bash
gh auth login
gh auth status

# 仓库
gh repo view owner/repo
gh repo clone owner/repo

# Issues
gh issue list -R owner/repo --state open
gh issue view 123 -R owner/repo

# Pull Requests
gh pr list -R owner/repo --state open
gh pr view 123 -R owner/repo

# Actions / CI
gh run list --repo owner/repo --limit 10
gh workflow list --repo owner/repo

# Releases
gh release list -R owner/repo

# API
gh api /user
gh api repos/owner/repo
```

## 选择指南

| 场景 | 推荐工具 |
|-----|---------|
| 搜索仓库/代码/Issue | `github_search` (原生) |
| 完整 Git 操作 | `gh` CLI (bash) |
| 读仓库内容 | `web_read` (Jina Reader) |
