import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { DoomLoopConfig } from "@skyalyticwing/shared";
import { LoggerService } from "../core/logger/logger.service.js";

/** Doom Loop 追踪条目（从 lifecycle.service.ts 提取） */
interface DoomLoopEntry {
  tool: string;
  argsHash: string;
  timestamp: number;
}

/** Doom Loop 检测结果（从 lifecycle.service.ts 提取） */
export interface DoomLoopResult {
  detected: boolean;
  count: number;
  tool?: string;
}

/** 默认 Doom Loop 检测配置 */
const DEFAULT_CONFIG: DoomLoopConfig = {
  enabled: true,
  /** 触发阈值：同一工具相同参数连续调用达到此次数即判定为 doom loop */
  maxConsecutiveCalls: 3,
  /** 检测时间窗口：仅统计窗口内的调用 */
  timeWindowMs: 60_000,
  cooldownMs: 5_000,
};

/**
 * DoomLoopDetectorService - Doom Loop 检测服务
 *
 * 从 LifecycleService 提取的独立检测器，对应 start.cjs 中 LifecycleManager
 * 的 trackToolCall / clearDoomLoop 逻辑。
 *
 * 检测规则：在 timeWindowMs（默认 60s）时间窗口内，若同一工具以相同参数
 * （args 哈希）连续调用次数达到 maxConsecutiveCalls（默认 3），判定为 doom loop。
 *
 * 与仅追踪工具名的检测相比，args 哈希能精确识别相同入参的重复调用，
 * 显著降低误报（例如同工具不同参数的正常连续调用不会被误判）。
 */
@Injectable()
export class DoomLoopDetectorService {
  private readonly config: DoomLoopConfig = { ...DEFAULT_CONFIG };
  /** Doom Loop 追踪：sessionId 到条目数组 */
  private readonly tracker = new Map<string, DoomLoopEntry[]>();
  /** 各会话的 Doom Loop 检测状态：sessionId 到 detected */
  private readonly detected = new Map<string, boolean>();

  constructor(private readonly logger: LoggerService) {}

  /**
   * 追踪一次工具调用，并检测是否触发 Doom Loop。
   *
   * 规则：在 timeWindowMs 时间窗口内，若同一工具以相同 argsHash 连续调用
   * 次数达到 maxConsecutiveCalls，判定为 doom loop。
   *
   * @returns 检测结果，包含 detected、count、tool
   */
  trackToolCall(
    sessionId: string,
    toolName: string,
    args: unknown,
  ): DoomLoopResult {
    if (!this.config.enabled) {
      return { detected: false, count: 0, tool: toolName };
    }

    const key = sessionId || "default";
    const entries = this.tracker.get(key) ?? [];

    const argsHash = createHash("sha256")
      .update(JSON.stringify(args ?? {}))
      .digest("hex")
      .substring(0, 16);
    const now = Date.now();

    // 清理超出时间窗口的旧条目
    const fresh = entries.filter((e) => now - e.timestamp < this.config.timeWindowMs);

    // 记录本次调用（修复原 start.cjs 中空列表提前返回不记录本次调用的问题）
    fresh.push({ tool: toolName, argsHash, timestamp: now });
    this.tracker.set(key, fresh);

    // 从尾部统计连续相同调用次数（工具名与 args 哈希均匹配），含本次
    let consecutiveCount = 0;
    for (let i = fresh.length - 1; i >= 0; i--) {
      if (fresh[i]!.tool === toolName && fresh[i]!.argsHash === argsHash) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    if (consecutiveCount >= this.config.maxConsecutiveCalls) {
      this.detected.set(key, true);
      this.logger.warn("Doom loop detected", {
        scope: "doom-loop",
        toolName,
        consecutiveCount,
        sessionId: key,
      });
      return { detected: true, count: consecutiveCount, tool: toolName };
    }

    return { detected: false, count: consecutiveCount };
  }

  /** 清除指定会话的 Doom Loop 追踪与检测状态 */
  clearDoomLoop(sessionId: string): void {
    const key = sessionId || "default";
    this.tracker.delete(key);
    this.detected.delete(key);
  }

  /** 检查指定会话当前是否处于 Doom Loop 状态 */
  checkDoomLoop(sessionId: string): boolean {
    const key = sessionId || "default";
    return this.detected.get(key) ?? false;
  }

  /** 获取 Doom Loop 检测配置 */
  getDoomLoopConfig(): DoomLoopConfig {
    return { ...this.config };
  }
}
