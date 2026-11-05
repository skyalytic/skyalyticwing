---
name: obsidian
description: "💎 Obsidian知识库 - 操作Obsidian Vault中的笔记和链接"
emoji: 💎
---

# Obsidian Skill

操作 Obsidian 知识库，包括创建/编辑笔记、管理标签、构建双向链接和查询笔记图谱。

## 使用场景

- 创建和编辑Obsidian笔记
- 管理标签和分类
- 构建笔记间的双向链接
- 搜索和查询笔记内容
- 批量整理和重构知识库
- 生成MOC（内容地图）

## 操作步骤

1. **确定Vault路径**
   - 询问用户Vault位置，或使用默认路径
   - 验证 `.obsidian` 目录存在

2. **创建笔记**
   - 使用 `file_write` 在Vault目录创建 `.md` 文件
   - 添加 YAML frontmatter（tags, date, aliases等）
   - 使用 `[[双括号]]` 创建内部链接

3. **编辑笔记**
   - 使用 `file_read` 读取现有笔记
   - 使用 `apply_patch` 精确修改内容
   - 保持现有链接和格式

4. **搜索笔记**
   - 使用 `grep` 搜索内容
   - 使用 `glob` 查找特定文件
   - 使用 `directory_list` 浏览目录结构

5. **管理标签**
   - 搜索 `#标签` 模式
   - 批量重命名标签
   - 生成标签索引

## 笔记模板

```markdown
---
tags: [{{TAGS}}]
date: {{DATE}}
aliases: [{{ALIASES}}]
---

# {{TITLE}}

## 概述
{{SUMMARY}}

## 内容
{{CONTENT}}

## 相关链接
- [[{{RELATED_NOTE_1}}]]
- [[{{RELATED_NOTE_2}}]]
```

## 示例

```
用户: 在Obsidian中创建一个关于机器学习的笔记
步骤1: file_write({ path: "vault/ML/机器学习.md", content: "笔记内容..." })

用户: 搜索Obsidian中所有包含"设计模式"的笔记
步骤1: grep({ pattern: "设计模式", path: "vault/", glob: "*.md" })

用户: 给这个笔记添加标签
步骤1: file_read({ path: "vault/note.md" })
步骤2: apply_patch 修改frontmatter中的tags
```
