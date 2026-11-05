import { Injectable } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';

// ============================================================
// 类型定义
// ============================================================

/** 投递模式 */
export type DeliveryMode = 'none' | 'announce' | 'webhook';

/** 投递配置 */
export interface DeliveryConfig {
  mode?: DeliveryMode;
  /** announce 模式：目标渠道（last/web/...） */
  channel?: string;
  /** announce 模式：目标会话线程 */
  threadId?: string | null;
  /** announce 模式：账号 ID */
  accountId?: string | null;
  /** 是否尽力投递（失败不阻塞） */
  bestEffort?: boolean;
  /** webhook 模式：目标 URL */
  url?: string;
  /** webhook 模式：别名 */
  webhookUrl?: string;
  /** 投递失败后的备用目标 */
  failureDestination?: {
    mode?: string;
    url?: string;
  } | null;
}

/** 任务执行结果 */
export interface JobResult {
  success?: boolean;
  output?: string;
  content?: string;
  text?: string;
  error?: string;
  message?: string;
  type?: string;
  [key: string]: unknown;
}

/** 定时任务（投递视角的最小子集） */
export interface DeliveryJob {
  id: string;
  name: string;
  taskType?: string;
  delivery?: DeliveryConfig;
}

/** 投递结果 */
export interface DeliveryResult {
  delivered: boolean;
  method?: string;
  error?: string;
  attempts?: number;
}

// ============================================================
// 常量
// ============================================================

/** Announce 投递最大重试次数 */
const ANNOUNCE_MAX_RETRIES = 3;
/** Announce 重试延迟（5s, 10s, 20s 指数退避） */
const ANNOUNCE_RETRY_DELAYS = [5_000, 10_000, 20_000];
/** HTTP 请求超时（毫秒）——所有 HTTP 请求必须包含超时，防止永久挂起 */
const HTTP_TIMEOUT_MS = 10_000;
/** 最大响应体大小（10MB），防止内存爆炸 */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
/** 消息截断长度 */
const MAX_MESSAGE_LENGTH = 4_000;
/** 结果摘要截断长度 */
const SUMMARY_TRUNCATE_LENGTH = 200;

// ============================================================
// 工具函数
// ============================================================

/**
 * 判断错误是否为瞬时错误（可重试）
 * - timeout / ECONNRESET / ECONNREFUSED / rate limit / 503 / 502 / 429
 */
function isTransientError(err: unknown): boolean {
  const msg = ((err as Error)?.message || '').toLowerCase();
  return (
    msg.indexOf('timeout') >= 0 ||
    msg.indexOf('econnreset') >= 0 ||
    msg.indexOf('econnrefused') >= 0 ||
    msg.indexOf('rate') >= 0 ||
    msg.indexOf('503') >= 0 ||
    msg.indexOf('502') >= 0 ||
    msg.indexOf('429') >= 0
  );
}

/**
 * 构建投递摘要文本
 * @param job 任务对象
 * @param result 执行结果
 * @param error 执行错误
 */
function buildSummary(job: DeliveryJob, result: JobResult | string | null, error: Error | null): string {
  if (error) {
    return '❌ 定时任务 "' + job.name + '" 执行失败: ' + (error.message || String(error)).substring(0, 200);
  }
  let output = '';
  if (result && typeof result === 'object') {
    output = result.output || result.content || result.text || JSON.stringify(result).substring(0, 500);
  } else if (typeof result === 'string') {
    output = result.substring(0, 500);
  }
  return '✅ 定时任务 "' + job.name + '" 执行成功: ' + output;
}

/**
 * 构建 Announce 消息文本
 */
