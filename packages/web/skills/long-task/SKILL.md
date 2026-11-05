---
name: long-task
description: "🔁 长期任务 - 创建 7×24 自动执行的跨天/跨周任务，含进度追踪与自动续排协议"
emoji: 🔁
---

# Long Task Skill（长期任务）

创建能自动运行数天甚至数周的长期任务：每轮执行自动带上之前的进度与历史，AI 自主续排计划，完成或达到上限后自动收尾。适合"跟踪一周股价""持续监控某页面直到上线""每天整理并在周五汇总报告"这类跨天任务。

## 创建长期任务

使用 `cron_create`，`taskType` 必须为 `ai`，并传入 `goal`（总目标）：

```
cron_create({
  name: "股价跟踪",
  expression: "0 9,15 * * 1-5",        // 每个交易日 9 点和 15 点各执行一轮
  taskType: "ai",
  command: "检查自选股价格异动并记录",
  goal: "跟踪本周自选股走势，周五生成周度汇总报告",
  maxRounds: 10                         // 可选：最大轮次，达到后自动收尾
})
```

要点：
- `goal` 是"整个任务最终要达成什么"，`command` 是"每一轮具体做什么"，两者分开写
- 周期建议按"一轮能干完的量"拆（2-4 小时一轮比一天一轮更容易稳定推进）
- 一次性任务不要传 `goal`

## 每轮执行时（AI 行为约定）

执行器会把"总目标 + 当前进度 + 最近 10 轮历史"注入给你。每轮结束时**必须**在回复末尾输出协议标记：

```
[STATUS: running|done|blocked]
[PROGRESS: 一句话总体进度]
[NEXT: continue|adjust|finish]
[SCHEDULE: <仅 adjust 时>  新计划，如 0 12 * * * 或 30min / 2h]
```

判定规则：
- 本轮做完总目标达成 → `[STATUS: done]`（任务自动停用）
- 被审批拒绝、外部依赖缺失等无法推进 → `[STATUS: blocked]`（连续 3 轮 blocked 任务自动暂停）
- 发现频率不合适（太密/太疏）→ `[NEXT: adjust]` + `[SCHEDULE: 新计划]`
- 正常推进 → `[STATUS: running]` + `[NEXT: continue]`

## 管理长期任务

- `cron_list` 查看任务；`cron_run_now` 立即执行一轮
- 用户要提前收尾 → `cron_update({ jobId, enabled: false })`
- 用户要改总目标 → `cron_update({ jobId, command })`（进度与历史保留）

## 后台桌面操作配合

长期任务经常需要操作桌面应用（如监控聊天窗口）。**必须使用后台模式**，避免抢占用户键鼠：

```
desktop({ action: "click", window: "微信", x: 100, y: 200 })     // 后台点击，不抢焦点
desktop({ action: "type", window: "微信", text: "日报已生成" })   // 后台输入
```

带 `window` 参数即走 PostMessage 直达目标窗口，用户可以同时正常使用电脑。
