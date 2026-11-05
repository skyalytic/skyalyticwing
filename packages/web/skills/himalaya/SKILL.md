---
name: himalaya
description: "📧 邮件客户端 - 通过himalaya CLI收发和管理邮件"
emoji: 📧
requires: { bins: ["himalaya"] }
install: "https://github.com/pimalaya/himalaya#installation"
---

# Himalaya Skill

通过 himalaya CLI（Rust 邮件客户端）操作邮箱，包括发送邮件、读取邮件、列出邮箱、搜索邮件和管理文件夹。

## 使用场景

- 发送和回复邮件
- 查看收件箱和文件夹中的邮件
- 搜索特定邮件
- 管理邮件文件夹
- 批量处理邮件（移动、删除）

## 前置要求

- 需要安装 himalaya CLI（`himalaya`）
- 需要配置邮箱账户（IMAP/SMTP）
- 配置文件位于 `~/.config/himalaya/config.toml`
- 首次使用需执行 `himalaya account add` 配置邮箱

## 命令

### email_send

发送邮件。

- `to` (必填): 收件人地址，多个用逗号分隔
- `subject` (必填): 邮件主题
- `body` (必填): 邮件正文
- `cc` (可选): 抄送地址
- `bcc` (可选): 密送地址
- `attachments` (可选): 附件文件路径列表
- `reply_to` (可选): 回复的邮件 ID

### email_list

列出邮箱中的邮件。

- `folder` (可选): 文件夹名称，默认 "INBOX"
- `limit` (可选): 返回数量，默认 20
- `page` (可选): 页码，默认 1
- `sort` (可选): 排序方式，"newest"（默认）或 "oldest"

### email_read

读取邮件详细内容。

- `id` (必填): 邮件 ID
- `folder` (可选): 文件夹名称，默认 "INBOX"
- `format` (可选): 输出格式，"text"（默认）或 "html"或 "json"
- `include_attachments` (可选): 是否下载附件，默认 false

### email_search

搜索邮件。

- `query` (必填): 搜索关键词（支持 IMAP 搜索语法）
- `folder` (可选): 搜索的文件夹，默认 "INBOX"
- `limit` (可选): 返回数量，默认 20
- `from` (可选): 发件人筛选
- `since` (可选): 起始日期，如 "2024-01-01"
- `before` (可选): 截止日期

### email_delete

删除邮件。

- `id` (必填): 邮件 ID
- `folder` (可选): 文件夹名称，默认 "INBOX"

### email_move

移动邮件到其他文件夹。

- `id` (必填): 邮件 ID
- `source_folder` (必填): 源文件夹
- `target_folder` (必填): 目标文件夹

## 示例

```
用户: 发送邮件给zhang@example.com
执行: email_send({ to: "zhang@example.com", subject: "会议通知", body: "明天下午2点开会" })

用户: 查看收件箱
执行: email_list({ folder: "INBOX", limit: 10 })

用户: 读取某封邮件
执行: email_read({ id: "123" })

用户: 搜索来自boss@example.com的邮件
执行: email_search({ from: "boss@example.com", query: "报告" })

用户: 删除垃圾邮件
执行: email_delete({ id: "456" })

用户: 把邮件移动到归档文件夹
执行: email_move({ id: "123", source_folder: "INBOX", target_folder: "Archive" })
```

## 注意事项

- 发送邮件前确认收件人和内容，避免误发
- 删除操作不可逆，建议先移动到垃圾箱而非直接删除
- 大附件可能导致操作超时
- 密码等敏感信息不要出现在邮件正文中
- IMAP 搜索语法因服务器不同可能有差异
