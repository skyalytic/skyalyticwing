---
name: trello
description: "📋 Trello看板 - 管理看板、卡片和列表"
emoji: 📋
requires: { env: ["TRELLO_API_KEY", "TRELLO_TOKEN"] }
install: "https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/"
---

# Trello Skill

通过 Trello REST API 管理看板、卡片和列表，包括创建卡片、移动卡片、列出看板和管理列表。

## 使用场景

- 查看和管理 Trello 看板
- 创建和编辑卡片
- 在列表间移动卡片
- 添加评论和附件
- 跟踪项目进度

## 前置要求

- 需要配置 `TRELLO_API_KEY` 和 `TRELLO_TOKEN` 环境变量
- 在 https://trello.com/app-key 获取 API Key
- 使用 API Key 生成 Token（需授权读写权限）
- Token 需要有目标看板的访问权限

## 命令

### trello_list_boards

列出所有可访问的看板。

- `filter` (可选): 筛选条件，"all"、"open"（默认）、"closed"
- `fields` (可选): 返回字段，如 "name,url,id"

### trello_get_board

获取看板详情，包括列表和卡片。

- `board_id` (必填): 看板 ID
- `include_cards` (可选): 是否包含卡片，默认 true
- `include_lists` (可选): 是否包含列表，默认 true

### trello_create_card

创建新的 Trello 卡片。

- `list_id` (必填): 目标列表 ID
- `name` (必填): 卡片标题
- `desc` (可选): 卡片描述
- `due` (可选): 截止日期，格式 "YYYY-MM-DD"
- `labels` (可选): 标签 ID 列表
- `position` (可选): 位置，"top"、"bottom" 或序号
- `members` (可选): 成员 ID 列表

### trello_move_card

移动卡片到其他列表。

- `card_id` (必填): 卡片 ID
- `target_list_id` (必填): 目标列表 ID
- `position` (可选): 在目标列表中的位置，"top"、"bottom" 或序号

### trello_add_comment

给卡片添加评论。

- `card_id` (必填): 卡片 ID
- `text` (必填): 评论内容

## 示例

```
用户: 列出我的Trello看板
执行: trello_list_boards()

用户: 查看"项目开发"看板的详情
执行: trello_get_board({ board_id: "board_xxx" })

用户: 在"待办"列表中创建一个新卡片
执行: trello_create_card({ list_id: "list_xxx", name: "修复登录Bug", desc: "用户无法使用邮箱登录", due: "2024-03-20" })

用户: 把卡片移动到"进行中"列表
执行: trello_move_card({ card_id: "card_xxx", target_list_id: "list_yyy" })

用户: 给卡片添加评论
执行: trello_add_comment({ card_id: "card_xxx", text: "已开始排查，预计明天完成" })
```

## 注意事项

- API 请求速率限制为 100 次/10秒
- Token 权限决定了可操作的看板范围
- 删除操作不可逆，执行前需用户确认
- 卡片描述支持 Markdown 格式
- 截止日期使用 UTC 时区
