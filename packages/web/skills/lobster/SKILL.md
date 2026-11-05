---
name: lobster
description: "🦞 工作流编排 - 带审批检查点的多步骤工作流"
emoji: 🦞
---

# Lobster Skill

带审批检查点的多步骤工作流编排，确保关键操作获得确认后再执行。

## 使用场景

- 需要人工审批的部署流程
- 多阶段数据处理管道
- 带确认的批量操作
- 安全敏感的操作流程

## 操作步骤

1. **定义工作流**
   ```json
   {
     "name": "安全部署流程",
     "steps": [
       { "id": "1", "name": "运行测试", "action": "bash", "params": {"command": "npm test"}, "requiresApproval": false },
       { "id": "2", "name": "构建项目", "action": "bash", "params": {"command": "npm run build"}, "requiresApproval": false },
       { "id": "3", "name": "部署到生产", "action": "bash", "params": {"command": "npm run deploy:prod"}, "requiresApproval": true, "approvalMessage": "确认部署到生产环境？" }
     ]
   }
   ```

2. **执行工作流**
   - 自动执行不需要审批的步骤
   - 在审批检查点暂停
   - 使用 `ask_user` 工具请求确认
   - 根据确认结果继续或中止

3. **错误处理**
   - 任何步骤失败时暂停
   - 提供错误信息和恢复选项
   - 支持从失败步骤重试

4. **状态追踪**
   - 记录每个步骤的执行状态
   - 保存工作流进度到文件
   - 支持从断点恢复

## 示例

```
用户: 执行安全部署流程
步骤1: 运行测试（自动）
步骤2: 构建项目（自动）
步骤3: 请求部署审批（ask_user）
步骤4: 根据确认结果部署或中止

用户: 从上次中断的地方继续
步骤1: 读取工作流状态
步骤2: 从失败步骤重新执行
```
