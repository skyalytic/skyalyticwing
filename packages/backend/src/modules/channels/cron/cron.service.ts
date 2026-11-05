import { updateMaintenance } from '../../core/system/update-maintenance.js';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { CronDeliveryService } from './cron-delivery.service.js';

// ============================================================
// 类型定义
// ============================================================

/** 调度类型 */
export type ScheduleKind = 'at' | 'every' | 'cron';

/** 调度配置（cron-manager.cjs 风格） */
export interface ScheduleConfig {
  kind: ScheduleKind;
  /** at 模式：ISO 日期字符串 */
  at?: string;
  /** every 模式：间隔毫秒数 */
  everyMs?: number;
  /** every 模式：锚点毫秒数 */
  anchorMs?: number;
  /** cron 模式：cron 表达式 */
  expr?: string;
  /** cron 模式：时区 */
  tz?: string;
  /** cron 模式：错峰毫秒数 */
  staggerMs?: number;
}

/** 投递配置 */
export interface DeliveryConfig {
  mode?: 'none' | 'announce' | 'webhook';
  channel?: string;
  threadId?: string | null;
  accountId?: string | null;
  bestEffort?: boolean;
  url?: string;
  webhookUrl?: string;
  failureDestination?: {
    mode?: string;
    url?: string;
  } | null;
}

/** 失败告警配置 */
export interface FailureAlertConfig {
  /** 连续失败多少次后告警 */
  after?: number;
  /** 告警冷却时间（毫秒） */
  cooldownMs?: number;
  /** 是否包含跳过的运行 */
  includeSkipped?: boolean;
  /** 告警渠道 */
  channel?: string;
  /** 告警 webhook URL */
  webhookUrl?: string;
}

/** 定时任务配置 */
export interface CronJobConfig {
  id: string;
  name: string;
  /** 调度配置（cron-manager.cjs 风格） */
  schedule?: ScheduleConfig;
  /** 标准 cron 表达式（start.cjs CronScheduler 风格） */
  expression?: string;
  /** 发送给 AI 的提示 */
  prompt?: string;
  /** 命令 */
  command?: string;
  /** URL（webhook/browser 任务） */
  url?: string;
  /** 任务类型 */
  taskType?: 'shell' | 'builtin' | 'ai' | 'browser' | 'webhook' | 'tool';
  /** AI 模型 */
  model?: string;
  /** 工具名称 */
  toolName?: string;
  /** 工具参数 */
  toolArgs?: Record<string, unknown> | null;
  /** 是否启用 */
  enabled: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 投递配置 */
  delivery?: DeliveryConfig;
  /** 失败告警配置 */
  failureAlert?: FailureAlertConfig | null;
  /** 备用模型 */
  fallbackModel?: string | null;
  /** 目标（main/current/isolated/session:xxx） */
  target?: string;
  /** 依赖任务 ID 列表 */
  dependsOn?: string[];
  /** 是否只运行一次 */
  runOnce?: boolean;
  /** 是否系统内置任务 */
  system?: boolean;
  /** 长期任务状态追踪（AI 任务 7×24 执行的跨轮次上下文） */
  longRunning?: LongRunningState | null;
}

/** 定时任务运行状态 */
export interface CronRunState {
  nextRun?: number | null;
  lastRunAt?: number | null;
  lastResult?: string | null;
  consecutiveErrors?: number;
  lastErrorAt?: number | null;
  lastFailureAlertAt?: number | null;
}

/** 运行日志条目 */
export interface RunLogEntry {
  jobId: string;
  startedAt: string;
  completedAt: string | null;
  duration: number;
  outcome: 'pending' | 'success' | 'error' | 'skipped';
  summary: string;
  deliveryStatus?: string;
  deliveryMethod?: string;
  deliveryCompletedAt?: number;
}

/** 定时任务信息（列表视图） */
export interface CronJobInfo {
  id: string;
  name: string;
  schedule?: ScheduleConfig;
  expression?: string;
  enabled: boolean;
  target: string;
  delivery: DeliveryConfig;
  lastRunAt: number | null;
  lastResult: string | null;
  nextRun: number | null;
  consecutiveErrors: number;
  /** 任务类型（ai/shell/...） */
  taskType?: string;
  /** 长期任务摘要（列表视图轻量展示） */
  longRunning?: { round?: number; progress?: string };
}

/** 定时任务详情（包含运行状态和日志） */
export interface CronJobDetail extends CronJobInfo {
  failureAlert: FailureAlertConfig | null;
  fallbackModel: string | null;
  createdAt: number;
  updatedAt: number;
  /** 任务类型（ai/shell/...） */
  taskType?: string;
  /** 长期任务状态追踪（round/progress/history） */
  longRunning?: LongRunningState;
  runState: {
    lastRunAt: number | null;
    lastResult: string | null;
    nextRun: number | null;
    consecutiveErrors: number;
    lastErrorAt: number | null;
    lastFailureAlertAt: number | null;
  };
  recentLogs: RunLogEntry[];
}

