import { deduplicateAttachments } from '@skyalyticwing/shared';
// 聊天状态 store
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiClient } from '@/services/api-client';
import type { BackgroundTaskEventData, ChatMessage, ToolResult } from '@/types';


/**
 * 消息结构变更（删除单条 / 回退本轮）后同步后端会话存储：
 * 保证会话管理的消息计数、重新打开会话时的历史与前端一致（否则重开后旧消息又回来）。
 * 失败静默——下次结构变更会全量覆盖同步。
 */
function syncMessagesToServer(sessionId: string | null, messages: ChatMessage[]): void {
  if (!sessionId) return;
  void apiClient
    .put(`/sessions/${encodeURIComponent(sessionId)}/messages`, { messages })
    .catch(() => undefined);
}

/** 工具调用实时状态 */
export interface ToolCallState {
  toolName: string;
  args?: unknown;
  status: 'running' | 'success' | 'error';
  result?: ToolResult;
  /** 完成时间戳（超量清理时用于淘汰最早完成的条目） */
  finishedAt?: number;
}

/** 后台任务实时状态（background_task WS 事件驱动，不持久化） */
export type BackgroundTaskState = BackgroundTaskEventData;

/** backgroundTasks 保留上限：超量淘汰最早完结的条目（pending/running 不淘汰） */
const MAX_BACKGROUND_TASKS = 30;

/** toolCalls 保留上限：超出后淘汰最早完成的条目（running 状态不淘汰），防止 Record 无限增长 */
const MAX_TOOL_CALLS = 60;

type SessionChat = Pick<ChatState, 'messages' | 'isStreaming' | 'streamingContent' | 'streamingSessionId' | 'toolCalls' | 'backgroundTasks' | 'isStopping'>;
const emptySession = (): SessionChat => ({ messages: [], isStreaming: false, isStopping: false,
  streamingContent: '', streamingSessionId: null, toolCalls: {}, backgroundTasks: {} });
const snapshot = (state: SessionChat): SessionChat => ({messages: state.messages, isStreaming: state.isStreaming,
  isStopping: state.isStopping, streamingContent: state.streamingContent, streamingSessionId: state.streamingSessionId,
  toolCalls: state.toolCalls, backgroundTasks: state.backgroundTasks});
export const sessionChat = (state: ChatState, id: string): SessionChat =>
  state.messagesSessionId === id ? snapshot(state) : state.sessions[id] ?? emptySession();

/** Order inside a turn by the server sequence, without reordering older turns. */
export function orderTranscript(messages: ChatMessage[]): ChatMessage[] {
  const groups = new Map<string, ChatMessage[]>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.turnId) {
      const group = groups.get(message.turnId) ?? [];
      group.push(message); groups.set(message.turnId, group);
    }
  }
  const emitted = new Set<string>();
  for (const message of messages) {
    if (!message.turnId) result.push(message);
    else if (!emitted.has(message.turnId)) {
      emitted.add(message.turnId);
      result.push(...groups.get(message.turnId)!.sort((a,b) => (a.turnSequence ?? Number.MAX_SAFE_INTEGER) - (b.turnSequence ?? Number.MAX_SAFE_INTEGER)));
    }
  }
  return result;
}

