---
name: git
description: "Git版本控制：提交、分支、合并、回退"
emoji: "📦"
requires: { bins: ["git"] }
---

# Git Skill

## 何时使用
- 用户要求版本控制操作
- 用户要求查看/创建/切换分支
- 用户要求回退到某个版本

## 常用命令
- `git status` - 查看状态
- `git add .` - 暂存所有
- `git commit -m "msg"` - 提交
- `git push` / `git pull` - 推送/拉取
- `git branch <name>` - 创建分支
- `git checkout <branch>` - 切换分支
- `git log --oneline -10` - 查看历史
- `git diff` - 查看差异

## 注意事项
- `git reset --hard` 是危险操作，需要用户确认
- 合并冲突时不要自动解决，提醒用户
