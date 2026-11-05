---
name: tmux
description: "🧩 Tmux管理 - 远程控制tmux会话和窗口"
emoji: 🧩
---

# Tmux Skill

远程控制 tmux 会话，管理窗口和面板，实现持久化终端操作。

## 使用场景

- 创建和附加tmux会话
- 管理窗口和面板
- 在会话中执行命令
- 监控长时间运行的任务
- 会话恢复和共享

## 前置要求

- 需要安装 tmux（`apt install tmux` / `brew install tmux`）
- Windows 用户需使用 WSL

## 操作步骤

1. **会话管理**
   ```bash
   tmux new-session -d -s mysession     # 创建后台会话
   tmux ls                               # 列出会话
   tmux kill-session -t mysession        # 终止会话
   ```

2. **在会话中执行命令**
   ```bash
   tmux send-keys -t mysession "npm start" Enter
   tmux send-keys -t mysession "ls -la" Enter
   ```

3. **窗口管理**
   ```bash
   tmux new-window -t mysession -n logs
   tmux send-keys -t mysession:logs "tail -f /var/log/app.log" Enter
   ```

4. **面板分割**
   ```bash
   tmux split-window -t mysession -h
   tmux split-window -t mysession -v
   ```

5. **读取会话输出**
   ```bash
   tmux capture-pane -t mysession -p
   ```

## 示例

```
用户: 创建一个叫"build"的tmux会话并运行构建
执行: bash({ command: "tmux new-session -d -s build && tmux send-keys -t build 'npm run build' Enter" })

用户: 查看tmux会话列表
执行: bash({ command: "tmux ls" })

用户: 读取build会话的输出
执行: bash({ command: "tmux capture-pane -t build -p" })
```
