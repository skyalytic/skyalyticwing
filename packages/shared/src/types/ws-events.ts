import type { ChatMessage } from './chat';
import type { ToolApprovalRequest, ToolApprovalResponse, ToolResult } from './tool';

/** 后台任务状态（BackgroundTaskService 状态机） */
export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** 后台任务事件数据（background_task WS 事件） */
export interface BackgroundTaskEventData {
  /** 任务 ID（bgt- 前缀） */
  taskId: string;
  /** 发起会话（任务结果回流目标；前端按此过滤展示） */
  sessionId: string;
  /** 任务标题 */
  title: string;
  status: BackgroundTaskStatus;
  /** 当前进度描述（如"正在执行 generate_video..."） */
  step?: string;
  /** 完成时的最终内容（assistant 回复） */
  content?: string;
  /** 失败原因 */
  error?: string;
  createdAt: number;
  endedAt?: number;
}

/** WebSocket 事件类型 */
export type WsEvent =
  | { type: 'chat_message'; data: ChatMessage }
  | { type: 'chat_stream'; data: { sessionId: string; content: string; done: boolean; message?: ChatMessage } }
  | { type: 'approval_request'; data: ToolApprovalRequest }
  | { type: 'approval_resolved'; data: { id: string; approved: boolean } }
  | { type: 'approval_response'; data: ToolApprovalResponse }
  | { type: 'channel_status'; data: { channel: string; status: string } }
  | { type: 'channel_message'; data: { channel: string; content: string; sender: string } }
  | { type: 'cron_updated'; data: { jobId: string; action: 'created' | 'updated' | 'deleted' } }
  | { type: 'session_restored'; data: { sessionId: string; messageCount: number } }
  | { type: 'config_reloaded'; data: { section: string } }
  | { type: 'tool_loaded'; data: { name: string; category: string } }
  | { type: 'tool_call'; data: { toolName: string; args: unknown; callId: string; sessionId?: string; turnId?: string; turnSequence?: number } }
  | { type: 'tool_result'; data: { toolName: string; result: ToolResult; callId: string; sessionId?: string; turnId?: string; turnSequence?: number } }
  | { type: 'background_task'; data: BackgroundTaskEventData }
  | { type: 'health'; data: { status: 'ok' | 'degraded' | 'down'; uptime: number } }
  | { type: 'error'; data: { code: string; message: string } }
  | {
      type: 'notification';
      data: { title: string; message: string; level: 'info' | 'warn' | 'error'; sessionId?: string };
    }
  | {
      type: 'show_message';
      data: {
        title: string;
        message: string;
        messageType: 'info' | 'success' | 'warning' | 'error';
        sessionId?: string;
      };
    }
  | {
      type: 'agent_message';
      data: {
        from: string;
        fromName?: string;
        to: string;
        toName?: string;
        content: string;
        msgId?: string;
        timestamp: number;
        inReplyTo?: string;
      };
    }
  | { type: 'subagent_completed'; data: { agentId: string; result: string } }
  | { type: 'tools_refresh'; data: { approvalId: string; decision: string } }
  | { type: 'permissions_refresh'; data: { approvalId: string; decision: string } }
  | {
      type: 'isolated_agent_completed';
      data: { sessionId: string; output: string; iterations: number; durationMs: number };
    }
  /** ask_user 工具向用户发起提问（此前后端已发送但联合类型未收录，前端只能强转） */
  | {
      type: 'ask_user_request';
      data: {
        id: string;
        sessionId?: string;
        question: string;
        options: string[];
        multiple: boolean;
      };
    }
  /** send_file_to_user 工具的文件卡片（此前 ctx.broadcast 是空壳，事件从未真正到达前端） */
  | {
      type: 'file_offer';
      data: {
        file: string;
        filename: string;
        ext: string;
        size: number;
        caption: string;
        url: string;
        sessionId?: string;
      };
    };

/** WebSocket 连接状态 */
export type WsConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

/** WebSocket 连接信息 */
export interface WsConnectionInfo {
  status: WsConnectionStatus;
  reconnectAttempts: number;
  lastConnectedAt?: number;
}
