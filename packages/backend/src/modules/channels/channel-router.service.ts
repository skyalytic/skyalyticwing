import { join } from 'node:path';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ROUTER_MAX_ROUTES } from './providers/base.provider.js';

// ============================================================
// 类型定义（对应 channels.cjs ChannelRouter）
// ============================================================

/** 路由会话（对应 routes[key] 的值） */
export interface RouteSession {
  sessionId: string;
  agentId: string;
  conversationId: string;
  createdAt: number;
}

/**
 * ChannelRouterService - 渠道消息路由服务
 *
 * 对应 channels.cjs 中 ChannelRouter 构造函数。
 *
 * 职责：
 *   - 按 (channelId, from, threadId) 三元组路由到稳定的会话
 *   - M-D1 fix: routes 无限增长——加上限 10000，超过时淘汰 createdAt 最旧条目
 *   - bind 同样应用上限淘汰
 *
 * 线程安全说明：NestJS 单例，Node 单线程，无需加锁。
 */
@Injectable()
export class ChannelRouterService implements OnModuleInit {
  private storePath?: string;
  onModuleInit(): void {
    this.storePath = join(getDefaultDataDir(), 'channel-routes.json');
    const saved = readJsonRecover<Record<string, RouteSession>>(this.storePath, {});
    this.routes = Object.fromEntries(
      Object.entries(saved)
        .filter(([key, value]) => {
          try {
            return Array.isArray(JSON.parse(key)) && typeof value.sessionId === 'string';
          } catch {
            return false;
          }
        })
        .slice(-this.maxRoutes),
    );
  }
  private persist(): void {
    if (this.storePath) writeJsonAtomicSync(this.storePath, this.routes);
  }

  /** JSON tuple keys preserve boundaries even when identifiers contain colons. */
  private routes: Record<string, RouteSession> = {};
  /** 路由表上限（对应 _MAX_ROUTES） */
  private readonly maxRoutes = ROUTER_MAX_ROUTES;

  /**
   * 路由或创建会话（对应 ChannelRouter.route）
   *
   * 若 key 不存在则新建会话；超过上限时淘汰 createdAt 最旧条目。
   */
  route(channelId: string, from: string, threadId?: string): RouteSession {
    const key = JSON.stringify([channelId, from, threadId || 'default']);
    if (!this.routes[key]) {
      // 超过上限时淘汰 createdAt 最旧的条目
      const keys = Object.keys(this.routes);
      if (keys.length >= this.maxRoutes) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const k of keys) {
          const entry = this.routes[k];
          const ts = entry && entry.createdAt ? entry.createdAt : 0;
          if (ts < oldestTs) {
            oldestTs = ts;
            oldestKey = k;
          }
        }
        if (oldestKey) delete this.routes[oldestKey];
      }
      this.routes[key] = {
        sessionId: 'ch-' + channelId + '-' + randomUUID(),
        agentId: 'main',
        conversationId: from,
        createdAt: Date.now(),
      };
      this.persist();
    }
    return this.routes[key];
  }

  /**
   * 绑定会话（对应 ChannelRouter.bind）
   *
   * 显式指定会话信息；同样应用上限淘汰。
   */
  bind(channelId: string, from: string, threadId: string | undefined, session: RouteSession): void {
    const key = JSON.stringify([channelId, from, threadId || 'default']);
    // bind 同样应用上限
    if (!this.routes[key]) {
      const bKeys = Object.keys(this.routes);
      if (bKeys.length >= this.maxRoutes) {
        let bOldest: string | null = null;
        let bOldestTs = Infinity;
        for (const bk of bKeys) {
          const bEntry = this.routes[bk];
          const bTs = bEntry && bEntry.createdAt ? bEntry.createdAt : 0;
          if (bTs < bOldestTs) {
            bOldestTs = bTs;
            bOldest = bk;
          }
        }
        if (bOldest) delete this.routes[bOldest];
      }
    }
    this.routes[key] = session;
    this.persist();
  }

  /** 获取会话（对应 ChannelRouter.getSession，等价于 route） */
  getSession(channelId: string, from: string, threadId?: string): RouteSession {
    return this.route(channelId, from, threadId);
  }

  /** 清空路由表（对应 ChannelRouter.clear） */
  clear(): void {
    this.routes = {};
    this.persist();
  }
}