export interface ChatState {
  epoch: number;
  sessions: Record<string, SessionChat>;
  isStopping: boolean;
  activateSession: (id: string | null) => void;
  setStopping: (id: string, value: boolean) => void;
  mergeHistory: (id: string, messages: ChatMessage[]) => void;
  messages: ChatMessage[];
  /** 当前 messages 所属会话（会话归属标记，防切换串扰；null 表示未知/恢复态） */
  messagesSessionId: string | null;
  /** 清空完成后使此前发出的历史请求失效（不持久化）。 */
  historyRevisions: Record<string, number>;
  clearingSessionId: string | null;
  isStreaming: boolean;
  streamingContent: string;
  streamingSessionId: string | null;
  /** callId → 工具调用实时状态（不持久化） */
  toolCalls: Record<string, ToolCallState>;
  /** taskId → 后台任务实时状态（不持久化；仅当前会话的任务） */
  backgroundTasks: Record<string, BackgroundTaskState>;
  addMessage: (msg: ChatMessage, sessionId?: string) => void;
  setMessages: (messages: ChatMessage[], sessionId?: string | null) => void;
  appendStream: (content: string, sessionId?: string) => void;
  startStream: (sessionId: string) => void;
  clearStream: (sessionId?: string) => void;
  setStreaming: (value: boolean, sessionId?: string) => void;
  /** tool_call 事件：登记工具调用为运行中 */
  startToolCall: (callId: string, toolName: string, args?: unknown, sessionId?: string) => void;
  /** tool_result 事件：落盘工具结果并更新关联消息内容 */
  finishToolCall: (callId: string, toolName: string, result: ToolResult, sessionId?: string) => void;
  /** background_task 事件：更新后台任务状态（含超量淘汰与已完结任务清理） */
  updateBackgroundTask: (task: BackgroundTaskEventData) => void;
  /** 清空全部后台任务状态 */
  clearBackgroundTasks: () => void;
  /**
   * assistant 最终消息落库（多通道去重合并）。
   * 同一条最终消息可能经 WS chat_message / POST /chat/send 响应 / chat_stream done
   * 本地追加重复送达（可携带生成媒体 attachments）：
   *   - id 命中已存在消息 → 合并 attachments（不重复追加）
   *   - 内容一致的近期 assistant 消息 → 合并 attachments
   *   - 均未命中 → 追加新消息
   */
  settleAssistantMessage: (msg: ChatMessage, sessionId?: string) => void;
  /** 删除单条消息（消息 hover 操作栏） */
  deleteMessage: (id: string) => void;
  /** 截断到指定下标之前（回退本轮：删除该轮用户消息及其后全部消息） */
  truncateFromIndex: (index: number) => void;
  clear: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => {
      // Every asynchronous callback names its owner; only the selected session projects into the UI.
      const scoped = (id: string | undefined, change: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => set(state => {
        const owner = id ?? state.messagesSessionId;
        const base = owner ? { ...state, ...sessionChat(state, owner), messagesSessionId: owner } : state;
        const patch = typeof change === 'function' ? change(base) : change;
        const next = { ...base, ...patch };
        return {
          ...(owner ? { sessions: { ...state.sessions, [owner]: snapshot(next) } } : {}),
          ...(!owner || owner === state.messagesSessionId ? patch : {}),
        };
      });
      return ({
      epoch: 0,
      sessions: {},
      isStopping: false,
      activateSession: (id) => set(state => ({
        sessions: state.messagesSessionId ? {...state.sessions, [state.messagesSessionId]: snapshot(state)} : state.sessions,
        ...((id && id === state.messagesSessionId) ? snapshot(state) : (id && state.sessions[id]) || emptySession()),
        messagesSessionId: id,
      })),
      setStopping: (id, value) => scoped(id, {isStopping: value}),
      mergeHistory: (id, history) => scoped(id, state => {
        const calls = {...state.toolCalls};
        const results = new Map(history.filter(m => m.role === 'tool' && m.toolCallId).map(m => [m.toolCallId!, m]));
        for (const message of history) for (const call of message.toolCalls ?? []) {
          let args: unknown = call.function.arguments;
          try { args = JSON.parse(call.function.arguments); } catch { /* retain raw arguments */ }
          const resultMessage = results.get(call.id);
          let result: ToolResult | undefined;
          if (resultMessage) {
            try { result = JSON.parse(resultMessage.content); } catch { /* legacy plain text */ }
            if (!result || typeof result.success !== 'boolean') result = {success: !/^Not executed:/i.test(resultMessage.content), output: resultMessage.content};
          }
          calls[call.id] = result ? {toolName: call.function.name, args, result, status: result.success ? 'success' : 'error'}
            : calls[call.id] ?? {toolName: call.function.name, args, status: 'running'};
        }
        // Server results replace their temporary live card by call ID, without losing in-flight cards.
        const ids = new Set(history.map(m => m.id));
        const live = state.messages.filter(m => !ids.has(m.id) && (m.role === 'tool' || m.id.startsWith('file-offer_') || m.id.startsWith('client-error_') || m.phase === 'status' || m.streaming === true || (m.role === 'user' && !!m.turnId && !history.some(h => h.turnId === m.turnId)))
          && !(m.toolCallId && results.has(m.toolCallId)));
        let turnStart = history.length;
        while (turnStart > 0 && history[turnStart - 1].role !== 'user') turnStart--;
        const delivered = deduplicateAttachments(history.slice(turnStart).filter(m => m.role === 'assistant')
          .flatMap(m => m.attachments ?? []));
        const pending = live.flatMap(message => {
          if (!message.id.startsWith('file-offer_')) return [message];
          const attachments = (message.attachments ?? []).filter(attachment =>
            deduplicateAttachments([...delivered, attachment]).length > delivered.length);
          return attachments.length ? [{...message, attachments}] : [];
        });
        const transcript = [...history];
        for (const message of pending) {
          // A local failure belongs before the next user turn, including legacy records.
          let anchor = -1;
          for (let i = 0; i < transcript.length; i++) if (message.turnId && transcript[i].turnId === message.turnId) anchor = i;
          if (anchor >= 0) transcript.splice(anchor + 1, 0, message);
          else {
            const nextTurn = transcript.findIndex(m => m.role === 'user' && m.timestamp > message.timestamp);
            transcript.splice(nextTurn < 0 ? transcript.length : nextTurn, 0, message);
          }
        }
        for (const message of history) for (const call of message.toolCalls ?? []) {
          if (!transcript.some(m => m.toolCallId === call.id)) transcript.splice(transcript.indexOf(message) + 1, 0, {
            id: `tool-${call.id}`, role: 'tool', toolCallId: call.id, toolName: call.function.name,
            content: '', timestamp: message.timestamp, sessionId: id, turnId: message.turnId, turnSequence: (message.turnSequence ?? 0) + 0.5,
          });
        }
        return {messages: orderTranscript(transcript), toolCalls: calls};
      }),
      messages: [],
      messagesSessionId: null,
      historyRevisions: {},
      clearingSessionId: null,
      isStreaming: false,
      streamingContent: '',
      streamingSessionId: null,
      toolCalls: {},
      backgroundTasks: {},

      addMessage: (msg, sessionId) =>
        scoped(sessionId ?? msg.sessionId, (state) => {
          // 去重（按 id）
          if (state.messages.some((m) => m.id === msg.id)) {
            return {};
          }
          const next = [...state.messages, { ...msg, ...(msg.attachments ? {attachments: deduplicateAttachments(msg.attachments)} : {}) }];
          return { messages: orderTranscript(next) };
        }),

      setMessages: (messages, sessionId) =>
        set((state) => ({
          messages,
          // sessionId 显式传 null 表示清空视图（归属未知）；未传保持原归属
          messagesSessionId: sessionId === undefined ? state.messagesSessionId : sessionId,
        })),

      startStream: (sessionId) =>
        scoped(sessionId, { isStreaming: true, streamingContent: '', streamingSessionId: sessionId }),

      appendStream: (content, sessionId) =>
        scoped(sessionId, (state) => ({ streamingContent: state.streamingContent + content })),

      clearStream: (sessionId) =>
        scoped(sessionId, { streamingContent: '', isStreaming: false, isStopping: false, streamingSessionId: null }),

      setStreaming: (value, sessionId) =>
        scoped(sessionId, { isStreaming: value, ...(sessionId ? {streamingSessionId: value ? sessionId : null} : {}) }),

      startToolCall: (callId, toolName, args, sessionId) =>
        scoped(sessionId, (state) => ({
          toolCalls: {
            ...state.toolCalls,
            [callId]: { toolName, args, status: 'running' },
          },
        })),

      finishToolCall: (callId, toolName, result, sessionId) =>
        scoped(sessionId, (state) => {
          const next: ToolCallState = {
            ...(state.toolCalls[callId] ?? { toolName }),
            toolName,
            status: result.success ? 'success' : 'error',
            result,
            finishedAt: Date.now(),
          };
          const toolCalls: Record<string, ToolCallState> = {
            ...state.toolCalls,
            [callId]: next,
          };
          // 超量清理：超出上限时淘汰最早完成的条目（running 状态保留，待其完成后再清理）
          const total = Object.keys(toolCalls).length;
          if (total > MAX_TOOL_CALLS) {
            const finished = Object.entries(toolCalls)
              .filter(([, v]) => v.status !== 'running')
              .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
            let excess = total - MAX_TOOL_CALLS;
            for (const [id] of finished) {
              if (excess <= 0) break;
              delete toolCalls[id];
              excess -= 1;
            }
          }
          // 同步更新关联的 tool 角色消息内容
          const output = [result.error, result.output].filter(Boolean).join('\n');
          const messages = state.messages.map((m) =>
            m.toolCallId === callId || m.id === `tool-${callId}`
              ? { ...m, content: output }
              : m,
          );
          return { toolCalls, messages };
        }),

      updateBackgroundTask: (task) =>
        scoped(task.sessionId, (state) => {
          const backgroundTasks: Record<string, BackgroundTaskState> = {
            ...state.backgroundTasks,
            [task.taskId]: task,
          };
          // 超量清理：淘汰最早完结的条目（pending/running 不淘汰，待完结后再清理）
          const ids = Object.keys(backgroundTasks);
          if (ids.length > MAX_BACKGROUND_TASKS) {
            const finished = ids
              .filter((id) => backgroundTasks[id].status !== 'pending' && backgroundTasks[id].status !== 'running')
              .sort((a, b) => (backgroundTasks[a].endedAt ?? 0) - (backgroundTasks[b].endedAt ?? 0));
            let excess = ids.length - MAX_BACKGROUND_TASKS;
            for (const id of finished) {
              if (excess <= 0) break;
              delete backgroundTasks[id];
              excess -= 1;
            }
          }
          return { backgroundTasks };
        }),

      clearBackgroundTasks: () => set({ backgroundTasks: {} }),

      settleAssistantMessage: (msg, sessionId) =>
        scoped(sessionId ?? msg.sessionId, (state) => {
          const existing = state.messages.find(m => m.id === msg.id);
          if (msg.streaming && existing?.streaming === false) return {};
          if (msg.role !== 'assistant') {
            const next = state.messages.some(m => m.id === msg.id) ? state.messages.map(m => m.id === msg.id ? {...m, ...msg} : m) : [...state.messages, msg];
            return { messages: orderTranscript(next) };
          }
          const mergeInto = (target: ChatMessage): ChatMessage => ({
            ...target,
            ...msg,
            ...((target.attachments?.length || msg.attachments?.length) ? {
              attachments: deduplicateAttachments([...(target.attachments ?? []), ...(msg.attachments ?? [])]),
            } : {}),
          });
          // A file offer is an immediate provisional card. Replace only matching cards
          // from this user turn; never collapse separate replies by equal text or filename.
          let turnStart = state.messages.length;
          while (turnStart > 0 && state.messages[turnStart - 1]?.role !== 'user') turnStart--;
          let incoming = deduplicateAttachments(msg.attachments ?? []);
          if (msg.id.startsWith('file-offer_')) {
            const delivered = deduplicateAttachments(state.messages.slice(turnStart)
              .filter(message => message.role === 'assistant' && !message.id.startsWith('file-offer_'))
              .flatMap(message => message.attachments ?? []));
            incoming = incoming.filter(attachment => deduplicateAttachments([...delivered, attachment]).length > delivered.length);
            if (!incoming.length) return {};
          }
          const messages = state.messages.flatMap((message, index) => {
            if (index < turnStart || !message.id.startsWith('file-offer_') || message.id === msg.id) return [message];
            const remaining = (message.attachments ?? []).filter(attachment =>
              deduplicateAttachments([...incoming, attachment]).length > incoming.length,
            );
            return remaining.length ? [{ ...message, attachments: remaining }] : [];
          });
          const byId = messages.findIndex(message => message.id === msg.id);
          if (byId >= 0) messages[byId] = mergeInto(messages[byId]);
          else messages.push({ ...msg, ...(msg.attachments ? {attachments:incoming} : {}) });
          return { messages: orderTranscript(messages) };
        }),

      clear: () =>
        set(state => ({ ...emptySession(), messagesSessionId: null, sessions: {}, historyRevisions: {}, clearingSessionId: null, epoch: state.epoch + 1 })),

      deleteMessage: (id) =>
        set((state) => {
          const messages = state.messages.filter((m) => m.id !== id);
          syncMessagesToServer(state.messagesSessionId, messages);
          return { messages };
        }),

      truncateFromIndex: (index) =>
        set((state) => {
          const messages = index <= 0 ? [] : state.messages.slice(0, index);
          syncMessagesToServer(state.messagesSessionId, messages);
          return { messages };
        }),
    });
    },
    {
      name: 'chat-storage',
      // The backend owns durable history. Base64 attachments in localStorage can
      // exceed the browser quota and make every subsequent store update throw.
      partialize: () => ({}),
      merge: (_persisted, current) => current,
    },
  ),
);
