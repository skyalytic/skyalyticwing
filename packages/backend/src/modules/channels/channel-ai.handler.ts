import { replyContext } from './reply-context.js';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { TokenUsage } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { ConfigService } from '../core/config/config.service.js';
import { ChannelsService } from './channels.service.js';
import { BindingService } from './binding.service.js';
import type { IncomingMessage, RoutedSession } from './providers/base.provider.js';
import { AgentLoopService } from '../ai/agent/agent-loop.service.js';
import { SubagentService } from '../ai/agent/subagent.service.js';

// ============================================================
// 常量
// ============================================================

/** 自回复 echo 防护窗口（与 BaseProvider 时间窗口去重一致：120s） */
const ECHO_TTL_MS = 120_000;
/** echo key 缓存上限 */
const MAX_ECHO_KEYS = 200;

/**
 * ChannelAiHandler - 渠道消息 → AI → 自动回复闭环处理器
 *
 * 对齐旧版 start.cjs initChannelSystem 的 ChannelSystem.onMessage 注册 +
 * processChannelMessage 处理链（行 2557-2698、2930-3208）：
 *
 *   1. 收到 {channelType, message, session} 入站消息（经 ChannelsService.dispatchMessage）
 *   2. 查 BindingService 绑定：渠道用户 → agent（无绑定回退默认 main）
 *   3. 会话隔离：每 (channelType, senderId) 一个会话，
 *      命名对齐旧版 `channel-${channelType}-${from || 'unknown'}`
 *   4. 经 AgentLoopService.run() 驱动 AI 循环（不设置固定迭代上限；
 *      工具审批走 AgentLoop 内置 WebSocket 审批流，120s 超时拒绝——较旧版 60s 宽松化）
 *   5. 收集最终 assistant 回复文本
 *   6. 经 ChannelsService.sendMessageToProvider 回发渠道
 *      （透传 raw.chatId/msgId 作为回复路由选项，对齐旧版）
 *   7. AI 失败时回发 "[ERROR] ..." 友好错误消息（对齐旧版）
 *   8. done 事件携带 usage 时轻量记录日志
 *
 * 防自回复循环：
 *   - BaseProvider 侧已有五重入站去重 + inFlight 守卫
 *   - 本处理器额外维护"已发送回复 echo 表"：发送成功的回复记录
 *     (channelType, to, md5(text))，120s 内同 key 入站消息视为自身回显，跳过
 *
 * 开关：config channels.autoReply（默认 true，对齐旧版启动即注册的行为）
 *
 * AgentLoopService 经 ModuleRef 懒解析（strict:false，参考 tool-executor 的
 * ServiceResolver 模式），避免 ChannelsModule → AgentModule 的编译期模块依赖。
 */
@Injectable()
export class ChannelAiHandler implements OnModuleInit {
  /** 已发送回复 echo 表：key = `${channelType}|${to}|${md5(text)}` → 发送时间戳 */
  private readonly echoKeys = new Map<string, number>();
  /** AgentLoopService 懒解析缓存 */
  private agentLoopCache: AgentLoopService | null = null;

