---
name: code-review
description: "代码审查技能：代码质量检查、最佳实践建议、安全漏洞扫描。使用场景：(1) PR代码审查 (2) 代码质量评估 (3) 安全审计。不适用于：代码生成、文档编写。"
metadata:
  skyalyticwing:
    emoji: "🔍"
    requires:
      bins: ["git"]
    agent_type: "code_expert"
---

# Code Review Skill

代码审查技能，提供专业的代码质量检查和建议。

## When to Use

[OK] **USE this skill when:**

- 审查 Pull Request
- 代码质量评估
- 安全漏洞扫描
- 最佳实践检查
- 性能问题定位

## When NOT to Use

[X] **DON'T use this skill when:**

- 代码生成 → 使用 `coding-agent` 技能
- 文档编写 → 使用 `documentation` 技能

## Review Checklist

### 代码质量

- [ ] 代码是否清晰易读
- [ ] 命名是否有意义
- [ ] 是否有重复代码
- [ ] 函数是否过长
- [ ] 是否有足够的注释

### 安全检查

- [ ] 是否有 SQL 注入风险
- [ ] 是否有 XSS 风险
- [ ] 敏感数据是否加密
- [ ] 权限检查是否完整

### 性能检查

- [ ] 是否有 N+1 查询
- [ ] 是否有内存泄漏风险
- [ ] 是否有不必要的循环

## Templates

### 审查报告模板

```markdown
## Code Review Report

**File**: path/to/file.ts
**Reviewer**: AI Agent
**Date**: YYYY-MM-DD

### Summary
简要描述代码变更

### Issues Found

#### Critical
- [描述严重问题]

#### Warning
- [描述警告]

#### Suggestion
- [描述改进建议]

### Positive Notes
- [值得肯定的地方]
```

## Notes

- 保持客观和建设性
- 提供具体的改进建议
- 考虑项目上下文