/** 分页结果 */
export interface CronJobPage {
  jobs: CronJobInfo[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** 服务状态 */
export interface CronStatus {
  running: boolean;
  totalJobs: number;
  enabledJobs: number;
  dataDir: string;
}

/** 操作结果 */
export interface OpResult {
  success: boolean;
  error?: string;
  jobId?: string;
  message?: string;
}

/** 调度验证结果 */
export interface ScheduleValidation {
  valid: boolean;
  error?: string;
  nextRun?: number;
}

/** Webhook URL 验证结果 */
export interface UrlValidation {
  valid: boolean;
  error?: string;
  url?: string;
}

/** 任务执行处理器 */
export type JobHandler = (job: InternalCronJob, target: string) => Promise<unknown> | unknown;

/** 按任务类型注册的全局处理器（如 ai → CronAiExecutorService） */
export type GlobalJobHandler = (job: InternalCronJob, target: string) => Promise<unknown>;

/** 长期任务单轮执行历史 */
export interface LongRunHistoryEntry {
  at: number;
  outcome: 'success' | 'error';
  /** 该轮 AI 声明的状态（续排协议 [STATUS:] 标记） */
  status?: 'running' | 'done' | 'blocked';
  /** 该轮摘要（[PROGRESS:] 或结果首行） */
  summary: string;
}

/** 长期任务状态追踪（7×24 自动执行 + 跨轮次上下文注入） */
export interface LongRunningState {
  /** 任务总目标（创建时固化，每轮注入 prompt） */
  goal?: string;
  /** 当前进度摘要（每轮由 [PROGRESS:] 标记更新） */
  progress?: string;
  /** 已执行轮次 */
  round?: number;
  /** 最大轮次（缺省/0 = 无限制；达到后自动收尾禁用） */
  maxRounds?: number;
  /** 最近执行历史（环形，最多 20 条） */
  history?: LongRunHistoryEntry[];
}

/** 长期任务单轮执行后的状态补丁（由 AI 任务执行器解析续排协议后提交） */
export interface LongRunningPatch {
  /** 更新进度摘要 */
  progress?: string;
  /** 该轮声明状态 */
  status?: 'running' | 'done' | 'blocked';
  /** 该轮摘要 */
  summary?: string;
  /** 该轮结果是否失败（失败也计入历史，但不推进进度） */
  error?: boolean;
  /** 重新调度（[NEXT: adjust] + [SCHEDULE:] 时提交） */
  reschedule?: {
    /** 标准 cron 表达式 */
    expression?: string;
    /** 或间隔分钟（转 every 调度） */
    everyMinutes?: number;
  };
  /** 收尾：禁用任务（done/maxRounds 达成/连续 blocked） */
  finish?: boolean;
}

/** 内部任务对象（完整字段） */
export interface InternalCronJob extends CronJobConfig {
  createdAt: number;
  updatedAt: number;
  status?: 'idle' | 'running' | 'error';
  lastStatus?: string;
  lastStarted?: number;
  completedAt?: number;
  lastResult?: unknown;
  lastError?: string | null;
  retryCount?: number;
  nextRun?: string | null;
}

// ============================================================
// 常量
// ============================================================

/** 最大重试次数 */
const MAX_RETRIES = 3;
/** 每个任务最大运行日志条数 */
const MAX_RUN_LOGS_PER_JOB = 100;
/** 扫描最小延迟（1 秒） */
const MIN_CHECK_DELAY = 1_000;
/** 扫描最大延迟（5 分钟） */
const MAX_CHECK_DELAY = 300_000;
/** 无启用任务时的扫描间隔（60 秒） */
const IDLE_CHECK_DELAY = 60_000;
/** runOnce 任务默认延迟（15 秒） */
const RUNONCE_DEFAULT_DELAY = 15_000;
/** Stale running 状态超时（5 分钟） */
const STALE_RUNNING_TIMEOUT = 300_000;
/** 历史记录最大条数 */
const MAX_HISTORY = 100;

// ============================================================
// 调度解析与验证
// ============================================================

/**
 * 验证调度配置
 * 支持 at（定时）、every（间隔）、cron（cron 表达式）三种模式。
 */
export function validateSchedule(schedule: ScheduleConfig): ScheduleValidation {
  if (!schedule || !schedule.kind) {
    return { valid: false, error: 'Schedule must have a kind field' };
  }
  switch (schedule.kind) {
    case 'at': {
      if (!schedule.at) return { valid: false, error: '"at" schedule requires "at" field' };
      const atTime = new Date(schedule.at);
      if (isNaN(atTime.getTime())) {
        return { valid: false, error: 'Invalid "at" datetime: ' + schedule.at };
      }
      return { valid: true, nextRun: atTime.getTime() };
    }
    case 'every': {
      if (!schedule.everyMs || schedule.everyMs <= 0) {
        return { valid: false, error: '"every" schedule requires positive "everyMs" field' };
      }
      const anchor = schedule.anchorMs || Date.now();
      const now = Date.now();
      const elapsed = now - anchor;
      const intervals = Math.floor(elapsed / schedule.everyMs);
      let nextRun = anchor + (intervals + 1) * schedule.everyMs;
      if (nextRun <= now) nextRun += schedule.everyMs;
      return { valid: true, nextRun };
    }
    case 'cron': {
      if (!schedule.expr) {
        return { valid: false, error: '"cron" schedule requires "expr" field' };
      }
      const cronValidation = validateCronExpr(schedule.expr);
      if (!cronValidation.valid) return cronValidation;
      const nextCronRun = calculateCronNext(schedule.expr, schedule.tz, schedule.staggerMs || 0);
      return { valid: true, nextRun: nextCronRun };
    }
    default:
      return { valid: false, error: 'Unknown schedule kind: ' + schedule.kind };
  }
}

/**
 * 验证 cron 表达式格式（5 或 6 字段）
 */
export function validateCronExpr(expr: string): ScheduleValidation {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    return { valid: false, error: 'Cron expression must have 5 or 6 fields' };
  }
  return { valid: true };
}

/**
 * 解析 cron 字段为值数组
 * 支持：* / N-M / N-M/S / N,M / N
 */
export function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  const segments = field.split(',');
  for (const seg of segments) {
    const s = seg.trim();
    if (s === '*') {
      for (let v = min; v <= max; v++) values.push(v);
    } else if (s.indexOf('/') >= 0) {
      const stepParts = s.split('/');
      const rangePart = stepParts[0]!;
      const step = parseInt(stepParts[1]!, 10) || 1;
      let rangeMin = min;
      let rangeMax = max;
      if (rangePart !== '*') {
        const rangeParts = rangePart.split('-');
        rangeMin = parseInt(rangeParts[0]!, 10) || min;
        rangeMax = rangeParts.length > 1 ? parseInt(rangeParts[1]!, 10) || max : rangeMin;
      }
      for (let rv = rangeMin; rv <= rangeMax; rv += step) {
        values.push(rv);
      }
    } else if (s.indexOf('-') >= 0) {
      const rangeParts = s.split('-');
      const rMin = parseInt(rangeParts[0]!, 10) || min;
      const rMax = parseInt(rangeParts[1]!, 10) || max;
      for (let rv = rMin; rv <= rMax; rv++) {
        values.push(rv);
      }
    } else {
      const num = parseInt(s, 10);
      if (!isNaN(num)) values.push(num);
    }
  }
  return values;
}

/**
 * 计算 cron 表达式的下一次运行时间（时间戳）
 *
 * 算法来源：cron-manager.cjs calculateCronNext
 * 从当前时间下一分钟开始，逐分钟扫描直到找到匹配的时间点。
 * 最多扫描 525600 次（一年），避免无限循环。
 */
