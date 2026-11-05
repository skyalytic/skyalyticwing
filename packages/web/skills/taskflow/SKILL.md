---
name: taskflow
description: "🪝 任务流程 - 多步骤任务的持久化流程管理和编排"
emoji: 🪝
---

# TaskFlow Skill

多步骤任务的持久化流程基础设施，支持任务定义、状态追踪、条件分支和错误恢复。

## 使用场景

- 定义和执行多步骤工作流
- 任务状态持久化和恢复
- 条件分支和并行执行
- 错误处理和重试
- 收件箱分流

## 操作步骤

1. **定义任务流程**
   创建任务流程描述文件：
   ```json
   {
     "name": "部署流程",
     "steps": [
       { "id": "test", "action": "bash", "params": { "command": "npm test" }, "next": "build" },
       { "id": "build", "action": "bash", "params": { "command": "npm run build" }, "next": "deploy" },
       { "id": "deploy", "action": "bash", "params": { "command": "npm run deploy" }, "next": null }
     ],
     "onError": "notify"
   }
   ```

2. **执行流程**
   使用 `subagent_execute` 或顺序执行每个步骤

3. **状态追踪**
   将流程状态保存到工作区文件：
   ```
   file_write({ path: "workspace/.taskflow/status.json", content: "..." })
   ```

4. **错误恢复**
   从上次失败步骤继续执行

5. **收件箱分流**
   根据消息类型自动路由到不同的处理流程

## 示例

```
用户: 创建一个部署流程
步骤1: 定义流程步骤
步骤2: 保存流程定义到文件
步骤3: 执行流程

用户: 恢复上次中断的任务
步骤1: 读取任务状态文件
步骤2: 从失败步骤继续执行
```
