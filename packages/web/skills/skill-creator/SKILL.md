---
name: skill-creator
description: "🛠️ 技能创建器 - 创建、编辑、改进和审计Agent技能"
emoji: 🛠️
---

# Skill Creator Skill

创建、编辑、改进和审计 SkyalyticWing Agent 技能。此技能帮助用户快速生成符合规范的 SKILL.md 文件。

## 使用场景

- 创建全新的技能
- 改进现有技能的描述和步骤
- 审计技能的质量和完整性
- 将常用操作流程封装为可复用技能

## 技能文件规范

每个技能必须包含一个 `SKILL.md` 文件，位于 `skills/<技能名>/SKILL.md`，格式如下：

```markdown
---
name: 技能名称
description: "技能描述 - 简短说明技能功能"
emoji: 📌
---

# 技能标题

详细描述技能的功能和使用方法。

## 使用场景
- 场景1
- 场景2

## 操作步骤
1. 步骤1
2. 步骤2

## 示例
具体使用示例
```

## 操作步骤

1. 了解用户想要创建的技能功能
2. 确定技能名称、描述和适用场景
3. 编写操作步骤，确保清晰可执行
4. 添加使用示例
5. 使用 `skill_create` 工具创建技能文件
6. 验证技能是否正确加载（通过 `skill_list` 查看）

## 示例

```
用户: 创建一个发送邮件的技能
执行: skill_create({
  name: "email-sender",
  description: "📧 发送邮件 - 通过SMTP发送电子邮件",
  content: "完整的SKILL.md内容..."
})
```

## 审计清单

- [ ] YAML frontmatter 包含 name, description, emoji
- [ ] 描述简洁明确（不超过50字）
- [ ] 使用场景覆盖主要需求
- [ ] 操作步骤清晰可执行
- [ ] 包含具体示例
- [ ] 技能名称使用小写字母和连字符
