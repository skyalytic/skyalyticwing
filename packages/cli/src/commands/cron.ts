/**
 * cron 命令：定时任务管理（list / run）
 *
 * 端点（对照 channels/cron/cron.controller.ts，路由前缀 /api/cron）：
 *   GET  /api/cron         - 任务清单（数组；带分页参数时返回 { jobs, total, ... }）
 *   POST /api/cron/:id/run - 立即执行指定任务（返回 OpResult）
 */
import type { CliOptions } from '../args.js';
import { DEFAULT_BASE_URL, apiFetch } from '../http.js';
import { formatTime, printTable, truncate } from '../format.js';

/** 定时任务信息（对照 CronJobInfo 的展示字段） */
interface CronJobLite {
  id: string;
  name: string;
  expression?: string;
  schedule?: unknown;
  enabled: boolean;
  lastRunAt?: number | null;
  nextRun?: number | null;
  lastResult?: string | null;
}

/** 立即执行结果（对照 OpResult） */
interface OpResultLite {
  success?: boolean;
  error?: string;
  jobId?: string;
  message?: string;
}

/** cron 命令入口；positional[0] 为子动作，positional[1] 为 jobId；返回进程退出码 */
export async function cmdCron(positional: readonly string[], options: CliOptions): Promise<number> {
  const action = positional[0] ?? 'list'; // 缺省动作视为 list

  if (action === 'list') {
    return cronList(options);
  }
  if (action === 'run') {
    const jobId = positional[1];
    if (!jobId) {
      console.error('用法：skyalyticwing cron run <jobId>');
      return 1;
    }
    return cronRun(jobId, options);
  }

  console.error(`未知的 cron 子命令：${action}（支持 list / run <jobId>）`);
  return 1;
}

/** cron list：任务清单表格 / JSON */
async function cronList(options: CliOptions): Promise<number> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await apiFetch<CronJobLite[] | { jobs: CronJobLite[] }>(baseUrl, '/api/cron');
    const raw = res.data;
    // 兼容分页包装：带 offset/limit 时返回 { jobs, total, ... }
    const jobs = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];

    if (options.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return 0;
    }

    if (jobs.length === 0) {
      console.log('暂无定时任务');
      return 0;
    }

    printTable(
      ['ID', '名称', '表达式', '启用', '上次运行', '下次运行', '上次结果'],
      jobs.map((j) => [
        j.id,
        truncate(j.name, 24),
        j.expression ?? (j.schedule !== undefined ? truncate(JSON.stringify(j.schedule), 20) : '-'),
        j.enabled ? '✓' : '✗',
        formatTime(j.lastRunAt),
        formatTime(j.nextRun),
        j.lastResult ? truncate(j.lastResult, 40) : '-',
      ]),
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`✗ 获取定时任务失败：${message}`);
    }
    return 1;
  }
}

/** cron run <jobId>：立即执行指定任务 */
async function cronRun(jobId: string, options: CliOptions): Promise<number> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await apiFetch<OpResultLite>(baseUrl, `/api/cron/${encodeURIComponent(jobId)}/run`, {
      method: 'POST',
      timeoutMs: 120_000, // 任务可能触发 agent 执行，放宽超时
    });
    const op = res.data ?? {};

    if (options.json) {
      console.log(JSON.stringify({ ok: op.success !== false, ...op }, null, 2));
      return op.success === false ? 1 : 0;
    }

    if (op.success === false) {
      console.error(`✗ 任务执行失败：${op.error ?? '未知错误'}`);
      return 1;
    }
    console.log(`✓ 任务已触发执行：${op.message ?? op.jobId ?? jobId}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`✗ 触发任务失败：${message}`);
    }
    return 1;
  }
}
