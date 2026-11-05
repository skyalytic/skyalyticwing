import type { ChatMessage } from './chat';

/** 会话存储项 */
export interface SessionStoreItem {
  titleCustomized?: boolean;
  id: string;
  title: string;
  messages: ChatMessage[];
  /** Model-only checkpoint; original conversation remains in messages. */
  contextCheckpoint?: { sourceCount: number; lastMessageId: string; messages: ChatMessage[] };
  createdAt: number;
  updatedAt: number;
  model?: string;
  agent?: string;
  pinned?: boolean;
  /** 归档会话（列表默认灰显收进折叠组，不参与"最近"排序入口） */
  archived?: boolean;
}

/** 会话恢复点 */
export interface SessionRestorePoint {
  sessionId: string;
  timestamp: number;
  messageCount: number;
  checksum: string;
}

/** 生命周期状态 */
export interface LifecycleState {
  generationUuid: string;
  startedAt: number;
  isRunning: boolean;
  doomLoopDetected: boolean;
  consecutiveCalls: number;
}

/** Doom Loop 检测配置 */
export interface DoomLoopConfig {
  enabled: boolean;
  maxConsecutiveCalls: number;
  timeWindowMs: number;
  cooldownMs: number;
}
