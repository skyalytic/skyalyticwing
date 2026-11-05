---
name: coding-agent
description: "专业的代码编写、重构和调试技能。适用场景：(1) 编写新代码或功能, (2) 调试和修复bug, (3) 代码重构和优化, (4) 代码审查。不适用于：文档编写（使用documentation）, 数据分析（使用data-analyst）"
metadata:
  skyalyticwing:
    emoji: "🧩"
    requires: { bins: [] }
    tools: ["file_read", "file_write", "file_edit", "code_lint", "code_format", "code_test", "git_operation"]
---

# 编程代理技能 (Coding Agent Skill)

专业的代码编写、重构和调试技能。

## 适用场景

[OK] **使用此技能：**

- 编写新代码或功能实现
- 调试和修复 bug
- 代码重构和优化
- 代码审查和质量检查
- 编写单元测试
- 代码文档生成

[X] **不适用场景：**

- 文档编写 → 使用 documentation 技能
- 数据分析 → 使用 data-analyst 技能
- 系统运维 → 使用 ops-expert 技能

## Setup

```bash
# 安装推荐工具
npm install -g eslint prettier typescript

# 验证安装
eslint --version
prettier --version
tsc --version
```

## Common Commands

### 创建新文件

```bash
# 创建组件
file_write path="./src/components/Button.tsx" content="..."
```

### 编辑现有文件

```bash
# 搜索替换
file_edit path="./src/utils.ts" searchPattern="oldCode" replacement="newCode"
```

### 代码检查

```bash
# 运行 ESLint
code_lint path="./src"

# 格式化代码
code_format path="./src"
```

### 运行测试

```bash
# 运行测试
code_test path="./src" coverage=true
```

## Templates

### React 组件模板

```typescript
import React from 'react';

interface Props {
  title: string;
  onClick?: () => void;
}

export const Component: React.FC<Props> = ({ title, onClick }) => {
  return (
    <div className="component" onClick={onClick}>
      {title}
    </div>
  );
};
```

### API 路由模板

```typescript
import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const data = await service.getAll();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
```

## Notes

- 始终遵循项目现有的代码风格
- 在执行破坏性操作前会请求确认
- 支持增量编辑，避免重写整个文件
- 自动处理文件编码和换行符
