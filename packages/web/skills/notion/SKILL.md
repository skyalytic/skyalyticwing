---
name: notion
description: "📝 Notion笔记 - 操作Notion页面、数据库和知识库"
emoji: 📝
requires: { env: ["NOTION_API_KEY"], bins: [] }
install: "npm install @notionhq/client"
---

# Notion Skill

通过 Notion API 操作笔记和知识库，包括创建/搜索/更新页面、数据库查询、列表管理和内容提取。

## 使用场景

- 创建和编辑 Notion 页面
- 搜索页面和数据库内容
- 查询和筛选数据库记录
- 管理待办事项和列表
- 提取页面内容用于分析

## 前置要求

- 需要配置 `NOTION_API_KEY` 环境变量
- 在 Notion Integrations 页面创建集成并获取 API Key
- 将集成添加到目标工作区和页面
- 安装 `@notionhq/client` npm 包

## 命令

### notion_search

搜索 Notion 工作区中的页面和数据库。

- `query` (必填): 搜索关键词
- `filter` (可选): 过滤条件，如 `{ property: "object", value: "page" }`
- `sort` (可选): 排序方式
- `limit` (可选): 返回结果数量，默认 10

### notion_create_page

创建新的 Notion 页面。

- `parent_id` (必填): 父页面或数据库 ID
- `parent_type` (必填): 父级类型，"page" 或 "database"
- `title` (必填): 页面标题
- `properties` (可选): 数据库页面属性（当 parent_type 为 database 时）
- `children` (可选): 页面内容块数组

### notion_update_page

更新现有 Notion 页面。

- `page_id` (必填): 页面 ID
- `properties` (可选): 要更新的属性
- `archived` (可选): 是否归档页面

### notion_query_database

查询 Notion 数据库。

- `database_id` (必填): 数据库 ID
- `filter` (可选): 筛选条件
- `sorts` (可选): 排序条件
- `limit` (可选): 返回结果数量，默认 100

### notion_get_page

获取页面详细内容和属性。

- `page_id` (必填): 页面 ID
- `include_children` (可选): 是否包含子块内容，默认 true

## 示例

```
用户: 搜索Notion中关于"项目计划"的页面
执行: notion_search({ query: "项目计划" })

用户: 在数据库中创建一条新记录
执行: notion_create_page({ parent_id: "db_xxx", parent_type: "database", title: "新任务", properties: { "状态": "待办", "优先级": "高" } })

用户: 查询数据库中所有高优先级任务
执行: notion_query_database({ database_id: "db_xxx", filter: { property: "优先级", select: { equals: "高" } } })

用户: 获取某个页面的内容
执行: notion_get_page({ page_id: "page_xxx" })

用户: 更新页面标题
执行: notion_update_page({ page_id: "page_xxx", properties: { "标题": { title: [{ text: { content: "新标题" } }] } } })
```

## 注意事项

- Notion API 有速率限制（3 请求/秒），批量操作时注意控制频率
- 集成只能访问被明确授权的页面和数据库
- 页面内容以块（Block）结构返回，需要递归获取子块
- 创建页面时 children 块数量上限为 100
