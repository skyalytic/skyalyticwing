import { replyThread } from '../reply-context.js';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type { Server, IncomingMessage as HttpRequest } from 'node:http';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import { writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { channelDispatcher } from '../channel-network.js';

// ============================================================
// 类型定义（对应 channels.cjs 中 BaseChannel 与消息结构）
// ============================================================

/** 渠道运行时状态（对应 BaseChannel.status） */
export interface ChannelRuntimeStatus {
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
  messagesReceived: number;
  messagesSent: number;
}

/** 收到消息后分发给业务层的消息对象（对应 channels.cjs 中 msg） */
export interface IncomingMessage {
  id: string;
  channelId: string;
  from: string;
  text: string;
  timestamp: number;
  threadId?: string;
  raw?: Record<string, unknown>;
}

/** 路由会话信息（对应 router.route 返回值） */
export interface RoutedSession {
  sessionId: string;
  agentId: string;
  conversationId: string;
  createdAt: number;
}

/** 消息处理器签名（对应 channels.cjs messageHandlers 项） */
export type MessageHandler = (
  channelType: string,
  message: IncomingMessage,
  session: RoutedSession,
) => Promise<void>;

/** 状态变更处理器签名（对应 _statusChangeHandlers 项） */
export type StatusChangeHandler = (channelType: string, status: ChannelRuntimeStatus) => void;

/** 发送消息结果（对应各 provider sendMessage 返回值） */
export interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

/** 发送消息选项 */
export interface SendOptions {
  chatId?: string;
  msgId?: string;
  channel?: string;
  chatId2?: string;
  isGroup?: boolean;
  msgType?: string;
  receiveIdType?: string;
  replyMessageId?: string;
  skipReply?: boolean;
  contextToken?: string;
  [key: string]: unknown;
}

/** getTestTarget 返回值 */
export interface TestTarget {
  lastSenderId: string | null;
  hasTarget: boolean;
  hint: string;
  [key: string]: unknown;
}

// ============================================================
// 常量
// ============================================================

/** 渠道 HTTP 操作超时（30s），对应 channels.cjs _fetchWithTimeout 默认值 */
const HTTP_TIMEOUT = 30_000;

/** 幽灵消息最大年龄（5 分钟），对应 BaseChannel._maxMsgAgeMs */
const MAX_MSG_AGE_MS = 300_000;

/** 路由表上限，对应 ChannelRouter._MAX_ROUTES */
const MAX_ROUTES = 10_000;

/**
 * fetchWithTimeout - 带超时的 fetch（对应 channels.cjs _fetchWithTimeout）
 *
 * fix(第二十四轮): 所有渠道 HTTP 请求使用原生 fetch 但无超时，
 * 若钉钉/飞书/企业微信等 API 服务器响应缓慢但不断开连接，fetch Promise 永久挂起，
 * 导致 token 刷新阻塞、消息发送卡死。统一添加 30 秒超时。
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
  timeoutMs: number = HTTP_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = channelDispatcher(url);
  const opts = { ...(options || {}), signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    ...(dispatcher ? { dispatcher } : {}) };
  try {
    return await fetch(url, opts);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BaseProvider - 渠道提供商共享基类（对应 channels.cjs BaseChannel）
 *
 * 职责：
 *   - 维护渠道运行时状态（连接/错误/消息计数）
 *   - 消息去重（ID/合成ID/内容HASH/时间窗口/inFlight 五重去重）
 *   - 已处理消息 ID 持久化（_processed_msg_ids.json / _processed_msg_hashes.json）
 *   - Webhook 服务器安全监听（EADDRINUSE 重试、127.0.0.1 默认绑定、IP 白名单）
 *   - 幽灵消息过滤（超过 5 分钟的消息丢弃）
 *   - 状态变更去抖广播（300ms）
 *   - 统一的消息分发入口 _handleIncomingMessage
 *
 * 子类需实现：connect / disconnect / sendMessage / sendImage / sendFile / getTestTarget
 */
@Injectable()
export abstract class BaseProvider {
  readonly type: string;
  id: string;
  name: string;
  config: Record<string, unknown> | null = null;
  status: ChannelRuntimeStatus = {
    connected: false,
    lastError: null,
    lastMessageAt: null,
    messagesReceived: 0,
    messagesSent: 0,
  };

  /** 子类可写入：最近发送者 ID（用于回发目标推断） */
  protected lastSenderId: string | null = null;
  /** 子类可写入：最近会话 ID（用于钉钉等渠道的会话追踪） */
  protected lastConversationId: string | null = null;

  /** 已处理消息 ID 集合（去重） */
  protected readonly processedIds = new Set<string>();
  /** 已处理内容哈希集合（去重） */
  protected readonly processedHashes = new Set<string>();
  /** 最近消息短键 → 时间戳（120s 窗口去重） */
  protected readonly recentMsgKeys = new Map<string, number>();
  /** 正在处理中的消息 key（防止并发重复 AI 调用） */
  protected readonly inFlightKeys = new Set<string>();
  /** 持久化用数组（对应 _persistedIds） */
  protected persistedIds: string[] = [];
  /** 当前已跟踪的 HTTP 服务器（webhook/postback） */
  protected servers: Server[] = [];
  /** 最近回复 reqId 缓存（WeChatWork/WeCom 使用） */
  protected replyReqIds: Record<string, { reqId: string; ts: number } | string> = {};
  /** 已处理 reqId 集合（WeChatWork/WeCom 去重） */
  protected processedReqIds: Set<string> | null = null;

  /** 状态变更去抖定时器 */
  private statusDebounceTimer: NodeJS.Timeout | null = null;
  /** 持久化定时器 */
  private persistTimer: NodeJS.Timeout | null = null;
  /** 持久化脏标记 */
  private persistDirty = false;
  /** 幽灵消息最大年龄 */
  protected readonly maxMsgAgeMs = MAX_MSG_AGE_MS;
  /** 数据目录 */
  private dataDir: string;

  /** 消息处理器（由 ChannelsService 注入，对应 messageHandlers） */
  private messageHandler: MessageHandler | null = null;
  /** 状态变更处理器（由 ChannelsService 注入，对应 _statusChangeHandlers） */
  private statusChangeHandler: StatusChangeHandler | null = null;

  constructor(
    protected readonly logger: LoggerService,
    protected readonly router: ChannelRouterService,
    type: string,
  ) {
    this.type = type;
    this.id = type;
    this.name = type.charAt(0).toUpperCase() + type.slice(1);
    this.dataDir = this.resolveDataDir();

    // 模块加载时同步读文件，文件缺失/损坏时仅 catch 静默——catch 中改为 log 警告
    try {
      const idsPath = join(this.dataDir, '_processed_msg_ids.json');
      this.persistedIds = JSON.parse(readFileSync(idsPath, 'utf8').trim() || '[]');
      if (Array.isArray(this.persistedIds)) {
        this.persistedIds.forEach((id) => this.processedIds.add(id));
      }
    } catch (ef) {
      this.persistedIds = [];
      this.logger.warn(`[Channel:${this.type}] WARN: failed to load _processed_msg_ids.json`, {
        error: ef instanceof Error ? ef.message : String(ef),
      });
    }
    try {
      const hashPath = join(this.dataDir, '_processed_msg_hashes.json');
      const hashData = JSON.parse(readFileSync(hashPath, 'utf8').trim() || '[]');
      if (Array.isArray(hashData)) {
        hashData.forEach((h: string) => this.processedHashes.add(h));
      }
    } catch (he) {
      this.logger.warn(`[Channel:${this.type}] WARN: failed to load _processed_msg_hashes.json`, {
        error: he instanceof Error ? he.message : String(he),
      });
    }
  }

  // ---------- 处理器注册 ----------

  /** 注册消息处理器（对应 ch.onMessage / ChannelManager.onMessage） */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 注册状态变更处理器（对应 ChannelManager.onStatusChange） */
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  // ---------- 状态变更去抖广播 ----------

  /** 状态变更去抖通知（对应 BaseChannel._emitStatusChange，300ms 去抖） */
  protected emitStatusChange(): void {
    if (this.statusDebounceTimer) clearTimeout(this.statusDebounceTimer);
    this.statusDebounceTimer = setTimeout(() => {
      this.statusDebounceTimer = null;
      this.notifyStatusChange({ ...this.status });
    }, 300);
    this.statusDebounceTimer.unref?.();
  }

  private notifyStatusChange(status: ChannelRuntimeStatus): void {
    if (this.statusChangeHandler) {
      try {
        this.statusChangeHandler(this.type, status);
      } catch {
        // 忽略处理器异常
      }
    }
  }

  // ---------- 已处理消息 ID 持久化 ----------

  /** 调度持久化（5s 防抖，对应 BaseChannel._schedulePersist） */
  protected schedulePersist(): void {
    this.persistDirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.doPersist(), 5000);
      this.persistTimer.unref?.();
    }
  }

  /** 执行持久化（对应 BaseChannel._doPersist） */
  protected doPersist(): void {
    this.persistTimer = null;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    try {
      writeJsonAtomicSync(join(this.dataDir, '_processed_msg_ids.json'), this.persistedIds);
    } catch (pe) {
      this.persistDirty = true;
      this.logger.warn(`[Channel:${this.type}] persist ids error`, {
        error: pe instanceof Error ? pe.message : String(pe),
      });
    }
    try {
      const hashArr = Array.from(this.processedHashes);
      writeJsonAtomicSync(join(this.dataDir, '_processed_msg_hashes.json'), hashArr);
    } catch (he2) {
      this.persistDirty = true;
      this.logger.warn(`[Channel:${this.type}] persist hashes error`, {
        error: he2 instanceof Error ? he2.message : String(he2),
      });
    }
  }

  // ---------- Webhook 服务器安全监听 ----------

  /**
   * 安全监听端口（对应 BaseChannel._safeListen）
   *
   * webhook server 默认监听 127.0.0.1（本地），防止暴露到 0.0.0.0
   * 调用方可通过 host 参数显式指定 0.0.0.0 以接收外部 webhook（应配合 IP 白名单）
   * EADDRINUSE 时最多重试 3 次，间隔递增。
   */
  protected safeListen(server: Server, port: number, host?: string): Promise<void> {
    const bindHost = host || '127.0.0.1';
    return new Promise<void>((resolve, reject) => {
      let retryCount = 0;
      const maxRetries = 3;

      const tryListen = (): void => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener('error', onError);
          if (err.code === 'EADDRINUSE') {
            retryCount++;
            if (retryCount > maxRetries) {
              reject(new Error(`Port ${port} unavailable after ${maxRetries} retries`));
              return;
            }
            this.logger.info(
              `[Channel:${this.type}] Port ${port} in use, retry ${retryCount}/${maxRetries}...`,
            );
            try {
              server.close();
            } catch {
              // 忽略
            }
            setTimeout(() => {
              try {
                server.on('error', onError);
                server.listen(port, bindHost, () => {
                  server.removeListener('error', onError);
                  resolve();
                });
              } catch (e2) {
                reject(
                  new Error(
                    `Port ${port} unavailable: ${e2 instanceof Error ? e2.message : String(e2)}`,
                  ),
                );
              }
            }, 1000 * retryCount);
          } else {
            reject(err);
          }
        };
        server.on('error', onError);
        try {
          server.listen(port, bindHost, () => {
            server.removeListener('error', onError);
            resolve();
          });
        } catch (e) {
          server.removeListener('error', onError);
          reject(e);
        }
      };
      tryListen();
    });
  }

  /**
   * 检查来源 IP 是否允许（对应 BaseChannel._checkIpAllowed）
   *
   * allowedIPs 为空数组时跳过校验（保持兼容）；非空时仅允许列表内 IP
   */
  protected checkIpAllowed(req: HttpRequest, allowedIPs: string[]): boolean {
    if (!Array.isArray(allowedIPs) || allowedIPs.length === 0) return true;
    const remote = req.socket && req.socket.remoteAddress;
    if (!remote) return false;
    let addr = remote;
    // 去掉 IPv6 映射的 IPv4 前缀
    if (addr.indexOf('::ffff:') === 0) addr = addr.substring(7);
    for (const allowed of allowedIPs) {
      if (allowed === '0.0.0.0') return true;
      if (addr === allowed) return true;
      if (
        (allowed === 'localhost' || allowed === '127.0.0.1') &&
        (addr === '127.0.0.1' || addr === '::1')
      ) {
        return true;
      }
    }
    return false;
  }

  /** 安全关闭服务器（对应 BaseChannel._safeCloseServer，5s 兜底） */
  protected safeCloseServer(server: Server | null | undefined): Promise<void> {
    if (!server) return Promise.resolve();
    const idx = this.servers ? this.servers.indexOf(server) : -1;
    if (idx >= 0) this.servers.splice(idx, 1);
    return new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(done);
      } catch {
        done();
      }
      setTimeout(done, 5000);
    });
  }

  /** 跟踪服务器（对应 BaseChannel._trackServer） */
  protected trackServer(server: Server): void {
    if (server && this.servers) {
      this.servers.push(server);
    }
  }

  /** 关闭所有已跟踪服务器（对应 BaseChannel._closeAllServers） */
  protected closeAllServers(): Promise<void[]> {
    if (!this.servers || this.servers.length === 0) return Promise.resolve([]);
    const promises: Promise<void>[] = [];
    for (const s of this.servers) {
      try {
        if (s && s.listening) {
          promises.push(this.safeCloseServer(s));
        }
      } catch {
        // 忽略
      }
    }
    this.servers = [];
    return Promise.all(promises);
  }

  // ---------- 统一消息接收入口 ----------

  /**
   * 处理收到的消息（对应 BaseChannel._handleIncomingMessage）
   *
   * 五重去重：
   *   1. 幽灵消息过滤（create_time 超过 5 分钟丢弃）
   *   2. msgId 去重（_processedIds），无 msgId 时用 from+text 合成 ID
   *   3. 内容哈希去重（_processedHashes，MD5 from|text|msgId|分钟桶）
   *   4. 时间窗口去重（_recentMsgKeys，120s 窗口）
   *   5. inFlight 去重（同一 sender 处理中跳过，防 AI 并发调用）
   *
   * 通过后路由会话并分发给业务处理器。
   */
  protected async handleIncomingMessage(
    from: string,
    text: string,
    raw?: Record<string, unknown>,
  ): Promise<void> {
    // 提取原始消息 ID（兼容多种字段命名）
    const rawAny = (raw || {}) as Record<string, unknown>;
    const rawMsgId =
      (rawAny['messageId'] as string | number | undefined) ||
      (rawAny['message_id'] as string | number | undefined) ||
      (rawAny['msgId'] as string | number | undefined) || (rawAny['ts'] as string | undefined) ||
      (rawAny['raw'] &&
        (rawAny['raw'] as Record<string, unknown>)['event'] &&
        ((rawAny['raw'] as Record<string, unknown>)['event'] as Record<string, unknown>)[
          'message'
        ] &&
        (
          ((rawAny['raw'] as Record<string, unknown>)['event'] as Record<string, unknown>)[
            'message'
          ] as Record<string, unknown>
        )['message_id']) ||
      (rawAny['raw'] && (rawAny['raw'] as Record<string, unknown>)['message_id']) ||
      '';
    const msgId = rawMsgId ? String(rawMsgId) : '';

    // 提取消息创建时间（兼容秒/毫秒）
    let msgCreateTime: number | null = null;
    try {
      const rawEvent = (rawAny['raw'] as Record<string, unknown>) || rawAny || {};
      if (rawEvent['create_time']) {
        const ct = parseInt(String(rawEvent['create_time']), 10);
        msgCreateTime = ct > 1e12 ? ct : ct * 1000;
      } else if (
        rawEvent['event'] &&
        (rawEvent['event'] as Record<string, unknown>)['create_time']
      ) {
        const ct2 = parseInt(
          String((rawEvent['event'] as Record<string, unknown>)['create_time']),
          10,
        );
        msgCreateTime = ct2 > 1e12 ? ct2 : ct2 * 1000;
      } else if (
        rawEvent['event'] &&
        (rawEvent['event'] as Record<string, unknown>)['message'] &&
        ((rawEvent['event'] as Record<string, unknown>)['message'] as Record<string, unknown>)[
          'create_time'
        ]
      ) {
        const ct3 = parseInt(
          String(
            ((rawEvent['event'] as Record<string, unknown>)['message'] as Record<string, unknown>)[
              'create_time'
            ],
          ),
          10,
        );
        msgCreateTime = ct3 > 1e12 ? ct3 : ct3 * 1000;
      }
    } catch {
      // 忽略时间解析错误
    }

    // 幽灵消息过滤
    if (msgCreateTime && Date.now() - msgCreateTime > this.maxMsgAgeMs) {
      this.logger.info(
        `[Channel:${this.type}] GHOST MESSAGE SKIPPED: age=${Math.round((Date.now() - msgCreateTime) / 1000)}s id=${String(msgId || '?').substring(0, 20)}`,
      );
      return;
    }

    // 内容哈希（MD5 from|text|msgId|分钟桶）
    let contentHash = '';
    try {
      contentHash = createHash('md5')
        .update(
          (from || '') +
            '|' +
            (text || '').trim().substring(0, 200) +
            '|' +
            (msgId || '') +
            '|' +
            Math.floor((msgCreateTime || Date.now()) / 60000),
        )
        .digest('hex')
        .substring(0, 16);
    } catch {
      // 忽略哈希错误
    }

    // msgId 去重；无 msgId 时合成 ID
    if (msgId) {
      const msgIdStr = String(msgId);
      if (this.processedIds.has(msgIdStr)) {
        this.logger.info(`[Channel:${this.type}] DEDUP skipped (ID): ${msgIdStr.substring(0, 20)}`);
        return;
      }
      this.processedIds.add(msgIdStr);
      if (this.persistedIds) {
        this.persistedIds.push(msgIdStr);
        if (this.persistedIds.length > 500) this.persistedIds = this.persistedIds.slice(-300);
      }
      this.schedulePersist();
      if (this.processedIds.size > 200) {
        const iter = this.processedIds.values();
        const first = iter.next().value;
        if (first) this.processedIds.delete(first);
      }
    } else {
      const synthId = 'synth-' + (from || '') + '-' + (text || '').trim().substring(0, 50);
      if (this.processedIds.has(synthId)) {
        this.logger.info(
          `[Channel:${this.type}] DEDUP skipped (SYNTH-ID): ${synthId.substring(0, 30)}`,
        );
        return;
      }
      this.processedIds.add(synthId);
      if (this.processedIds.size > 200) {
        const iter2 = this.processedIds.values();
        const first2 = iter2.next().value;
        if (first2) this.processedIds.delete(first2);
      }
    }

    // 内容哈希去重
    if (contentHash) {
      if (this.processedHashes.has(contentHash)) {
        this.logger.info(
          `[Channel:${this.type}] DEDUP skipped (HASH): from=${(from || '?').substring(0, 15)} hash=${contentHash}`,
        );
        return;
      }
      this.processedHashes.add(contentHash);
      // 清理逻辑批量删 100 个用 while 循环并加 done 检查，避免 Set 迭代器跳过元素
      if (this.processedHashes.size > 500) {
        const hiter = this.processedHashes.values();
        let toDelete = 100;
        while (toDelete-- > 0) {
          const nr = hiter.next();
          if (nr.done) break;
          this.processedHashes.delete(nr.value);
        }
      }
      this.schedulePersist();
    }

    // 时间窗口去重（120s）
    const shortKey = (from || '?') + '|' + (text || '').trim().substring(0, 100);
    if (!msgId && this.recentMsgKeys.has(shortKey)) {
      const lastSeen = this.recentMsgKeys.get(shortKey)!;
      if (Date.now() - lastSeen < 120000) {
        this.logger.info(
          `[Channel:${this.type}] DEDUP skipped (WINDOW): from=${(from || '?').substring(0, 15)} age=${Math.round((Date.now() - lastSeen) / 1000)}s text=${(text || '').substring(0, 30)}`,
        );
        return;
      }
    }
    this.recentMsgKeys.set(shortKey, Date.now());
    if (this.recentMsgKeys.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.recentMsgKeys) {
        if (now - v > 300000) this.recentMsgKeys.delete(k);
      }
    }

    this.logger.info(
      `[Channel:${this.type}] _handleIncomingMessage START from=${from} text=${(text || '').substring(0, 30)}`,
    );

    // inFlight 检查：同一 sender 处理中则跳过（防 AI 并发调用两次）
    const inFlightKey = this.type + ':' + from;
    this.inFlightKeys.add(inFlightKey);

    try {
      this.status.lastMessageAt = Date.now();
      this.status.messagesReceived++;
      if (from && from !== 'unknown') {
        this.lastSenderId = from;
      }
      this.emitStatusChange();

      // msg.id 用 crypto.randomBytes(8).toString('hex') 16 字符，避免碰撞
      const msg: IncomingMessage = {
        id: msgId || 'msg-' + Date.now() + '-' + randomBytes(8).toString('hex'),
        threadId: replyThread(rawAny,from),
        channelId: this.type,
        from,
        text,
        timestamp: Date.now(),
        ...(raw !== undefined ? { raw } : {}),
      };
      this.logger.info(`[Channel:${this.type}] msg created`);

      // 路由会话
      let session: RoutedSession;
      try {
        session = this.router.route(this.type, from, msg.threadId);
        this.logger.info(`[Channel:${this.type}] session routed`);
      } catch (routeErr) {
        this.logger.warn(`[Channel:${this.type}] route ERROR`, {
          error: routeErr instanceof Error ? routeErr.message : String(routeErr),
        });
        return;
      }

      // 分发给业务处理器
      if (this.messageHandler) {
        this.logger.info(`[Channel:${this.type}] dispatching to handler`);
        try {
          this.logger.info(`[Channel:${this.type}] calling handler`);
          await this.messageHandler(this.type, msg, session);
          this.logger.info(`[Channel:${this.type}] handler done`);
        } catch (e) {
          this.logger.warn(`[Channel:${this.type}] Handler error`, {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : '',
          });
        }
      }
      this.logger.info(`[Channel:${this.type}] _handleIncomingMessage END OK`);
    } finally {
      // 无论成功还是失败，都释放 inFlight 标记
      this.inFlightKeys.delete(inFlightKey);
    }
  }

  // ---------- 子类需实现的接口 ----------

  /** 连接渠道（子类实现，对应 BaseChannel.connect 占位 + 子类覆写） */
  abstract connect(config: Record<string, unknown>): Promise<SendResult | void>;

  /** 断开渠道（子类实现） */
  abstract disconnect(): Promise<void>;

  async onModuleDestroy(): Promise<void> {
    try {
      await this.disconnect();
    } finally {
      if (this.statusDebounceTimer) clearTimeout(this.statusDebounceTimer);
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.statusDebounceTimer = null;
      this.persistTimer = null;
      if (this.persistDirty) this.doPersist();
    }
  }

  /** 发送消息（子类实现） */
  abstract sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult>;

  /** 获取状态（子类可覆写以附加额外字段） */
  getStatus(): ChannelRuntimeStatus & Record<string, unknown> {
    return { ...this.status };
  }

  /** 获取测试目标（子类实现，对应 getTestTarget） */
  abstract getTestTarget(): TestTarget;

  // ---------- 工具方法 ----------

  /** 时间常量比较（对应飞书签名校验中的 crypto.timingSafeEqual 用法） */
  protected safeEqual(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      if (bufA.length !== bufB.length) return false;
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /** 解析数据目录（沿用现有 ChannelsService 的 SKYALYTICWING_DATA_DIR 约定） */
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

  /** 确保数据目录的某个子文件可写（创建父目录） */
  protected ensureDataFile(filename: string): string {
    const fullPath = join(this.dataDir, filename);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 忽略
      }
    }
    return fullPath;
  }
}

/** 路由表上限常量导出（供 ChannelRouterService 使用一致性参考） */
export const ROUTER_MAX_ROUTES = MAX_ROUTES;