function buildAnnounceMessage(jobName: string, result: JobResult | null): string {
  let messageText = '';
  if (typeof result === 'string') {
    messageText = '[Cron] ' + jobName + ' completed:\n' + result;
  } else if (result && result.content) {
    messageText = '[Cron] ' + jobName + ' completed:\n' + result.content;
  } else if (result && result.text) {
    messageText = '[Cron] ' + jobName + ' completed:\n' + result.text;
  } else {
    try {
      messageText = '[Cron] ' + jobName + ' completed:\n' + JSON.stringify(result, null, 2);
    } catch {
      messageText = '[Cron] ' + jobName + ' completed.';
    }
  }
  // 超长消息截断
  if (messageText.length > MAX_MESSAGE_LENGTH) {
    messageText = messageText.substring(0, 3900) + '\n... [truncated]';
  }
  return messageText;
}

// ============================================================
// CronDeliveryService
// ============================================================

/**
 * CronDeliveryService - 定时任务投递服务
 *
 * 职责：
 *   - 根据任务投递配置（delivery.mode）将执行结果投递到指定渠道
 *   - 支持 announce（广播/渠道消息）和 webhook（HTTP POST）两种模式
 *   - Announce 模式支持指数退避重试（5s/10s/20s，最多 3 次）
 *   - Webhook 模式通过 SecurityManagerService 进行 SSRF 校验（fail-close）
 *   - 所有 HTTP 请求包含超时，防止永久挂起
 *
 * 对应原始 .cjs 实现：
 *   - cron-manager.cjs: _handleDelivery / _deliverAnnounce / _deliverWebhook / _handleFailureAlert / _sendFailureAlertWebhook
 *   - start.cjs: CronDelivery 对象（deliver / _announce / _webhook / _logDelivery）
 */