  constructor(
    private readonly channelsService: ChannelsService,
    private readonly bindingService: BindingService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** 启动即注册消息处理器（对齐旧版 initChannelSystem 中 onMessage 注册） */
  onModuleInit(): void {
    this.channelsService.onMessage((channelType, message, session) =>
      this.handleMessage(channelType, message, session),
    );
    this.logger.info('[ChannelAI] auto-reply handler registered');
  }

  // ============================================================
  // 处理链（对齐旧版 processChannelMessage 语义）
  // ============================================================

  private async handleMessage(
    channelType: string,
    message: IncomingMessage,
    _session: RoutedSession,
  ): Promise<void> {
    try {
      // 开关：channels.autoReply（默认 true）
      if (!this.isAutoReplyEnabled()) return;

      // 空消息跳过（对齐旧版 if (!text.trim()) return null）
      let text = (message.text || '').trim();
      if (!text) return;
      // 渠道按钮消息前缀剥离（对齐旧版）
      if (text.startsWith('[button]')) {
        text = text.replace('[button] ', '').trim();
        if (!text) return;
      }

      const from = message.from || 'unknown';

      // 防自回复循环：自身回显消息跳过（命中即删，一次性消费——
      // 防止 AI 回复 "ok" 后用户 120s 内再发 "ok" 被误吞）
      if (this.isOwnEcho(channelType, from, text)) {
        this.logger.info('[ChannelAI] self-echo skipped', { channelType, from });
        return;
      }

      // /btw 短路（对齐旧版 start.cjs:2934-2947：渠道 /btw xxx 走旁路提问，不进主 agent 循环）
      if (text.startsWith('/btw ') || text === '/btw') {
        const btwQuestion = text.slice(4).trim();
        await this.handleBtw(channelType, from, btwQuestion, message.raw);
        return;
      }

      // 1. 查绑定：渠道用户 → agent（无绑定回退默认 main）
      const route = this.bindingService.resolve({
        channel: channelType,
        peerId: from,
        peerKind: 'direct',
      });
      const agentId = route.agentId || 'main';

      // 2. 会话隔离：每 (channelType, senderId) 一个会话（命名对齐旧版）。
      //    from 归一化（[^\w.-] → _）：防新渠道/自定义 webhook 的自由文本 from
      //    作为快照文件名触发路径穿越或写失败
      const sessionId = _session.sessionId;

      // 3. 调 AI：经 AgentLoopService 驱动（渠道场景迭代上限 500，对齐旧版）
      const agentLoop = this.resolveAgentLoop();
      if (!agentLoop) {
        await this.sendReply(
          channelType,
          from,
          '[ERROR] AI service unavailable',
          message.raw,
        );
        return;
      }

      let replyText = '';
      let failure: string | null = null;
      let usage: TokenUsage | undefined;
      try {
        for await (const event of agentLoop.run(sessionId, text, {
          agentId,
        })) {
          if (event.type === 'assistant_message' && event.message?.phase !== 'progress' && event.message?.phase !== 'status' && event.content) {
            replyText = event.content;
          } else if (event.type === 'error') {
            failure = event.error;
          } else if (event.type === 'done' && event.usage) {
            usage = event.usage;
          }
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }

      // 8. usage 轻量记录（UsageService 为只读聚合，这里仅日志记录）
      if (usage) {
        this.logger.info('[ChannelAI] usage', {
          sessionId,
          agentId,
          channelType,
          ...usage,
        });
      }

      // 7. 错误处理：AI 失败时回发友好错误消息（对齐旧版 "[ERROR] " + message）
      if (failure) {
        await this.sendReply(
          channelType,
          from,
          `[ERROR] ${failure || '处理失败'}`,
          message.raw,
        );
        return;
      }

      if (!replyText) {
        this.logger.warn('[ChannelAI] empty reply, skip sending', {
          channelType,
          from,
          sessionId,
        });
        return;
      }

      // 4-6. 回复路由：发回渠道
      await this.sendReply(channelType, from, replyText, message.raw);
    } catch (err) {
      this.logger.error('[ChannelAI] handleMessage error', {
        channelType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /**
   * /btw 旁路提问（对齐旧版 BtwSystem 短路：经 SubagentService.handleBtw
   * 按对话背景轻量回答，不进主 agent 循环）
   */
  private async handleBtw(
    channelType: string,
    from: string,
    question: string,
    raw?: Record<string, unknown>,
  ): Promise<void> {
    if (!question) {
      await this.sendReply(channelType, from, '用法：/btw <问题>', raw);
      return;
    }
    try {
      const subagent = this.moduleRef?.get<SubagentService>(SubagentService, { strict: false });
      if (!subagent) {
        await this.sendReply(channelType, from, '[ERROR] btw service unavailable', raw);
        return;
      }
      const result = await subagent.handleBtw(question);
      await this.sendReply(channelType, from, result.answer || '(空回复)', raw);
    } catch (err) {
      await this.sendReply(
        channelType,
        from,
        `[ERROR] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        raw,
      );
    }
  }

  /** 读取 channels.autoReply 开关（段缺失/类型异常时默认 true，对齐旧版默认行为） */
  private isAutoReplyEnabled(): boolean {
    try {
      const channels = this.config.get<Record<string, unknown>>('channels');
      const v = channels?.['autoReply'];
      return typeof v === 'boolean' ? v : true;
    } catch {
      return true;
    }
  }

  /**
   * 懒解析 AgentLoopService（ServiceResolver 模式：ModuleRef strict:false）
   * 解析失败（模块未注册/未初始化）返回 null，由调用方回发错误消息。
   */
  private resolveAgentLoop(): AgentLoopService | null {
    if (this.agentLoopCache) return this.agentLoopCache;
    try {
      const loop = this.moduleRef?.get<AgentLoopService>(AgentLoopService, {
        strict: false,
      });
      if (loop) {
        this.agentLoopCache = loop;
        return loop;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 回发消息到渠道（对齐旧版 ChannelSystem.sendMessage 调用：
   * 透传 raw.chatId/channel → options.chatId、raw.msgId → options.msgId）
   */
  private async sendReply(
    channelType: string,
    to: string,
    text: string,
    raw?: Record<string, unknown>,
  ): Promise<void> {
    // Enabled AI channels are remote task interfaces: return the result directly.
    // Tool execution permissions remain enforced by AgentLoopService.
    const options=replyContext(raw);
    try {
      const result = await this.channelsService.sendMessageToProvider(
        channelType,
        to,
        text,
        options,
      );
      if (!result.success) {
        this.logger.warn('[ChannelAI] reply send failed', {
          channelType,
          to,
          error: result.error,
        });
        return;
      }
      // 记录 echo key，用于自回复循环防护
      this.rememberEcho(channelType, to, text);
      this.logger.info('[ChannelAI] reply sent', { channelType });
    } catch (err) {
      this.logger.warn('[ChannelAI] reply send error', {
        channelType,
        to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 判断入站消息是否为自身刚发送回复的回显（命中即删：一次性消费，防止误吞用户重发的同内容消息） */
  private isOwnEcho(channelType: string, from: string, text: string): boolean {
    const key = this.echoKey(channelType, from, text);
    const ts = this.echoKeys.get(key);
    if (ts === undefined) return false;
    this.echoKeys.delete(key);
    if (Date.now() - ts > ECHO_TTL_MS) return false;
    return true;
  }

  /** 记录已发送回复的 echo key（TTL 120s，超限淘汰过期/最旧条目） */
  private rememberEcho(channelType: string, to: string, text: string): void {
    const key = this.echoKey(channelType, to, text);
    this.echoKeys.set(key, Date.now());
    if (this.echoKeys.size <= MAX_ECHO_KEYS) return;
    const now = Date.now();
    for (const [k, v] of this.echoKeys) {
      if (now - v > ECHO_TTL_MS) this.echoKeys.delete(k);
    }
    while (this.echoKeys.size > MAX_ECHO_KEYS) {
      const oldest = this.echoKeys.keys().next().value;
      if (oldest === undefined) break;
      this.echoKeys.delete(oldest);
    }
  }

  private echoKey(channelType: string, from: string, text: string): string {
    const hash = createHash('md5').update(text).digest('hex').substring(0, 16);
    return `${channelType}|${from}|${hash}`;
  }
}
