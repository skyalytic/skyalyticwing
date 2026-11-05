---
name: apple-reminders
description: "☑️ Apple Reminders - macOS提醒事项管理"
emoji: ☑️
requires: { bins: ["osascript"], platform: "darwin" }
---

# Apple Reminders Skill

通过 AppleScript（osascript）操作 macOS 原生提醒事项应用，包括创建提醒、列出提醒、完成提醒和列出列表。

## 使用场景

- 快速创建提醒事项
- 查看待办任务列表
- 标记任务完成
- 管理提醒事项列表
- 设置带截止日期的提醒

## 前置要求

- 仅支持 macOS 系统
- 需要系统自带 `osascript` 命令行工具
- 首次使用时系统会请求自动化权限，需用户授权
- 确保"提醒事项"应用已登录 iCloud（如需同步）

## 命令

### reminders_create

创建新的提醒事项。

- `name` (必填): 提醒事项名称
- `list` (可选): 目标列表名称，默认为默认列表
- `due_date` (可选): 截止日期，格式 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"
- `note` (可选): 备注内容
- `priority` (可选): 优先级，0-9（0=无，1=低，5=中，9=高）

### reminders_list

列出提醒事项。

- `list` (可选): 指定列表名称
- `completed` (可选): 是否显示已完成项，默认 false
- `due_before` (可选): 截止日期筛选，如 "today"、"tomorrow"、"YYYY-MM-DD"
- `limit` (可选): 返回结果数量，默认 50

### reminders_complete

标记提醒事项为已完成。

- `name` (必填): 提醒事项名称
- `list` (可选): 所在列表名称
- `id` (可选): 提醒事项 ID（优先于名称）

### reminders_list_lists

列出所有提醒事项列表。

- 无参数

## 示例

```
用户: 提醒我明天下午3点开会
执行: reminders_create({ name: "开会", due_date: "2024-03-15 15:00", priority: 5 })

用户: 列出今天的待办事项
执行: reminders_list({ due_before: "today" })

用户: 完成"买牛奶"这个提醒
执行: reminders_complete({ name: "买牛奶" })

用户: 列出所有提醒事项列表
执行: reminders_list_lists()

用户: 在"工作"列表中创建高优先级提醒
执行: reminders_create({ name: "提交季度报告", list: "工作", due_date: "2024-03-30", priority: 9 })

用户: 查看已完成的事项
执行: reminders_list({ completed: true })
```

## 注意事项

- 仅在 macOS 上可用，其他系统无法使用
- AppleScript 操作需要用户授权自动化权限
- 提醒事项名称不唯一时，完成操作可能匹配错误项，建议使用 ID
- 日期格式需严格遵循规范
- 删除操作不可逆，执行前需用户确认