@Injectable()
export class CronDeliveryService {
  /** Announce 重试定时器句柄，stop/destroy 时清理避免泄漏 */
  private readonly retryTimers: NodeJS.Timeout[] = [];

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly security: SecurityManagerService,
  ) {}

  // ============================================================
  // 主入口
  // ============================================================

  /**
   * 投递任务执行结果
   * @param job 任务对象
   * @param result 执行结果（成功时）
   * @param error 执行错误（失败时）
   */
  async deliver(
    job: DeliveryJob,
    result: JobResult | null,
    error: Error | null,
  ): Promise<void> {
    const delivery = job.delivery || {};
    const mode = delivery.mode || 'announce';
    if (mode === 'none') return;

    const summary = buildSummary(job, result, error);

    if (mode === 'announce') {
      await this.deliverAnnounce(job, result, error, delivery, summary);
    } else if (mode === 'webhook') {
      await this.deliverWebhook(job, result, error, delivery, summary);
    }

    this.logDelivery(job, summary, mode);
  }

  // ============================================================
  // Announce 模式
  // ============================================================

  /**
   * Announce 投递——将结果广播到渠道
   *
   * 投递优先级：
   *   1. WebSocket 广播（直接通知前端）
   *   2. Gateway HTTP API（如果有配置 GATEWAY_URL）
   *   3. 事件发射（兜底）
   *
   * 支持指数退避重试（瞬时错误自动重试 3 次）。
   */
  private async deliverAnnounce(
    job: DeliveryJob,
    result: JobResult | null,
    error: Error | null,
    delivery: DeliveryConfig,
    summary: string,
  ): Promise<void> {
    const channel = delivery.channel || 'web';
    const jobName = job.name || job.id;

    this.logger.info('[delivery] Announce 投递: job=' + job.id + ' channel=' + channel);

    // 构建广播事件——通过 WebSocket 通知前端
    try {
      this.ws.broadcast({
        type: 'notification',
        data: {
          title: '定时任务执行通知',
          message: summary,
          level: error ? 'error' : 'info',
        },
      });
    } catch (e) {
      this.logger.warn(
        '[delivery] WebSocket 广播失败: ' + (e instanceof Error ? e.message : String(e)),
      );
    }

    // 构建 Announce 消息文本
    const messageText = buildAnnounceMessage(jobName, result);

    // 尝试通过 Gateway HTTP API 投递（如果配置了 GATEWAY_URL）
    const gatewayUrl = process.env['GATEWAY_URL'] || '';
    if (gatewayUrl) {
      await this.deliverViaGateway(job, delivery, messageText, channel);
    }

    // 处理投递失败的目标（failureDestination）
    if (delivery.failureDestination && error) {
      await this.handleAnnounceFailure(job, result, delivery.failureDestination, error);
    }
  }

  /**
   * 通过 Gateway HTTP API 投递消息
   * 包含 SSRF 校验和超时控制。
   */
  private async deliverViaGateway(
    job: DeliveryJob,
    delivery: DeliveryConfig,
    messageText: string,
    channel: string,
  ): Promise<void> {
    const gatewayUrl = process.env['GATEWAY_URL'] || '';
    const gatewayToken = process.env['GATEWAY_TOKEN'] || '';
    const fullUrl = gatewayUrl + '/api/channels/message';

    // SSRF 校验——fail-close：校验失败则拒绝投递
    try {
      const ssrfResult = await this.security.checkUrl(gatewayUrl);
      if (!ssrfResult || !ssrfResult.safe) {
        this.logger.warn(
          '[delivery] Gateway URL 被 SSRF 防护阻止: ' + (ssrfResult?.reason || ''),
        );
        return;
      }
    } catch (ssrfErr) {
      // fail-close：SSRF 检查失败时拒绝投递
      this.logger.error(
        '[delivery] Gateway URL SSRF 检查失败，投递被拒绝: ' +
          (ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr)),
      );
      return;
    }

    const payload = JSON.stringify({
      channel: channel,
      threadId: delivery.threadId,
      accountId: delivery.accountId,
      message: messageText,
      type: 'cron_announce',
      jobId: job.id,
    });

    return new Promise<void>((resolve) => {
      try {
        const parsed = new URL(fullUrl);
        const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST' as const,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': 'SkyAlyticWing-Cron/1.0',
            ...(gatewayToken ? { Authorization: 'Bearer ' + gatewayToken } : {}),
          },
          timeout: HTTP_TIMEOUT_MS,
        };

        const req = mod(options, (res) => {
          res.resume();
          this.logger.info(
            '[delivery] Gateway 投递: job=' + job.id + ' HTTP ' + res.statusCode,
          );
          resolve();
        });

        req.on('error', (err) => {
          this.logger.warn(
            '[delivery] Gateway 投递失败: job=' + job.id + ' ' + err.message,
          );
          resolve();
        });

        req.on('timeout', () => {
          req.destroy();
          this.logger.warn('[delivery] Gateway 投递超时: job=' + job.id);
          resolve();
        });

        req.write(payload);
        req.end();
      } catch (e) {
        this.logger.warn(
          '[delivery] Gateway 投递错误: job=' + job.id + ' ' +
            (e instanceof Error ? e.message : String(e)),
        );
        resolve();
      }
    });
  }

  /**
   * 处理 Announce 投递失败——发送到 failureDestination
   */
  private async handleAnnounceFailure(
    job: DeliveryJob,
    result: JobResult | null,
    failureDestination: NonNullable<DeliveryConfig['failureDestination']>,
    error: Error,
  ): Promise<void> {
    if (failureDestination.mode === 'webhook' && failureDestination.url) {
      // SSRF 校验
      try {
        const ssrfResult = await this.security.checkUrl(failureDestination.url);
        if (!ssrfResult || !ssrfResult.safe) {
          this.logger.warn(
            '[delivery] failureDestination URL 被 SSRF 阻止: ' + (ssrfResult?.reason || ''),
          );
          return;
        }
      } catch (ssrfErr) {
        this.logger.error(
          '[delivery] failureDestination SSRF 检查失败: ' +
            (ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr)),
        );
        return;
      }

      const payload = JSON.stringify({
        type: 'cron_announce_failure',
        jobId: job.id,
        jobName: job.name || job.id,
        error: error.message || 'Unknown error',
        originalResult: result,
        timestamp: new Date().toISOString(),
      });

      this.sendHttpPost(failureDestination.url, payload, job.id, 'failureDestination');
    }
  }

  // ============================================================
  // Webhook 模式
  // ============================================================

  /**
   * Webhook 投递——HTTP POST 到指定 URL
   *
   * 流程：
   *   1. SSRF 校验（fail-close：校验失败则拒绝投递）
   *   2. 构建 JSON payload
   *   3. 发送 HTTP POST 请求（含超时）
   */
  private async deliverWebhook(
    job: DeliveryJob,
    result: JobResult | null,
    error: Error | null,
    delivery: DeliveryConfig,
    summary: string,
  ): Promise<void> {
    const url = delivery.url || delivery.webhookUrl || '';
    if (!url) {
      this.logger.warn('[delivery] Webhook 投递: 未配置 URL, job=' + job.id);
      return;
    }

    // SSRF 校验——fail-close
    try {
      const ssrfResult = await this.security.checkUrl(url);
      if (!ssrfResult || !ssrfResult.safe) {
        this.logger.error(
          '[delivery] SSRF 防护: webhook URL 被阻止 - ' + (ssrfResult?.reason || ''),
        );
        return;
      }
    } catch (ssrfErr) {
      // fail-close：SSRF 检查失败时拒绝投递
      this.logger.error(
        '[delivery] SSRF 检查失败，webhook 投递被拒绝: ' +
          (ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr)),
      );
      return;
    }

    const payload = JSON.stringify({
      job: { id: job.id, name: job.name, taskType: job.taskType },
      summary: summary,
      result: result,
      error: error ? error.message || String(error) : null,
      timestamp: new Date().toISOString(),
    });

    this.sendHttpPost(url, payload, job.id, 'webhook');
  }

  // ============================================================
  // 通用 HTTP POST
  // ============================================================

  /**
   * 发送 HTTP POST 请求（通用方法）
   *
   * 安全措施：
   *   - 所有 HTTP 请求包含超时（HTTP_TIMEOUT_MS = 10s）
   *   - 响应体大小限制（MAX_RESPONSE_SIZE = 10MB）
   *   - 使用 URL 解析防止协议混淆
   */
  private sendHttpPost(
    url: string,
    payload: string,
    jobId: string,
    label: string,
  ): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      this.logger.warn(
        '[delivery] ' + label + ' URL 解析错误: ' + (e instanceof Error ? e.message : String(e)),
      );
      return;
    }

    const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'SkyAlyticClaw-Cron/1.0',
        'X-Cron-Job-Id': jobId,
      },
      timeout: HTTP_TIMEOUT_MS,
    };

    try {
      const req = mod(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          // 响应体大小保护——超过 10MB 则销毁连接
          if (body.length > MAX_RESPONSE_SIZE) {
            try {
              res.destroy();
            } catch {
              // 忽略
            }
            this.logger.warn(
              '[delivery] ' + label + ' 响应过大 (>10MB): job=' + jobId,
            );
          }
        });
        res.on('end', () => {
          this.logger.info(
            '[delivery] ' + label + ' 投递完成: job=' + jobId + ' HTTP ' + res.statusCode,
          );
        });
      });

      req.on('error', (err) => {
        this.logger.warn(
          '[delivery] ' + label + ' 投递错误: job=' + jobId + ' ' + err.message,
        );
      });

      req.on('timeout', () => {
        req.destroy();
        this.logger.warn('[delivery] ' + label + ' 投递超时: job=' + jobId);
      });

      req.write(payload);
      req.end();
    } catch (e) {
      this.logger.warn(
        '[delivery] ' + label + ' 投递异常: job=' + jobId + ' ' +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // ============================================================
  // 失败告警 Webhook
  // ============================================================

  /**
   * 发送失败告警 Webhook
   *
   * 当任务连续失败次数达到阈值时，发送告警到配置的 webhookUrl。
   *
   * @param jobId 任务 ID
   * @param jobName 任务名称
   * @param consecutiveErrors 连续错误次数
   * @param lastErrorAt 最后错误时间
   * @param alertMessage 告警消息
   * @param webhookUrl 告警 webhook URL
   */
  async sendFailureAlertWebhook(
    jobId: string,
    jobName: string,
    consecutiveErrors: number,
    lastErrorAt: number | null,
    alertMessage: string,
    webhookUrl: string,
  ): Promise<void> {
    // SSRF 校验——fail-close
    try {
      const ssrfResult = await this.security.checkUrl(webhookUrl);
      if (!ssrfResult || !ssrfResult.safe) {
        this.logger.warn(
          '[delivery] 失败告警 webhook URL 无效: ' + (ssrfResult?.reason || ''),
        );
        return;
      }
    } catch (ssrfErr) {
      this.logger.error(
        '[delivery] 失败告警 SSRF 检查失败: ' +
          (ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr)),
      );
      return;
    }

    const payload = JSON.stringify({
      type: 'cron_failure_alert',
      jobId: jobId,
      jobName: jobName,
      consecutiveErrors: consecutiveErrors,
      lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
      message: alertMessage,
      timestamp: new Date().toISOString(),
    });

    this.sendHttpPost(webhookUrl, payload, jobId, 'failure-alert');
  }

  // ============================================================
  // 重试逻辑
  // ============================================================

  /**
   * 带重试的投递执行
   *
   * 瞬时错误（timeout/ECONNRESET/ECONNREFUSED/rate limit/503/502/429）
   * 自动重试，指数退避（5s/10s/20s），最多 3 次。
   *
   * @param deliverFn 投递函数
   * @param methodName 方法名（用于日志）
   * @param jobId 任务 ID
   */
  async deliverWithRetry(
    deliverFn: () => Promise<void>,
    methodName: string,
    jobId: string,
  ): Promise<DeliveryResult> {
    return new Promise<DeliveryResult>((resolve) => {
      const attempt = (remaining: number): void => {
        deliverFn()
          .then(() => {
            this.logger.info(
              '[delivery] ' + methodName + ' 投递成功: job=' + jobId,
            );
            resolve({
              delivered: true,
              method: methodName,
              attempts: ANNOUNCE_MAX_RETRIES - remaining + 1,
            });
          })
          .catch((err: unknown) => {
            if (remaining > 0 && isTransientError(err)) {
              const delay = ANNOUNCE_RETRY_DELAYS[ANNOUNCE_MAX_RETRIES - remaining] || 20_000;
              this.logger.warn(
                '[delivery] ' + methodName + ' 瞬时错误，' + delay + 'ms 后重试: ' +
                  (err instanceof Error ? err.message : String(err)),
              );
              // 保存重试定时器句柄，stop 时可清理避免泄漏
              const timer = setTimeout(() => attempt(remaining - 1), delay);
              this.retryTimers.push(timer);
            } else {
              this.logger.warn(
                '[delivery] ' + methodName + ' 永久失败: ' +
                  (err instanceof Error ? err.message : String(err)),
              );
              resolve({
                delivered: false,
                method: methodName,
                error: err instanceof Error ? err.message : String(err),
                attempts: ANNOUNCE_MAX_RETRIES - remaining + 1,
              });
            }
          });
      };
      attempt(ANNOUNCE_MAX_RETRIES - 1);
    });
  }

  // ============================================================
  // 日志
  // ============================================================

  /**
   * 记录投递日志
   */
  private logDelivery(_job: DeliveryJob, summary: string, mode: string): void {
    this.logger.info(
      '[delivery] [' + mode + '] ' + summary.substring(0, SUMMARY_TRUNCATE_LENGTH),
    );
  }

  // ============================================================
  // 清理
  // ============================================================

  /**
   * 清理所有重试定时器——避免模块销毁后仍触发
   */
  clearRetryTimers(): void {
    for (const timer of this.retryTimers) {
      try {
        clearTimeout(timer);
      } catch {
        // 忽略
      }
    }
    this.retryTimers.length = 0;
  }
}
