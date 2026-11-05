---
name: session-logs
description: "📜 会话日志 - 搜索和分析AI会话历史记录"
emoji: 📜
---

# Session Logs Skill

搜索和分析 SkyalyticWing 的 AI 会话历史记录，提取关键信息和模式。

## 使用场景

- 搜索历史对话
- 分析会话模式
- 提取关键决策和结论
- 统计工具使用频率
- 生成会话摘要

## 操作步骤

1. **列出会话**
   使用 `session_list` 工具获取所有会话列表

2. **读取会话历史**
   使用 `sessions_history` 工具读取特定会话的消息：
   ```
   sessions_history({ sessionId: "session_id", limit: 50 })
   ```

3. **搜索会话内容**
   使用 `grep` 搜索会话存储文件：
   ```bash
   grep -r "关键词" data/sessions/
   ```

4. **分析会话数据**
   使用 `code_execution` 执行分析脚本：
   ```python
   import json, os
   sessions_dir = "data/sessions"
   results = []
   for f in os.listdir(sessions_dir):
       if f.endswith('.json'):
           data = json.load(open(os.path.join(sessions_dir, f)))
           # 分析逻辑
   ```

5. **生成报告**
   - 会话数量统计
   - 活跃时段分析
   - 工具使用频率
   - 常见问题模式

## 示例

```
用户: 搜索我之前关于"部署"的对话
执行: grep({ pattern: "部署", path: "data/sessions/", glob: "*.json" })

用户: 分析最近10个会话的工具使用情况
执行: code_execution({ language: "python", code: "会话分析脚本" })

用户: 列出所有会话
执行: session_list()
```
