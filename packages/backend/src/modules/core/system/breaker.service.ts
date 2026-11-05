import { Injectable } from '@nestjs/common';
import { LoggerService } from '../logger/logger.service.js';

/** 熔断器条目状态 */
interface BreakerEntry {
  /** 连续失败次数 */
  count: number;
  /** 熔断触发时间戳 */
  trippedAt: number;
}

/** 熔断器状态条目（结构对齐旧版 ToolLoopDetector.getBreakerStatus） */
export interface BreakerStatusItem {
  tool: string;
  tripped: boolean;
  count: number;
  remainingSeconds: number;
}

/** 触发熔断的连续失败次数阈值 */
export const FAILURE_THRESHOLD = 5;
/** 熔断冷却时长（60s） */
export const COOLDOWN_MS = 60_000;

/**
 * BreakerService - 工具级熔断器（内存计数器实现）
 *
 * 对齐旧版 ToolLoopDetector 的熔断语义：
 *   - recordFailure：连续 N 次（默认 5）失败后触发熔断
 *   - recordSuccess：清零连续失败计数
 *   - isInCooldown：熔断冷却期内拒绝调用
 *   - getStatus：{ tool, tripped, count, remainingSeconds }[]
 *   - reset：重置单个/全部熔断器
 */
@Injectable()
export class BreakerService {
  private readonly breakerState = new Map<string, BreakerEntry>();

  constructor(private readonly logger: LoggerService) {}

  /** 记录一次失败；达到阈值时触发熔断并返回 true */
  recordFailure(tool: string): boolean {
    const entry = this.breakerState.get(tool) || { count: 0, trippedAt: 0 };
    entry.count += 1;
    if (entry.count >= FAILURE_THRESHOLD && entry.trippedAt === 0) {
      entry.trippedAt = Date.now();
      this.logger.warn('Circuit breaker tripped', {
        scope: 'breaker',
        tool,
        count: entry.count,
      });
    }
    this.breakerState.set(tool, entry);
    return entry.trippedAt > 0;
  }

  /** 记录一次成功：清零连续失败计数 */
  recordSuccess(tool: string): void {
    this.breakerState.delete(tool);
  }

  /** 是否处于熔断冷却期（过期自动清理，对齐旧版 isInCooldown） */
  isInCooldown(tool: string): boolean {
    const entry = this.breakerState.get(tool);
    if (!entry || entry.trippedAt === 0) return false;
    const elapsed = Date.now() - entry.trippedAt;
    if (elapsed >= COOLDOWN_MS) {
      this.breakerState.delete(tool);
      return false;
    }
    return true;
  }

  /** 获取全部熔断器状态（冷却过期自动清理，对齐旧版 getBreakerStatus） */
  getStatus(): BreakerStatusItem[] {
    const status: BreakerStatusItem[] = [];
    for (const [tool, entry] of this.breakerState) {
      if (entry.trippedAt === 0) {
        status.push({ tool, tripped: false, count: entry.count, remainingSeconds: 0 });
        continue;
      }
      const elapsed = Date.now() - entry.trippedAt;
      const remaining = Math.max(0, Math.ceil((COOLDOWN_MS - elapsed) / 1000));
      if (remaining > 0) {
        status.push({ tool, tripped: true, count: entry.count, remainingSeconds: remaining });
      } else {
        this.breakerState.delete(tool);
      }
    }
    return status;
  }

  /** 重置单个（tool 非空）或全部熔断器（对齐旧版 resetBreaker） */
  reset(tool?: string): void {
    if (tool) {
      this.breakerState.delete(tool);
    } else {
      this.breakerState.clear();
    }
    this.logger.info('Circuit breaker reset', { scope: 'breaker', tool: tool || '(all)' });
  }
}
