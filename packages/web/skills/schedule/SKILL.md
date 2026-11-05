---
name: schedule
description: "⏰ 计划任务 - 创建、管理和运行定时任务"
emoji: ⏰
---

# Schedule Skill

创建、管理和运行定时任务，支持 cron 表达式和一次性定时执行。

## 使用场景

- 创建定时任务
- 管理现有任务
- 立即执行任务
- 查看任务执行历史
- 临时禁用/启用任务

## 操作步骤

1. **创建定时任务**
   使用 `cron_create` 工具：
   ```
   cron_create({
     name: "每日备份",
     schedule: "0 2 * * *",
     prompt: "执行数据库备份并发送通知",
     agentId: "main"
   })
   ```

2. **列出所有任务**
   ```
   cron_list()
   ```

3. **立即执行任务**
   ```
   cron_run_now({ jobId: "job_id" })
   ```

4. **启用/禁用任务**
   ```
   cron_toggle({ jobId: "job_id", enabled: false })
   ```

5. **删除任务**
   ```
   cron_delete({ jobId: "job_id" })
   ```

## Cron表达式说明

```
┌──────── 分钟 (0-59)
│ ┌────── 小时 (0-23)
│ │ ┌──── 日 (1-31)
│ │ │ ┌── 月 (1-12)
│ │ │ │ ┌ 星期 (0-7, 0和7都是周日)
│ │ │ │ │
* * * * *
```

常用表达式：
- `*/5 * * * *` - 每5分钟
- `0 * * * *` - 每小时
- `0 9 * * *` - 每天上午9点
- `0 9 * * 1` - 每周一上午9点
- `0 0 1 * *` - 每月1日零点

## 示例

```
用户: 每天凌晨2点执行备份
执行: cron_create({ name: "每日备份", schedule: "0 2 * * *", prompt: "备份数据库" })

用户: 列出所有定时任务
执行: cron_list()

用户: 立即运行备份任务
执行: cron_run_now({ jobId: "backup_job_id" })

用户: 暂停这个定时任务
执行: cron_toggle({ jobId: "job_id", enabled: false })
```
