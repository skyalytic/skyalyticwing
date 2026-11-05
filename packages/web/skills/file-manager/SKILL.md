---
name: file-manager
description: "文件管理：查找、读取、编辑、发送文件"
emoji: "📁"
---

# File Manager Skill

## 何时使用
- 用户要求查找/发送某个文件
- 用户要求读取或编辑文件
- 用户要求整理文件

## 操作步骤

### 查找文件
1. 用 `directory_list(directory="路径")` 列出目录内容 — 一次看到全部！
2. 不要用多次 glob 尝试不同扩展名（浪费token）
3. 找到目标文件后直接操作

### 发送文件给用户
1. 找到文件路径
2. 用 `send_file_to_user(path="文件路径")` 发送
3. 通过当前渠道（飞书/微信/QQ等）自动发送

### 读取文件
1. 用 `file_read(path="文件路径")` 读取内容
2. 大文件用 `file_read(path="路径", offset=0, limit=100)` 分段读取

## 注意事项
- 发送前确认文件存在
- 不要发送敏感文件（如.env、密钥文件）
- 图片文件常见格式：png/jpg/jpeg/gif/webp/bmp
