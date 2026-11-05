---
name: update-config
description: "⚙️ 配置管理 - 查看、修改和管理系统配置"
emoji: ⚙️
---

# Update Config Skill

管理 SkyalyticWing 系统配置，包括模型设置、权限、环境变量和工作区配置。

## 使用场景

- 查看当前系统配置
- 修改模型和API设置
- 管理权限规则
- 配置环境变量
- 调整系统参数

## 操作步骤

1. **查看配置**
   读取配置文件：
   ```
   file_read({ path: "config.json" })
   ```

2. **修改配置**
   使用 `apply_patch` 精确修改：
   ```
   apply_patch({ path: "config.json", patches: [{ search: "旧值", replace: "新值" }] })
   ```

3. **管理权限规则**
   使用 `tool_policy_create` 和权限API：
   ```
   tool_policy_create({ name: "安全策略", allow: ["file_read", "web_search"], deny: ["bash"] })
   ```

4. **环境变量**
   ```bash
   # 查看
   echo $VARIABLE_NAME
   # 设置（当前会话）
   export VARIABLE_NAME=value
   ```

5. **重置配置**
   恢复默认配置值

## 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| defaultModel | 默认AI模型 | gpt-4o-mini |
| contextWindow | 上下文窗口大小 | 128000 |
| compactThreshold | 压缩阈值 | 0.85 |
| maxToolCalls | 最大工具调用次数 | 50 |
| approvalMode | 审批模式 | auto |

## 示例

```
用户: 查看当前配置
执行: file_read({ path: "config.json" })

用户: 修改默认模型为claude-3-5-sonnet
执行: apply_patch({ path: "config.json", patches: [...] })

用户: 创建一个安全策略
执行: tool_policy_create({ name: "安全策略", allow: [...], deny: [...] })
```