export function calculateCronNext(expr: string, _tz?: string, staggerMs = 0): number {
  const now = Date.now() + staggerMs;
  const parts = expr.trim().split(/\s+/);
  const minute = parseCronField(parts[0]!, 0, 59);
  const hour = parseCronField(parts[1]!, 0, 23);
  const dayOfMonth = parseCronField(parts[2]!, 1, 31);
  const month = parseCronField(parts[3]!, 1, 12);
  const dayOfWeek = parseCronField(parts[4]!, 0, 6);

  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const maxIterations = 525600;
  for (let i = 0; i < maxIterations; i++) {
    if (month.indexOf(d.getMonth() + 1) < 0) {
      d.setMonth(d.getMonth() + 1);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (dayOfMonth.indexOf(d.getDate()) < 0 || dayOfWeek.indexOf(d.getDay()) < 0) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (hour.indexOf(d.getHours()) < 0) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (minute.indexOf(d.getMinutes()) < 0) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }

  return now + 3600000;
}

/**
 * 计算调度的下一次运行时间
 * 兼容 schedule 对象和 expression 字符串两种格式。
 */
export function calculateNextRun(job: InternalCronJob | CronJobConfig): number | null {
  // 优先使用 expression（CronScheduler 风格）
  if (job.expression && job.expression !== '_ONCE_') {
    return calculateCronNext(job.expression);
  }
  // 使用 schedule 对象（cron-manager.cjs 风格）
  if (job.schedule) {
    const validation = validateSchedule(job.schedule);
    if (!validation.valid) return null;
    return validation.nextRun ?? null;
  }
  return null;
}

// ============================================================
// Webhook URL 验证（SSRF 防护）
// ============================================================

/**
 * 验证 HTTP webhook URL —— SSRF 防护
 *
 * 安全措施：
 *   - 仅允许 HTTP/HTTPS 协议
 *   - 检测非点分十进制 IP 格式（十进制/十六进制/八进制），防止进制编码绕过
 *   - 剥离 IPv6-mapped IPv4（::ffff:127.0.0.1）和 IPv4-compatible IPv6（::127.0.0.1）
 *   - 拒绝私网/回环/链路本地/ULA 地址
 *
 * 注意：DNS 解析校验（防 DNS rebinding）需异步 dns.lookup，此同步路径暂跳过。
 */
export function normalizeHttpWebhookUrl(url: string): UrlValidation {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  const trimmed = url.trim();

  if (trimmed.indexOf('http://') !== 0 && trimmed.indexOf('https://') !== 0) {
    return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return { valid: false, error: 'Invalid URL format: ' + (e as Error).message };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 检测非点分十进制 IP 格式（十进制/十六进制/八进制），防止进制编码绕过 SSRF 防护
  let numericHost: string | null = null;
  if (/^\d+$/.test(hostname)) {
    // 纯十进制整数 → 转换为点分十进制
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      numericHost =
        ((num >> 24) & 0xff) + '.' + ((num >> 16) & 0xff) + '.' + ((num >> 8) & 0xff) + '.' + (num & 0xff);
    }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    // 十六进制 → 转换为点分十进制
    const hexNum = parseInt(hostname, 16);
    if (hexNum >= 0 && hexNum <= 0xffffffff) {
      numericHost =
        ((hexNum >> 24) & 0xff) +
        '.' +
        ((hexNum >> 16) & 0xff) +
        '.' +
        ((hexNum >> 8) & 0xff) +
        '.' +
        (hexNum & 0xff);
    }
  } else if (/^0\d+\.\d+\.\d+\.\d+$/.test(hostname) || /^0\d+$/.test(hostname)) {
    // 八进制格式 → 拒绝（罕见且容易绕过）
    return { valid: false, error: 'Octal IP format is not allowed (SSRF protection)' };
  }

  // 如果检测到非标准格式，用转换后的点分十进制重新检查
  let checkHost = numericHost || hostname;

  // 剥离 IPv6-mapped IPv4（::ffff:127.0.0.1）和 IPv4-compatible IPv6（::127.0.0.1）
  const strippedHost = checkHost.replace(/^\[|\]$/g, '');
  let mappedIpv4: string | null = null;

  const hexWordsToIpv4 = (w1: string, w2: string): string => {
    const a = parseInt(w1, 16);
    const b = parseInt(w2, 16);
    return ((a >> 8) & 0xff) + '.' + (a & 0xff) + '.' + ((b >> 8) & 0xff) + '.' + (b & 0xff);
  };

  // ::ffff:DDD.DDD.DDD.DDD（点分十进制形式）
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(strippedHost);
  if (mappedMatch) {
    mappedIpv4 = mappedMatch[1]!;
  } else {
    // ::ffff:HHHH:HHHH（十六进制形式）
    const mappedHexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(strippedHost);
    if (mappedHexMatch) {
      mappedIpv4 = hexWordsToIpv4(mappedHexMatch[1]!, mappedHexMatch[2]!);
    } else {
      // ::DDD.DDD.DDD.DDD（IPv4-compatible，点分十进制）
      const compatMatch = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(strippedHost);
      if (compatMatch) {
        mappedIpv4 = compatMatch[1]!;
      } else {
        // ::HHHH:HHHH（IPv4-compatible，十六进制形式）
        const compatHexMatch = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(strippedHost);
        if (compatHexMatch) {
          mappedIpv4 = hexWordsToIpv4(compatHexMatch[1]!, compatHexMatch[2]!);
        }
      }
    }
  }
  if (mappedIpv4) {
    checkHost = mappedIpv4;
  }

  // 私网/回环/链路本地/ULA 地址检查
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^0\./,
    /^0$/,
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
    /^localhost$/,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i, // ULA fc00::/7 的 fc 半段
    /^fd[0-9a-f]{2}:/i, // ULA fd 半段
    /^fe80:/i,
    /^169\.254\./,
    /^\[::1\]$/,
    /^\[fc[0-9a-f]{2}:/i,
    /^\[fd[0-9a-f]{2}:/i,
    /^\[fe80/,
  ];

  for (const pattern of privatePatterns) {
    if (pattern.test(checkHost)) {
      return { valid: false, error: 'Private IP addresses are not allowed (SSRF protection)' };
    }
  }

  return { valid: true, url: trimmed };
}

// ============================================================
// Stagger 调度（错峰执行）
// ============================================================

/**
 * 计算错峰调度——将任务按 nextRun 排序后，确保相邻任务间隔不小于 staggerMs
 */
export function calculateStagger<T extends { nextRun?: number; staggerOffset?: number }>(
  jobs: T[],
  staggerMs: number,
): T[] {
  if (!staggerMs || staggerMs <= 0 || !jobs || jobs.length <= 1) {
    return jobs || [];
  }

  const sorted = jobs.slice().sort((a, b) => (a.nextRun || 0) - (b.nextRun || 0));

  for (let i = 1; i < sorted.length; i++) {
    const prevNext = sorted[i - 1]!.nextRun || 0;
    const currNext = sorted[i]!.nextRun || 0;
    const minGap = prevNext + staggerMs;
    if (currNext < minGap) {
      sorted[i]!.nextRun = minGap;
      sorted[i]!.staggerOffset = minGap - currNext;
    }
  }

  return sorted;
}

// ============================================================
// CronService
// ============================================================

/**
 * CronService - 定时任务服务
 *
 * 职责：
 *   - 管理定时任务的 CRUD（持久化到 cron.json）
 *   - 支持两种调度格式：schedule 对象（at/every/cron）和 expression 字符串（标准 5 字段 cron）
 *   - 调度引擎：动态调整扫描间隔，避免每秒全量扫描
 *   - 并发执行保护：同一 job 不会并行执行
 *   - 任务执行最大重试 3 次，指数退避（2^n * 60s）
 *   - 投递集成：通过 CronDeliveryService 投递到 announce/webhook 渠道
 *   - 失败告警：连续失败达到阈值后发送告警
 *   - 内置任务：dream-light / dream-deep / dream-rem
 *
 * 对应原始 .cjs 实现：
 *   - cron-manager.cjs: CronService 完整实现
 *   - start.cjs: CronScheduler（init / computeNextRun / tick / executeJob / addJob / removeJob）
 */
@Injectable()
export class CronService implements OnModuleInit, OnModuleDestroy {
  private readonly jobs = new Map<string, InternalCronJob>();
  private readonly runStates = new Map<string, CronRunState>();
  private readonly runLogs = new Map<string, RunLogEntry[]>();
  /** 任务执行处理器（外部注册） */
  private readonly jobHandlers = new Map<string, JobHandler>();
  /** 按 taskType 注册的全局处理器（ai 等类型的默认执行器） */
  private readonly globalHandlers = new Map<string, GlobalJobHandler>();
  /** 隔离会话上下文 */
  private readonly isolatedSessions = new Map<string, unknown>();
  /** 正在执行的任务 ID 集合（并发执行保护） */
  private readonly runningJobs = new Set<string>();
  /** 任务历史记录 */
  private readonly jobHistory: Array<{
    jobId: string;
    name: string;
    status: string;
    executedAt: number;
    duration: number;
    taskType: string;
  }> = [];

  private dataDir = '';
  private cronFilePath = '';
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dirty = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly delivery: CronDeliveryService,

  ) {}

  // ============================================================
  // 生命周期
  // ============================================================

  onModuleInit(): void {
    this.dataDir = this.resolveDataDir();
    this.cronFilePath = join(this.dataDir, 'cron.json');
    this.load();
    this.start();
    this.ensureDreamCronJobs();
    this.logger.info('[cron] 定时任务服务已初始化，共 ' + this.jobs.size + ' 个任务');
  }

  onModuleDestroy(): void {
    this.stop();
    this.delivery.clearRetryTimers();
  }

  // ============================================================
  // 数据持久化
  // ============================================================

  private resolveDataDir(): string {
    const dir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 忽略
      }
    }
    return dir;
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

  /** 加载持久化数据 */
  private load(): void {
    try {
      if (!existsSync(this.cronFilePath)) return;
      const content = readFileSync(this.cronFilePath, 'utf8');
      const data = JSON.parse(content) as {
        jobs?: Record<string, InternalCronJob>;
        runStates?: Record<string, CronRunState>;
        runLogs?: Record<string, RunLogEntry[]>;
      };
      if (data.jobs) {
        for (const [k, v] of Object.entries(data.jobs)) {
          if (v && typeof v === 'object') {
            // 重置 stale running 状态
            if (
              v.status === 'running' &&
              (!v.lastStarted || Date.now() - v.lastStarted > STALE_RUNNING_TIMEOUT)
            ) {
              v.status = 'idle';
              v.lastStatus = v.lastStatus || 'idle';
              this.logger.info('[cron] [init] 重置 stale running 状态: ' + v.name);
            }
            // runOnce 任务 nextRun 处理
            if (v.runOnce && v.nextRun) {
              const nextTime = new Date(v.nextRun).getTime();
              if (!isNaN(nextTime) && nextTime > Date.now()) {
                this.logger.info(
                  '[cron] [init] 保留 runOnce nextRun: ' + v.name + ' → ' + v.nextRun,
                );
              } else {
                v.nextRun = new Date(Date.now() + 10_000).toISOString();
                v.enabled = true;
                this.logger.info(
                  '[cron] [init] runOnce 已过期，安排立即执行: ' + v.name,
                );
              }
            } else if (!v.runOnce) {
              // 非 runOnce 任务重新计算 nextRun
              const nextRun = calculateNextRun(v);
              if (nextRun) {
                const state = data.runStates?.[k] || {};
                state.nextRun = nextRun;
                if (data.runStates) data.runStates[k] = state;
              }
            }
            v.retryCount = 0;
            v.lastError = null;
            this.jobs.set(k, v);
          }
        }
      }
      if (data.runStates) {
        for (const [k, v] of Object.entries(data.runStates)) {
          this.runStates.set(k, v);
        }
      }
      if (data.runLogs) {
        for (const [k, v] of Object.entries(data.runLogs)) {
          this.runLogs.set(k, v);
        }
      }
    } catch (err) {
      this.logger.warn(
        '[cron] 加载数据失败: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** 保存数据到磁盘（dirty 标记优化） */
  private save(): void {
    if (!this.dirty) return;
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }
      const jobsObj: Record<string, InternalCronJob> = {};
      const runStatesObj: Record<string, CronRunState> = {};
      const runLogsObj: Record<string, RunLogEntry[]> = {};
      for (const [k, v] of this.jobs) jobsObj[k] = v;
      for (const [k, v] of this.runStates) runStatesObj[k] = v;
      for (const [k, v] of this.runLogs) runLogsObj[k] = v;
      const data = { jobs: jobsObj, runStates: runStatesObj, runLogs: runLogsObj };
      writeFileSync(this.cronFilePath, JSON.stringify(data, null, 2), 'utf8');
      this.dirty = false;
    } catch (err) {
      this.logger.warn(
        '[cron] 保存数据失败: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** 裁剪运行日志到最大条数 */
  private trimRunLogs(jobId: string): void {
    const logs = this.runLogs.get(jobId);
    if (logs && logs.length > MAX_RUN_LOGS_PER_JOB) {
      this.runLogs.set(jobId, logs.slice(-MAX_RUN_LOGS_PER_JOB));
    }
  }

  /** 添加运行日志 */
  private addRunLog(jobId: string, entry: RunLogEntry): void {
    if (!this.runLogs.has(jobId)) this.runLogs.set(jobId, []);
    this.runLogs.get(jobId)!.push(entry);
    this.trimRunLogs(jobId);
  }

  // ============================================================
  // 调度引擎
  // ============================================================

  /** 启动调度引擎 */
  start(): OpResult {
    if (this.running) return { success: true, message: 'Already running' };
    this.running = true;
    this.scheduleCheck();
    this.logger.info('[cron] 调度引擎已启动');
    return { success: true };
  }

  /** 停止调度引擎 */
  stop(): OpResult {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = true;
    this.save();
    this.logger.info('[cron] 调度引擎已停止');
    return { success: true };
  }

  /**
   * 安排下一次扫描
   * 根据最近 job 的 nextRun 动态调整扫描间隔，避免每秒全量扫描所有 job。
   */
  private scheduleCheck(): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = this.calculateNextCheckDelay();
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.checkJobs();
      this.scheduleCheck();
    }, delay);
  }

  /**
   * 计算下一次扫描的最优延迟——取最近 job 的 nextRun 与 now 的差值
   */
  private calculateNextCheckDelay(): number {
    const now = Date.now();
    let minNextRun: number | null = null;
    for (const [jobId, job] of this.jobs) {
      if (!job.enabled) continue;
      const state = this.runStates.get(jobId);
      const nextRun = state?.nextRun;
      if (nextRun && (minNextRun === null || nextRun < minNextRun)) {
        minNextRun = nextRun;
      }
    }
    if (minNextRun === null) return IDLE_CHECK_DELAY;
    const diff = minNextRun - now;
    if (diff < MIN_CHECK_DELAY) return MIN_CHECK_DELAY;
    if (diff > MAX_CHECK_DELAY) return MAX_CHECK_DELAY;
    return diff;
  }

  /**
   * 检查所有任务——执行到期的任务并更新 nextRun
   */
  private checkJobs(): void {
    if (updateMaintenance.pending) return; // Keep due dates; cancellation/restart must not consume a scheduled run.
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (!job.enabled) continue;

      let state = this.runStates.get(jobId) || {};
      let nextRun = state.nextRun;

      if (!nextRun) {
        nextRun = calculateNextRun(job);
        if (nextRun) {
          state.nextRun = nextRun;
          this.runStates.set(jobId, state);
        }
        continue;
      }

      if (now >= nextRun) {
        // 检查依赖是否满足
        if (!this.checkDependencies(job)) {
          this.logger.warn('[cron] 任务 "' + job.name + '" 依赖未满足，跳过执行');
          state.nextRun = calculateNextRun(job) || now + 60_000;
          this.runStates.set(jobId, state);
          continue;
        }

        this.executeJob(jobId);

        let nextNextRun = calculateNextRun(job);
        if (nextNextRun && nextNextRun <= now) {
          nextNextRun = now + 60_000;
        }
        state = this.runStates.get(jobId) || state;
        state.nextRun = nextNextRun;
        this.runStates.set(jobId, state);
      }
    }

    this.dirty = true;
    this.save();
  }

  // ============================================================
  // 依赖检查
  // ============================================================

  /**
   * 检查任务依赖是否满足——所有依赖任务的 lastStatus 必须为 success
   */
  private checkDependencies(job: InternalCronJob): boolean {
    if (!job.dependsOn || job.dependsOn.length === 0) return true;
    return job.dependsOn.every((depId) => {
      const depJob = this.jobs.get(depId);
      return depJob && depJob.lastStatus === 'success';
    });
  }

  // ============================================================
  // 任务执行
  // ============================================================

  /**
   * 执行任务（并发保护——同一 job 不会并行执行）
   */
  private async executeJob(jobId: string): Promise<void> {
    if (updateMaintenance.pending) return;
    return updateMaintenance.run('定时任务', () => this.executeJobNow(jobId));
  }
  private async executeJobNow(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // 并发执行保护——同 job id 正在执行时跳过新触发
    if (this.runningJobs.has(jobId)) {
      this.logger.warn('[cron] 任务 ' + jobId + ' 正在执行，跳过并发触发');
      return;
    }
    this.runningJobs.add(jobId);

    let state = this.runStates.get(jobId) || {};
    const startTime = Date.now();
    const logEntry: RunLogEntry = {
      jobId: jobId,
      startedAt: new Date(startTime).toISOString(),
      completedAt: null,
      duration: 0,
      outcome: 'pending',
      summary: '' };

    state.lastRunAt = startTime;
    state.consecutiveErrors = state.consecutiveErrors || 0;

    job.status = 'running';
    job.lastStatus = 'running';
    job.lastStarted = startTime;

    const target = job.target || 'main';
    const taskType = job.taskType || 'shell';

    // 处理器解析顺序：job 专属 handler → taskType 全局 handler（如 ai → CronAiExecutorService）
    const handler = this.jobHandlers.get(jobId) ?? this.globalHandlers.get(taskType);
    if (!handler) {
      logEntry.outcome = 'skipped';
      logEntry.summary = 'No handler registered';
      state.lastResult = 'skipped';
      this.addRunLog(jobId, logEntry);
      this.runStates.set(jobId, state);
      this.runningJobs.delete(jobId);
      this.logger.warn('[cron] 任务 ' + jobId + ' 无注册处理器，跳过');
      return;
    }

    this.logger.info('[cron] 执行任务: ' + job.name + ' [type=' + taskType + ']');

    try {
      const result = await handler(job, target);
      const endTime = Date.now();
      const currentJob = this.jobs.get(jobId) || job;
      const currentState = this.runStates.get(jobId) || state;

      logEntry.completedAt = new Date(endTime).toISOString();
      logEntry.duration = endTime - startTime;
      logEntry.outcome = 'success';
      logEntry.summary = this.summarizeResult(result);
      currentState.lastResult = 'success';
      currentState.lastErrorAt = null;
      currentState.consecutiveErrors = 0;

      currentJob.status = 'idle';
      currentJob.lastStatus = 'success';
      currentJob.lastResult = result;
      currentJob.retryCount = 0;
      currentJob.lastError = null;
      currentJob.completedAt = endTime;

      // runOnce 成功后自动禁用
      if (currentJob.runOnce) {
        currentJob.enabled = false;
        currentJob.nextRun = null;
        this.logger.info(
          '[cron] 任务 "' + currentJob.name + '" 是 runOnce，执行成功后已自动禁用',
        );
        this.broadcastUpdate(jobId, 'updated');
      } else {
        currentJob.nextRun = this.computeNextRunIso(currentJob);
      }

      this.addRunLog(jobId, logEntry);
      this.runStates.set(jobId, currentState);
      this.jobs.set(jobId, currentJob);

      // 记录历史
      this.jobHistory.unshift({
        jobId: jobId,
        name: currentJob.name,
        status: 'success',
        executedAt: startTime,
        duration: endTime - startTime,
        taskType: taskType });
      if (this.jobHistory.length > MAX_HISTORY) this.jobHistory.pop();

      // 投递
      try {
        await this.delivery.deliver(currentJob as unknown as import('./cron-delivery.service.js').DeliveryJob, result as import('./cron-delivery.service.js').JobResult, null);
        logEntry.deliveryStatus = 'dispatched';
        logEntry.deliveryMethod = currentJob.delivery?.mode || 'none';
        logEntry.deliveryCompletedAt = Date.now();
      } catch (de) {
        this.logger.warn(
          '[cron] 投递失败: ' + (de instanceof Error ? de.message : String(de)),
        );
      }

      this.handleFailureAlert(jobId, currentJob, currentState);
      this.broadcastExecuted(jobId, 'success');
      this.dirty = true;
      this.save();
    } catch (err) {
      const endTime = Date.now();
      const currentJob = this.jobs.get(jobId) || job;
      const currentState = this.runStates.get(jobId) || state;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logEntry.completedAt = new Date(endTime).toISOString();
      logEntry.duration = endTime - startTime;
      logEntry.outcome = 'error';
      logEntry.summary = errorMsg;
      currentState.lastResult = 'error';
      currentState.lastErrorAt = endTime;
      currentState.consecutiveErrors = (currentState.consecutiveErrors || 0) + 1;

      currentJob.status = 'error';
      currentJob.lastStatus = 'error';
      currentJob.lastError = errorMsg;
      currentJob.retryCount = (currentJob.retryCount || 0) + 1;

      const maxRetries = currentJob.maxRetries || MAX_RETRIES;
      if (currentJob.retryCount < maxRetries) {
        // 指数退避重试：2^n * 60s
        const retryDelay = Math.pow(2, currentJob.retryCount) * 60_000;
        currentJob.nextRun = new Date(Date.now() + retryDelay).toISOString();
        this.logger.warn(
          '[cron] 任务 "' + currentJob.name + '" 失败，' + retryDelay / 1000 + 's 后重试 #' + currentJob.retryCount,
        );
      } else {
        this.logger.error(
          '[cron] 任务 "' + currentJob.name + '" 失败，已达最大重试次数 ' + maxRetries,
        );
        currentJob.nextRun = this.computeNextRunIso(currentJob);
      }

      this.addRunLog(jobId, logEntry);
      this.runStates.set(jobId, currentState);
      this.jobs.set(jobId, currentJob);

      // 记录历史
      this.jobHistory.unshift({
        jobId: jobId,
        name: currentJob.name,
        status: 'error',
        executedAt: startTime,
        duration: endTime - startTime,
        taskType: taskType });
      if (this.jobHistory.length > MAX_HISTORY) this.jobHistory.pop();

      // 投递错误通知
      try {
        await this.delivery.deliver(
          currentJob as unknown as import('./cron-delivery.service.js').DeliveryJob,
          null,
          err instanceof Error ? err : new Error(errorMsg),
        );
        logEntry.deliveryStatus = 'dispatched';
        logEntry.deliveryMethod = currentJob.delivery?.mode || 'none';
        logEntry.deliveryCompletedAt = Date.now();
      } catch (de) {
        this.logger.warn(
          '[cron] 错误投递失败: ' + (de instanceof Error ? de.message : String(de)),
        );
      }

      this.handleFailureAlert(jobId, currentJob, currentState);
      this.broadcastExecuted(jobId, 'error');
      this.dirty = true;
      this.save();
    } finally {
      this.runningJobs.delete(jobId);
    }
  }

  /** 结果摘要 */
  private summarizeResult(result: unknown): string {
    if (!result) return '';
    if (typeof result === 'string') return result.substring(0, 200);
    try {
      const str = JSON.stringify(result);
      return str.substring(0, 200);
    } catch {
      return String(result).substring(0, 200);
    }
  }

  /**
   * 计算 nextRun（ISO 字符串格式，用于 CronScheduler 风格）
   */
  private computeNextRunIso(job: InternalCronJob): string | null {
    if (job.runOnce || (job.expression && job.expression === '_ONCE_')) return null;
    const next = calculateNextRun(job);
    if (next) return new Date(next).toISOString();
    return null;
  }

  // ============================================================
  // 失败告警
  // ============================================================

  /**
   * 处理失败告警——连续失败达到阈值后发送告警
   */
  private handleFailureAlert(jobId: string, job: InternalCronJob, state: CronRunState): void {
    const failureAlert = job.failureAlert;
    if (!failureAlert) return;

    const consecutiveErrors = state.consecutiveErrors || 0;
    const threshold = failureAlert.after || 3;

    if (consecutiveErrors < threshold) return;
    if (consecutiveErrors > threshold) {
      const cooldownMs = failureAlert.cooldownMs || 3_600_000;
      const lastAlertAt = state.lastFailureAlertAt || 0;
      if (Date.now() - lastAlertAt < cooldownMs) return;
    }

    state.lastFailureAlertAt = Date.now();
    this.runStates.set(jobId, state);

    let alertMessage = '定时任务 "' + (job.name || jobId) + '" 已连续失败 ' + consecutiveErrors + ' 次。';
    if (failureAlert.includeSkipped && state.lastResult === 'skipped') {
      alertMessage += '（包含跳过的运行）';
    }

    this.logger.warn('[cron] 失败告警: ' + alertMessage);

    if (failureAlert.channel === 'webhook' && failureAlert.webhookUrl) {
      this.delivery
        .sendFailureAlertWebhook(
          jobId,
          job.name || jobId,
          consecutiveErrors,
          state.lastErrorAt || null,
          alertMessage,
          failureAlert.webhookUrl,
        )
        .catch((e) => {
          this.logger.warn(
            '[cron] 失败告警 webhook 发送错误: ' + (e instanceof Error ? e.message : String(e)),
          );
        });
    }
  }

  // ============================================================
  // 隔离会话
  // ============================================================

  /**
   * 解析执行目标
   * @param target 目标标识（main/current/isolated/session:xxx）
   * @param jobId 任务 ID（用于 isolated 模式关联）
   */
  resolveTarget(
    target: string | undefined,
    jobId?: string,
  ): { type: string; sessionId: string | null; context?: unknown } {
    if (!target) return { type: 'main', sessionId: null };
    if (target === 'main') return { type: 'main', sessionId: null };
    if (target === 'current') return { type: 'current', sessionId: null };
    if (target === 'isolated') {
      const isoSessionId = 'iso-' + Date.now() + '-' + randomBytes(4).toString('hex');
      const isoContext = {
        sessionId: isoSessionId,
        agentId: 'main',
        channel: 'cron',
        peerId: 'isolated',
        createdAt: Date.now(),
        isolated: true,
        parentJobId: jobId || null };
      this.isolatedSessions.set(isoSessionId, isoContext);
      return { type: 'isolated', sessionId: isoSessionId, context: isoContext };
    }
    if (target.indexOf('session:') === 0) {
      return { type: 'session', sessionId: target.substring('session:'.length) };
    }
    return { type: 'main', sessionId: null };
  }

  // ============================================================
  // WebSocket 广播
  // ============================================================

  private broadcastUpdate(jobId: string, action: 'created' | 'updated' | 'deleted'): void {
    try {
      this.ws.broadcast({ type: 'cron_updated', data: { jobId, action } });
    } catch {
      // 忽略广播错误
    }
  }

  private broadcastExecuted(jobId: string, status: string): void {
    try {
      this.ws.broadcast({
        type: 'notification',
        data: {
          title: '定时任务执行' + (status === 'success' ? '成功' : '失败'),
          message: '任务 ' + jobId + ' 执行' + (status === 'success' ? '完成' : '失败'),
          level: status === 'success' ? 'info' : 'error' } });
    } catch {
      // 忽略
    }
  }

  // ============================================================
  // 内置任务
  // ============================================================

  /**
   * 确保内置 Dream cron 任务存在
   * - dream-light: 每 6 小时执行一次（短期记忆暂存）
   * - dream-deep: 每天凌晨 3 点执行（记忆评分晋升）
   * - dream-rem: 每周日凌晨 5 点执行（主题模式提取）
   */
  private ensureDreamCronJobs(): void {
    const dreamJobs = [
      {
        id: 'dream-light',
        name: '🌙 Dream Light阶段(短期记忆暂存)',
        expression: '0 */6 * * *',
        taskType: 'builtin' as const,
        command: 'dream_light',
        system: true },
      {
        id: 'dream-deep',
        name: '🌙 Dream Deep阶段(记忆评分晋升)',
        expression: '0 3 * * *',
        taskType: 'builtin' as const,
        command: 'dream_deep',
        system: true },
      {
        id: 'dream-rem',
        name: '🌙 Dream REM阶段(主题模式提取)',
        expression: '0 5 * * 0',
        taskType: 'builtin' as const,
        command: 'dream_rem',
        system: true },
    ];

    for (const dj of dreamJobs) {
      if (!this.jobs.has(dj.id)) {
        this.addJob({
          id: dj.id,
          name: dj.name,
          expression: dj.expression,
          taskType: dj.taskType,
          enabled: true,
          command: dj.command,
          system: dj.system });
        this.logger.info('[cron] 已添加内置任务: ' + dj.id);
      }
    }
  }

  // ============================================================
  // 公共 API —— CRUD
  // ============================================================

  /** 列出所有定时任务 */
  listJobs(): CronJobInfo[] {
    const result: CronJobInfo[] = [];
    for (const [jobId, job] of this.jobs) {
      const state = this.runStates.get(jobId) || {};
      result.push({
        id: jobId,
        name: job.name || jobId,
        ...(job.schedule !== undefined ? { schedule: job.schedule } : {}),
        ...(job.expression !== undefined ? { expression: job.expression } : {}),
        enabled: job.enabled,
        target: job.target || 'main',
        delivery: job.delivery || { mode: 'none' },
        ...(job.taskType ? { taskType: job.taskType } : {}),
        ...(job.longRunning
          ? {
              longRunning: {
                round: job.longRunning.round || 0,
                ...(job.longRunning.progress ? { progress: job.longRunning.progress } : {}) } }
          : {}),
        lastRunAt: state.lastRunAt || null,
        lastResult: state.lastResult || null,
        nextRun: state.nextRun || null,
        consecutiveErrors: state.consecutiveErrors || 0 });
    }
    return result;
  }

  /** 分页列出定时任务 */
  listPage(offset = 0, limit = 20): CronJobPage {
    const all = this.listJobs();
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    return {
      jobs: page,
      total,
      offset,
      limit,
      hasMore: offset + limit < total };
  }

  /**
   * 添加定时任务
   * 支持 schedule 对象（at/every/cron）和 expression 字符串两种格式。
   */
  addJob(jobSpec: CronJobConfig): OpResult {
    if (!jobSpec) return { success: false, error: 'Job specification is required' };

    // 验证调度配置
    if (jobSpec.schedule) {
      const validation = validateSchedule(jobSpec.schedule);
      if (!validation.valid) return { success: false, ...(validation.error ? { error: validation.error } : {}) };
    } else if (!jobSpec.expression) {
      return { success: false, error: 'Schedule or expression is required' };
    }

    const jobId = jobSpec.id || 'job-' + Date.now() + '-' + randomBytes(4).toString('hex');

    const job: InternalCronJob = {
      id: jobId,
      name: jobSpec.name || jobId,
      ...(jobSpec.schedule !== undefined ? { schedule: jobSpec.schedule } : {}),
      ...(jobSpec.expression !== undefined ? { expression: jobSpec.expression } : {}),
      prompt: jobSpec.prompt || '',
      command: jobSpec.command || '',
      url: jobSpec.url || '',
      taskType: jobSpec.taskType || 'shell',
      model: jobSpec.model || '',
      toolName: jobSpec.toolName || '',
      toolArgs: jobSpec.toolArgs || null,
      enabled: jobSpec.enabled !== false,
      maxRetries: jobSpec.maxRetries || MAX_RETRIES,
      delivery: jobSpec.delivery || { mode: 'none' },
      failureAlert: jobSpec.failureAlert || null,
      fallbackModel: jobSpec.fallbackModel || null,
      target: jobSpec.target || 'main',
      dependsOn: jobSpec.dependsOn || [],
      runOnce: !!jobSpec.runOnce,
      system: !!jobSpec.system,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      lastStatus: 'pending',
      retryCount: 0,
      lastError: null };

    // 计算 nextRun
    if (job.runOnce || job.expression === '_ONCE_') {
      job.nextRun = new Date(Date.now() + RUNONCE_DEFAULT_DELAY).toISOString();
      this.logger.warn(
        '[cron] runOnce 任务 "' + job.name + '" 无 nextRun，默认 15 秒后执行',
      );
    } else {
      const nextRun = calculateNextRun(job);
      job.nextRun = nextRun ? new Date(nextRun).toISOString() : null;
    }

    // Webhook URL 验证
    if (job.delivery && job.delivery.mode === 'webhook' && job.delivery.url) {
      const urlValidation = normalizeHttpWebhookUrl(job.delivery.url);
      if (!urlValidation.valid) {
        return { success: false, error: 'Invalid webhook URL: ' + urlValidation.error };
      }
      job.delivery.url = urlValidation.url!;
    }

    this.jobs.set(jobId, job);
    this.runStates.set(jobId, {
      nextRun: job.nextRun ? new Date(job.nextRun).getTime() : null,
      lastRunAt: null,
      lastResult: null,
      consecutiveErrors: 0,
      lastErrorAt: null });
    this.runLogs.set(jobId, []);

    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'created');
    this.logger.info('[cron] 任务已添加: ' + jobId + ' (' + (job.expression || job.schedule?.kind || 'unknown') + ')');
    return { success: true, jobId };
  }

  /**
   * 更新定时任务
   */
  updateJob(jobId: string, updates: Partial<CronJobConfig>): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };

    const allowedFields: (keyof CronJobConfig)[] = [
      'name',
      'schedule',
      'expression',
      'enabled',
      'target',
      'delivery',
      'failureAlert',
      'fallbackModel',
      'prompt',
      'command',
      'model',
      'taskType',
      'url',
      'toolName',
      'toolArgs',
      'dependsOn',
      'runOnce',
      'maxRetries',
    ];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        (job as unknown as Record<string, unknown>)[field] = updates[field];
      }
    }

    // 重新验证调度
    if (updates.schedule) {
      const validation = validateSchedule(updates.schedule);
      if (!validation.valid) return { success: false, ...(validation.error ? { error: validation.error } : {}) };
      const state = this.runStates.get(jobId) || {};
      state.nextRun = validation.nextRun || null;
      this.runStates.set(jobId, state);
    }

    if (updates.expression) {
      const nextRun = calculateCronNext(updates.expression);
      const state = this.runStates.get(jobId) || {};
      state.nextRun = nextRun;
      job.nextRun = new Date(nextRun).toISOString();
      this.runStates.set(jobId, state);
    }

    // Webhook URL 验证
    if (updates.delivery && updates.delivery.mode === 'webhook' && updates.delivery.url) {
      const urlValidation = normalizeHttpWebhookUrl(updates.delivery.url);
      if (!urlValidation.valid) {
        return { success: false, error: 'Invalid webhook URL: ' + urlValidation.error };
      }
      job.delivery!.url = urlValidation.url!;
    }

    job.updatedAt = Date.now();
    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'updated');
    this.logger.info('[cron] 任务已更新: ' + jobId);
    return { success: true };
  }

  /**
   * 删除定时任务（系统内置任务不可删除）
   */
  deleteJob(jobId: string): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };
    if (job.system) {
      return { success: false, error: '系统内置任务不可删除，只能暂停' };
    }

    this.jobs.delete(jobId);
    this.runStates.delete(jobId);
    this.runLogs.delete(jobId);
    this.jobHandlers.delete(jobId);

    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'deleted');
    this.logger.info('[cron] 任务已删除: ' + jobId);
    return { success: true };
  }

  /** 获取任务配置 */
  getJob(jobId: string): CronJobConfig | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      id: job.id,
      name: job.name,
      ...(job.schedule !== undefined ? { schedule: job.schedule } : {}),
      ...(job.expression !== undefined ? { expression: job.expression } : {}),
      ...(job.prompt !== undefined ? { prompt: job.prompt } : {}),
      ...(job.command !== undefined ? { command: job.command } : {}),
      ...(job.url !== undefined ? { url: job.url } : {}),
      ...(job.taskType !== undefined ? { taskType: job.taskType } : {}),
      ...(job.model !== undefined ? { model: job.model } : {}),
      ...(job.toolName !== undefined ? { toolName: job.toolName } : {}),
      ...(job.toolArgs !== undefined ? { toolArgs: job.toolArgs } : {}),
      enabled: job.enabled,
      ...(job.maxRetries !== undefined ? { maxRetries: job.maxRetries } : {}),
      ...(job.delivery !== undefined ? { delivery: job.delivery } : {}),
      ...(job.failureAlert !== undefined ? { failureAlert: job.failureAlert } : {}),
      ...(job.fallbackModel !== undefined ? { fallbackModel: job.fallbackModel } : {}),
      ...(job.target !== undefined ? { target: job.target } : {}),
      ...(job.dependsOn !== undefined ? { dependsOn: job.dependsOn } : {}),
      ...(job.runOnce !== undefined ? { runOnce: job.runOnce } : {}),
      ...(job.system !== undefined ? { system: job.system } : {}) };
  }

  /** 获取任务详情（含运行状态和日志） */
  readJob(jobId: string): CronJobDetail | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const state = this.runStates.get(jobId) || {};
    const logs = this.runLogs.get(jobId) || [];

    return {
      id: job.id,
      name: job.name,
      ...(job.schedule !== undefined ? { schedule: job.schedule } : {}),
      ...(job.expression !== undefined ? { expression: job.expression } : {}),
      enabled: job.enabled,
      target: job.target || 'main',
      delivery: job.delivery || { mode: 'none' },
      ...(job.longRunning ? { longRunning: job.longRunning } : {}),
      ...(job.taskType ? { taskType: job.taskType } : {}),
      failureAlert: job.failureAlert || null,
      fallbackModel: job.fallbackModel || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastRunAt: state.lastRunAt || null,
      lastResult: state.lastResult || null,
      nextRun: state.nextRun || null,
      consecutiveErrors: state.consecutiveErrors || 0,
      runState: {
        lastRunAt: state.lastRunAt || null,
        lastResult: state.lastResult || null,
        nextRun: state.nextRun || null,
        consecutiveErrors: state.consecutiveErrors || 0,
        lastErrorAt: state.lastErrorAt || null,
        lastFailureAlertAt: state.lastFailureAlertAt || null },
      recentLogs: logs.slice(-10) };
  }

  // ============================================================
  // 公共 API —— 执行控制
  // ============================================================

  /** 启动任务（启用调度） */
  startJob(jobId: string): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };
    job.enabled = true;
    job.updatedAt = Date.now();
    // 重新计算 nextRun
    if (!job.runOnce) {
      const nextRun = calculateNextRun(job);
      if (nextRun) {
        job.nextRun = new Date(nextRun).toISOString();
        const state = this.runStates.get(jobId) || {};
        state.nextRun = nextRun;
        this.runStates.set(jobId, state);
      }
    }
    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'updated');
    return { success: true };
  }

  /** 停止任务（取消调度，保留配置） */
  stopJob(jobId: string): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };
    job.enabled = false;
    job.updatedAt = Date.now();
    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'updated');
    return { success: true };
  }

  /**
   * 切换任务启用状态（移植自 .cjs PUT /cron/toggle 行 36522-36570）
   * - 启用：无 nextRun 时重算（runOnce → now+60s，否则按调度配置计算）
   * - 禁用：清空 nextRun
   */
  toggleJob(jobId: string, enabled: boolean): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    job.enabled = enabled;
    job.updatedAt = Date.now();
    if (enabled) {
      const state = this.runStates.get(jobId) || {};
      if (!state.nextRun && !job.nextRun) {
        if (job.runOnce) {
          const nextAt = Date.now() + 60_000;
          job.nextRun = new Date(nextAt).toISOString();
          state.nextRun = nextAt;
        } else {
          const nextRun = calculateNextRun(job);
          if (nextRun) {
            job.nextRun = new Date(nextRun).toISOString();
            state.nextRun = nextRun;
          }
        }
        this.runStates.set(jobId, state);
      }
    } else {
      job.nextRun = null;
      const state = this.runStates.get(jobId);
      if (state) {
        state.nextRun = null;
        this.runStates.set(jobId, state);
      }
    }
    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'updated');
    this.logger.info(
      '[cron] Job "' + (job.name || jobId) + '" ' + (enabled ? 'enabled' : 'disabled'),
    );
    return { success: true, jobId };
  }

  /** 手动触发执行 */
  async runJob(jobId: string): Promise<OpResult> {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };
    this.logger.info('[cron] 手动触发任务: ' + jobId);
    await this.executeJob(jobId);
    this.dirty = true;
    this.save();
    return { success: true, message: 'Job execution triggered' };
  }

  /** 入队立即执行（设置 nextRun 为当前时间） */
  enqueueRun(jobId: string): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };
    const state = this.runStates.get(jobId) || {};
    state.nextRun = Date.now();
    this.runStates.set(jobId, state);
    this.dirty = true;
    this.save();
    this.logger.info('[cron] 任务已入队立即执行: ' + jobId);
    return { success: true };
  }

  /** 唤醒调度引擎（立即扫描） */
  wake(): OpResult {
    if (!this.running) return { success: false, message: 'Service not running' };
    this.checkJobs();
    this.logger.info('[cron] 调度引擎已唤醒');
    return { success: true };
  }

  // ============================================================
  // 公共 API —— 处理器注册
  // ============================================================

  /**
   * 注册任务执行处理器
   * @param jobId 任务 ID
   * @param handler 处理函数
   */
  registerHandler(jobId: string, handler: JobHandler): OpResult {
    if (typeof handler !== 'function') {
      return { success: false, error: 'Handler must be a function' };
    }
    this.jobHandlers.set(jobId, handler);
    this.logger.info('[cron] 处理器已注册: ' + jobId);
    return { success: true };
  }

  /** 注册按 taskType 的全局处理器（如 'ai' → CronAiExecutorService；同类型重复注册覆盖） */
  registerGlobalHandler(taskType: string, handler: GlobalJobHandler): OpResult {
    if (!taskType || typeof handler !== 'function') {
      return { success: false, error: 'Global handler registration requires taskType and handler function' };
    }
    this.globalHandlers.set(taskType, handler);
    this.logger.info('[cron] 全局处理器已注册: taskType=' + taskType);
    return { success: true };
  }

  /** 注销按 taskType 的全局处理器 */
  unregisterGlobalHandler(taskType: string): OpResult {
    this.globalHandlers.delete(taskType);
    return { success: true };
  }

  /**
   * 长期任务单轮执行后提交状态补丁（AI 执行器解析续排协议后调用）：
   * 更新 progress/round/history → finish 时禁用收尾 → reschedule 时改期 → 持久化广播
   */
  applyLongRunningUpdate(jobId: string, patch: LongRunningPatch): OpResult {
    const job = this.jobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found: ' + jobId };

    // 初始化 longRunning（首轮执行时可能尚未创建）
    if (!job.longRunning) job.longRunning = { round: 0, history: [] };
    const lr = job.longRunning;
    lr.round = (lr.round || 0) + 1;
    if (typeof patch.progress === 'string' && patch.progress) lr.progress = patch.progress;

    // 执行历史环形追加（最多 20 条）
    const history = lr.history || (lr.history = []);
    history.push({
      at: Date.now(),
      outcome: patch.error ? 'error' : 'success',
      ...(patch.status ? { status: patch.status } : {}),
      summary: (patch.summary || '').slice(0, 500) });
    if (history.length > 20) history.splice(0, history.length - 20);

    // 收尾判定：显式 finish / done / 达到 maxRounds
    const maxRounds = lr.maxRounds || 0;
    const reachedMax = maxRounds > 0 && (lr.round || 0) >= maxRounds;
    if (patch.finish || patch.status === 'done' || reachedMax) {
      job.enabled = false;
      job.nextRun = null;
      this.logger.info(
        '[cron] 长期任务 "' + job.name + '" 已收尾: ' +
          (patch.finish ? 'finish' : patch.status === 'done' ? 'done' : '达到最大轮次 ' + maxRounds),
      );
    }

    // 改期判定：reschedule.expression / everyMinutes
    if (patch.reschedule && !patch.finish && job.enabled) {
      const rs = patch.reschedule;
      if (rs.expression && validateCronExpr(rs.expression).valid) {
        job.expression = rs.expression;
        delete job.schedule;
        this.logger.info('[cron] 长期任务 "' + job.name + '" 已改期: ' + rs.expression);
      } else if (rs.everyMinutes && rs.everyMinutes > 0) {
        delete job.expression;
        job.schedule = { kind: 'every', everyMs: Math.round(rs.everyMinutes * 60_000) };
        this.logger.info('[cron] 长期任务 "' + job.name + '" 已改期: 每 ' + rs.everyMinutes + ' 分钟');
      } else {
        this.logger.warn('[cron] 长期任务 "' + job.name + '" 改期被拒绝（无效调度参数）');
      }
    }

    job.updatedAt = Date.now();
    this.dirty = true;
    this.save();
    this.broadcastUpdate(jobId, 'updated');
    return { success: true };
  }

  /** 读取任务完整配置（含 longRunning；供执行器组装上下文与前端详情） */
  getJobInternal(jobId: string): InternalCronJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** 注销任务执行处理器 */
  unregisterHandler(jobId: string): OpResult {
    this.jobHandlers.delete(jobId);
    return { success: true };
  }

  // ============================================================
  // 公共 API —— 状态
  // ============================================================

  /** 获取服务状态 */
  getStatus(): CronStatus {
    let enabledCount = 0;
    for (const job of this.jobs.values()) {
      if (job.enabled) enabledCount++;
    }
    return {
      running: this.running,
      totalJobs: this.jobs.size,
      enabledJobs: enabledCount,
      dataDir: this.dataDir };
  }

  /** 获取任务历史记录 */
  getJobHistory(): Array<{
    jobId: string;
    name: string;
    status: string;
    executedAt: number;
    duration: number;
    taskType: string;
  }> {
    return this.jobHistory.slice(0, MAX_HISTORY);
  }

  /** 获取任务运行日志 */
  getRunLogs(jobId: string): RunLogEntry[] {
    return this.runLogs.get(jobId) || [];
  }
}
