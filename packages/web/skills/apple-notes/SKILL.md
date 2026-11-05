---
name: apple-notes
description: "🍎 Apple Notes - macOS笔记操作（创建、搜索、管理）"
emoji: 🍎
requires: { bins: ["osascript"], platform: "darwin" }
---

# Apple Notes Skill

通过 AppleScript（osascript）操作 macOS 原生备忘录应用，包括创建笔记、搜索笔记、列出文件夹和获取笔记内容。

## 使用场景

- 快速创建 Apple Notes 笔记
- 搜索现有笔记内容
- 浏览和管理笔记文件夹
- 提取笔记内容用于其他用途
- 将信息保存到 Apple Notes

## 前置要求

- 仅支持 macOS 系统
- 需要系统自带 `osascript` 命令行工具
- 首次使用时系统会请求自动化权限，需用户授权
- 确保"备忘录"应用已登录 iCloud（如需同步）

## 命令

### notes_create

创建新的 Apple Notes 笔记。

- `title` (必填): 笔记标题
- `body` (必填): 笔记内容（支持 HTML 格式）
- `folder` (可选): 目标文件夹名称，默认为根目录
- `attachments` (可选): 附件文件路径列表

### notes_search

搜索 Apple Notes 中的笔记。

- `query` (必填): 搜索关键词
- `folder` (可选): 限定搜索的文件夹
- `limit` (可选): 返回结果数量，默认 20

### notes_list_folders

列出所有笔记文件夹。

- 无参数

### notes_get

获取指定笔记的完整内容。

- `name` (必填): 笔记名称
- `folder` (可选): 笔记所在文件夹
- `format` (可选): 输出格式，"html"（默认）或 "text"

## 示例

```
用户: 创建一个会议记录笔记
执行: notes_create({ title: "2024年Q1会议记录", body: "<h1>会议要点</h1><ul><li>项目进展</li><li>下步计划</li></ul>" })

用户: 搜索包含"旅行计划"的笔记
执行: notes_search({ query: "旅行计划" })

用户: 列出所有笔记文件夹
执行: notes_list_folders()

用户: 获取"读书笔记"文件夹中"2024书单"的内容
执行: notes_get({ name: "2024书单", folder: "读书笔记" })

用户: 在"工作"文件夹中创建笔记
执行: notes_create({ title: "周报", body: "本周工作总结...", folder: "工作" })
```

## 注意事项

- 仅在 macOS 上可用，其他系统无法使用
- AppleScript 操作需要用户授权自动化权限
- 笔记内容支持 HTML 格式，但部分样式可能不被支持
- 大量笔记时搜索可能较慢
- 删除操作不可逆，执行前需用户确认
