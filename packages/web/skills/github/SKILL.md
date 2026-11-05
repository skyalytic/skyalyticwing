---
name: github
description: "GitHub操作：提交代码、管理仓库、创建PR/Issue、查看状态"
emoji: "🐙"
requires: { bins: ["git"] }
---

# GitHub Skill

## 何时使用
- 用户要求提交代码到GitHub
- 用户要求查看仓库状态、PR、Issue
- 用户要求创建GitHub个人访问令牌(PAT)
- 用户要求克隆/推送/拉取代码

## 操作步骤

### 提交代码
1. 用 `bash` 执行 `git status` 查看变更
2. 用 `bash` 执行 `git add -A` 暂存所有变更
3. 用 `bash` 执行 `git commit -m "描述信息"` 提交
4. 用 `bash` 执行 `git push` 推送到远程

### 生成PAT令牌
1. 用 browser 打开 https://github.com/settings/tokens
2. 用 snapshot 或 DOM提取 获取页面元素
3. 点击 "Generate new token"
4. 勾选 repo 权限
5. 生成并复制令牌

### 查看仓库状态
1. 用 `bash` 执行 `git remote -v` 查看远程仓库
2. 用 `bash` 执行 `git log --oneline -5` 查看最近提交
3. 用 `bash` 执行 `git branch -a` 查看分支

## 注意事项
- 推送前确认用户意图
- 不要泄露令牌内容
- 合并冲突时提醒用户手动处理
