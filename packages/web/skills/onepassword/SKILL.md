---
name: onepassword
description: "🔐 1Password - 密码管理器搜索和项目管理"
emoji: 🔐
requires: { bins: ["op"] }
install: "https://developer.1password.com/docs/cli/get-started/"
---

# 1Password Skill

通过 1Password CLI（op）操作密码管理器，包括搜索密码、获取项目详情、列出保管库和创建项目。

## 使用场景

- 搜索存储在 1Password 中的密码和凭证
- 获取登录信息、安全笔记等条目详情
- 列出和管理保管库
- 创建新的密码条目
- 在脚本中安全引用密码

## 前置要求

- 需要安装 1Password CLI（`op`）
- 首次使用需执行 `op account add` 登录账户
- 需要执行 `op signin` 进行身份验证
- 建议启用生物识别解锁以简化操作

## 命令

### op_search

搜索 1Password 中的条目。

- `query` (必填): 搜索关键词
- `vault` (可选): 限定搜索的保管库名称
- `categories` (可选): 条目类别过滤，如 "login"、"password"、"note"

### op_get_item

获取条目详细信息。

- `item` (必填): 条目名称或 ID
- `vault` (可选): 保管库名称
- `fields` (可选): 指定获取的字段，如 "username,password"
- `format` (可选): 输出格式，"json"（默认）或 "csv"

### op_list_vaults

列出所有可访问的保管库。

- 无参数

### op_create_item

创建新的 1Password 条目。

- `category` (必填): 条目类别，如 "login"、"password"、"note"
- `title` (必填): 条目标题
- `vault` (可选): 目标保管库
- `fields` (可选): 自定义字段 JSON
- `tags` (可选): 标签列表
- `generate_password` (可选): 是否自动生成密码，默认 false

## 示例

```
用户: 搜索GitHub的登录信息
执行: op_search({ query: "GitHub" })

用户: 获取某个条目的用户名和密码
执行: op_get_item({ item: "GitHub", fields: "username,password" })

用户: 列出所有保管库
执行: op_list_vaults()

用户: 创建一个新的登录条目
执行: op_create_item({ category: "login", title: "新网站登录", generate_password: true })

用户: 在指定保管库中创建安全笔记
执行: op_create_item({ category: "note", title: "服务器密钥", vault: "工作" })
```

## 注意事项

- 永远不要在日志或输出中完整显示密码
- 使用 `op read` 引用密码而非直接读取值
- 会话超时后需重新执行 `op signin`
- 敏感操作（删除、移动）需用户确认
