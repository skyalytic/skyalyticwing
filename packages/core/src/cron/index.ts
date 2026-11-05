import { createLogger, type Logger } from '@skyalyticwing/shared';
import type { CronJobConfig } from '../types/index.js';

export interface CronJob extends CronJobConfig {
  lastRun?: string;
  nextRun?: string;
  status: 'idle' | 'running' | 'error';
}

// 错误状态恢复延迟（毫秒），两种调度路径统一使用此常量
const RECOVERY_DELAY_MS = 60000;

export class CronScheduler {
  private logger: Logger;
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private timeoutRefs: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private recoveryTimeoutRefs: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'cron' });
  }

  addJob(config: CronJobConfig): CronJob {
    if (this.jobs.has(config.id)) {
      this.removeJob(config.id);
    }
    const job: CronJob = { ...config, status: 'idle' };
    this.jobs.set(config.id, job);
    if (config.enabled) this.scheduleJob(job);
    return job;
  }

  removeJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
    const timeoutRef = this.timeoutRefs.get(id);
    if (timeoutRef) clearTimeout(timeoutRef);
    this.timeoutRefs.delete(id);
    const recoveryTimeout = this.recoveryTimeoutRefs.get(id);
    if (recoveryTimeout) clearTimeout(recoveryTimeout);
    this.recoveryTimeoutRefs.delete(id);
    this.jobs.delete(id);
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  private scheduleJob(job: CronJob): void {
    this.logger.info({ job: job.id, schedule: job.schedule }, 'Cron job scheduled');
    // Simplified interval-based scheduling
    // Parse simple interval from schedule (e.g., "every 30m", "every 1h")
    let intervalMs = this.parseInterval(job.schedule);
    if (intervalMs > 0) {
      // TS-4 fix: setInterval 的 delay 参数为 32 位有符号整数，超过 2147483647 会被截断为 1ms
      const MAX_SETINTERVAL_DELAY = 2147483647;
      if (intervalMs > MAX_SETINTERVAL_DELAY) {
        this.logger.error({ job: job.id, schedule: job.schedule, intervalMs }, 'Cron interval exceeds 32-bit limit, rejecting to prevent DoS');
        job.status = 'error';
        return;
      }
      const timer = setInterval(async () => {
        if (job.status === 'idle') {
          job.status = 'running';
          job.lastRun = new Date().toISOString();
          this.logger.info({ job: job.id }, 'Cron job executing');
          try {
            // TS-8 fix: 抛出未实现错误而非静默成功
            throw new Error('Cron job execution not implemented yet');
            job.status = 'idle';
          } catch (error) {
            this.logger.error({ job: job.id, error }, 'Cron job failed');
            job.status = 'error';
            // Auto-recover from error state after a delay
            const oldTimeout = this.recoveryTimeoutRefs.get(job.id);
            if (oldTimeout) clearTimeout(oldTimeout);
            const timeoutRef = setTimeout(() => {
              if (job.status === 'error') job.status = 'idle';
              this.recoveryTimeoutRefs.delete(job.id);
            }, RECOVERY_DELAY_MS);
            this.recoveryTimeoutRefs.set(job.id, timeoutRef);
          }
        }
      }, intervalMs);
      this.timers.set(job.id, timer);
      return;
    }

    // Cron expression-based scheduling using next execution time
    const nextTime = this.getNextExecutionTime(job.schedule);
    if (!nextTime) {
      this.logger.warn({ jobId: job.id, expression: job.schedule }, 'Invalid or unsupported cron expression');
      job.status = 'idle';
      return;
    }
    const delay = nextTime.getTime() - Date.now();
    if (delay <= 0) {
      this.logger.warn({ jobId: job.id, expression: job.schedule }, 'Cron expression resolved to past time');
      job.status = 'idle';
      return;
    }
    const scheduleNext = () => {
      if (!this.jobs.has(job.id)) return; // Job was removed, stop scheduling
      const next = this.getNextExecutionTime(job.schedule);
      if (!next) {
        this.logger.warn({ jobId: job.id, expression: job.schedule }, 'Failed to resolve next execution time');
        job.status = 'idle';
        return;
      }
      const nextDelay = next.getTime() - Date.now();
      if (nextDelay <= 0) {
        // If the next time is already past, reschedule with a small delay to avoid stack overflow
        const recoveryTimeout = setTimeout(() => scheduleNext(), 1000);
        this.timeoutRefs.set(job.id, recoveryTimeout);
        return;
      }
      // setTimeout 的 delay 参数为 32 位有符号整数，超过 2^31-1（约 24.8 天）会被截断为 1ms 立即触发
      // 对长延迟（月级/年级 cron）需分阶段调度：先等待 MAX_SETTIMEOUT_DELAY，再重新计算剩余延迟
      const MAX_SETTIMEOUT_DELAY = 2147483647;
      const actualDelay = Math.min(nextDelay, MAX_SETTIMEOUT_DELAY);
      const timeoutRef = setTimeout(async () => {
        // 若延迟被截断（长延迟调度），仅重新调度而不执行任务
        if (nextDelay > MAX_SETTIMEOUT_DELAY) {
          scheduleNext();
          return;
        }
        if (job.status === 'idle') {
          job.status = 'running';
          job.lastRun = new Date().toISOString();
          this.logger.info({ job: job.id }, 'Cron job executing');
          try {
            // TS-8 fix: 抛出未实现错误而非静默成功
            throw new Error('Cron job execution not implemented yet');
            job.status = 'idle';
          } catch (error) {
            this.logger.error({ job: job.id, error }, 'Cron job failed');
            job.status = 'error';
            const oldTimeout = this.recoveryTimeoutRefs.get(job.id);
            if (oldTimeout) clearTimeout(oldTimeout);
            const recoveryRef = setTimeout(() => {
              if (job.status === 'error') job.status = 'idle';
              this.recoveryTimeoutRefs.delete(job.id);
            }, RECOVERY_DELAY_MS);
            this.recoveryTimeoutRefs.set(job.id, recoveryRef);
          }
        }
        // Reschedule for next execution
        scheduleNext();
      }, actualDelay);
      this.timeoutRefs.set(job.id, timeoutRef);
    };
    scheduleNext();
  }

  private parseInterval(schedule: string): number {
    const match = schedule.match(/every\s+(\d+)\s*(ms|s|m|h)/i);
    if (!match) return 0;
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 'ms': return value;
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      default: return 0;
    }
  }

  private getNextExecutionTime(expr: string): Date | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const parseField = (field: string, min: number, max: number): number[] | null => {
      if (field === '*') return null; // null means "any"
      const values = new Set<number>();
      for (const part of field.split(',')) {
        let rangePart = part;
        let step = 1;
        if (part.includes('/')) {
          const [rangeStr, stepStr] = part.split('/');
          rangePart = rangeStr;
          step = parseInt(stepStr);
          // 非法 step 返回空数组（无匹配值），避免与通配符 null 语义混淆
          if (isNaN(step) || step < 1) return [];
        }
        let start = min;
        let end = max;
        if (rangePart === '*') {
          start = min;
          end = max;
        } else if (rangePart.includes('-')) {
          const [s, e] = rangePart.split('-');
          start = parseInt(s);
          end = parseInt(e);
          // 非法范围返回空数组，避免与通配符 null 语义混淆
          if (isNaN(start) || isNaN(end)) return [];
          start = Math.max(min, Math.min(max, start));
          end = Math.max(min, Math.min(max, end));
        } else {
          start = parseInt(rangePart);
          // 非法字段返回空数组，避免与通配符 null 语义混淆
          if (isNaN(start)) return [];
          start = Math.max(min, Math.min(max, start));
          // 当存在步进（step > 1）且 rangePart 为单值时，标准 cron 语义为"从 N 开始到 max，按 step 步进"
          // 例如 "5/2" 在分钟字段中表示 [5,7,9,...,59]，而非仅 [5]
          if (step > 1) {
            end = max;
          } else {
            end = start;
          }
        }
        for (let v = start; v <= end; v += step) {
          if (v >= min && v <= max) values.add(v);
        }
      }
      return Array.from(values).sort((a, b) => a - b);
    };

    const minutes = parseField(parts[0], 0, 59);
    const hours = parseField(parts[1], 0, 23);
    const daysOfMonth = parseField(parts[2], 1, 31);
    const months = parseField(parts[3], 1, 12);
    // 标准 cron 星期字段允许 0-7，其中 0 和 7 均表示周日
    const daysOfWeek = parseField(parts[4], 0, 7);

    const now = new Date();
    // 覆盖一年（365*24*60=525600 分钟），确保月级/年级 cron 表达式可被正确调度
    const maxIterations = 525600;
    let iterations = 0;

    for (let d = new Date(now.getTime() + 60000); iterations < maxIterations; d.setMinutes(d.getMinutes() + 1)) {
      iterations++;
      if (minutes !== null && !minutes.includes(d.getMinutes())) continue;
      if (hours !== null && !hours.includes(d.getHours())) continue;
      if (months !== null && !months.includes(d.getMonth() + 1)) continue;
      // 标准 Vixie cron 规则：当 day-of-month 和 day-of-week 都被限制（非 *）时，
      // 任一匹配即执行（OR 逻辑）；仅当其中一个为 * 时才用 AND 逻辑
      if (daysOfMonth !== null && daysOfWeek !== null) {
        // 将 `var` 改为 `let`，避免 var 提升导致的作用域污染与代码风格问题
        const dow = d.getDay();
        // 0 和 7 都表示周日：当 dow===0 且 daysOfWeek 含 7 时也应匹配
        if (!daysOfMonth.includes(d.getDate()) && !daysOfWeek.includes(dow) && !(dow === 0 && daysOfWeek.includes(7))) continue;
      } else {
        if (daysOfMonth !== null && !daysOfMonth.includes(d.getDate())) continue;
        if (daysOfWeek !== null) {
          // 将 `var` 改为 `let`，避免 var 提升导致的作用域污染与代码风格问题
          const dow2 = d.getDay();
          if (!daysOfWeek.includes(dow2) && !(dow2 === 0 && daysOfWeek.includes(7))) continue;
        }
      }
      return new Date(d);
    }
    return null;
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    for (const timeoutRef of this.timeoutRefs.values()) clearTimeout(timeoutRef);
    this.timeoutRefs.clear();
    for (const recoveryTimeoutRef of this.recoveryTimeoutRefs.values()) clearTimeout(recoveryTimeoutRef);
    this.recoveryTimeoutRefs.clear();
    // Reset all job statuses to idle
    for (const job of this.jobs.values()) {
      if (job.status !== 'idle') job.status = 'idle';
    }
  }
}
