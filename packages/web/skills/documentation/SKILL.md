---
name: documentation
description: "自动生成项目文档、API文档和代码注释。适用场景：(1) 需要生成README文档, (2) 需要生成API文档, (3) 需要添加代码注释。不适用于：代码编写（使用coding-agent）, 数据分析（使用data-analyst）"
metadata:
  skyalyticwing:
    emoji: "📝"
    requires: { bins: [] }
    tools: ["file_read", "file_write", "glob", "grep"]
---

# 文档生成技能 (Documentation Skill)

自动生成项目文档、API文档和代码注释。

## 适用场景

[OK] **使用此技能：**

- 生成 README.md 文档
- 生成 API 文档
- 添加代码注释
- 生成变更日志
- 编写用户指南

[X] **不适用场景：**

- 编写代码 → 使用 coding-agent
- 数据分析 → 使用 data-analyst
- 系统运维 → 使用 ops-expert

## Setup

无需额外安装，使用内置工具。

## Common Commands

### 生成 README

```bash
# 分析项目并生成 README
glob pattern="**/*.ts"
file_read path="./package.json"
file_write path="./README.md" content="..."
```

### 生成 API 文档

```bash
# 提取 API 路由
grep pattern="router\.(get|post|put|delete)" path="./src"

# 生成文档
file_write path="./docs/API.md" content="..."
```

## Templates

### README 模板

```markdown
# 项目名称

简短描述

## 安装

\`\`\`bash
npm install project-name
\`\`\`

## 使用

\`\`\`typescript
import { main } from 'project-name';

main();
\`\`\`

## API

### main()

主函数描述

## 许可证

MIT
```

## Notes

- 文档应保持与代码同步
- 使用清晰简洁的语言
- 提供必要的示例
