import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * UsageService - 用量统计服务
 *
 * 移植自 start.cjs 的 usageLog / getUsage（行 2188-2213、17064-17107）。
 *
 * 数据来源：<dataDir>/usage.json（与旧版数据文件兼容）：
 *   {
 *     "today":        { tokens, promptTokens, completionTokens, requests },
 *     "thisMonth":    { tokens, promptTokens, completionTokens, requests },
 *     "history":      [...],
 *     "byProvider":   { <providerId>: { tokens, promptTokens, completionTokens, requests } }
 *   }
 */

/** 用量条目 */
interface UsageEntry {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

/** usage.json 结构 */
interface UsageStore {
  today?: Partial<UsageEntry>;
  thisMonth?: Partial<UsageEntry>;
  history?: unknown[];
  byProvider?: Record<string, Partial<UsageEntry>>;
}

/** 供应商用量（含百分比） */
export interface ProviderUsage extends UsageEntry {
  provider: string;
  percentage: number;
}

/** GET /api/usage 响应结构（对齐 .cjs getUsage） */
export interface UsageSnapshot {
  today: UsageEntry;
  thisMonth: UsageEntry;
  byProvider: ProviderUsage[];
}

/** 默认用量条目（数值缺失/NaN 时回退） */
const DEFAULT_ENTRY: UsageEntry = {
  tokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  requests: 0,
};
void DEFAULT_ENTRY; // 保留默认条目定义（聚合回退使用）

@Injectable()
export class UsageService {
  /** 读取 usage.json 并聚合（文件不存在时返回零值快照） */
  getUsage(): UsageSnapshot {
    const store = this.load();
    const byProviderRaw = store.byProvider || {};
    let totalTokens = 0;
    const entries: ProviderUsage[] = Object.keys(byProviderRaw).map((p) => {
      const raw = byProviderRaw[p] || {};
      const t = this.num(raw.tokens);
      totalTokens += t;
      return {
        provider: p,
        tokens: t,
        promptTokens: this.num(raw.promptTokens),
        completionTokens: this.num(raw.completionTokens),
        requests: this.num(raw.requests),
        percentage: 0,
      };
    });
    for (const e of entries) {
      e.percentage = totalTokens > 0 ? Math.round((e.tokens / totalTokens) * 100) : 0;
    }
    return {
      today: this.mergeEntry(store.today),
      thisMonth: this.mergeEntry(store.thisMonth),
      byProvider: entries,
    };
  }

  /** 合并默认值并剔除 NaN/缺失字段（对齐 .cjs _mergeUsage 语义，cost 字段丢弃） */
  private mergeEntry(raw?: Partial<UsageEntry>): UsageEntry {
    return {
      tokens: this.num(raw?.tokens),
      promptTokens: this.num(raw?.promptTokens),
      completionTokens: this.num(raw?.completionTokens),
      requests: this.num(raw?.requests),
    };
  }

  private num(v: unknown): number {
    return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
  }

  private load(): UsageStore {
    try {
      const file = join(this.getDataDir(), 'usage.json');
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as UsageStore;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private getDataDir(): string {
    return process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
