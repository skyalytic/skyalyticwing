import { wt } from '@/i18n/workbench-text';
import { useCallback, useEffect } from 'react';
import { apiClient } from '@/services/api-client';
import { useChatStore, sessionChat } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { toast } from '@/components/ui/Toast';
import { genId } from '@/utils/format';
import type { Attachment, ChatMessage } from '@/types';

// Requests belong to sessions, not mounted views. Navigating away must not orphan them.
const requests = new Map<string, symbol>();
export interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  isStopping: boolean;
  streamingContent: string;
  sendMessage: (content: string, attachments?: Attachment[], model?: string) => Promise<void>;
  stopStreaming: () => void;
  clearConversation: () => Promise<void>;
  isClearing: boolean;
}

export function useChat(): UseChatReturn {
  const currentSessionId = useSessionStore(s => s.currentSessionId);
  const messages = useChatStore(s => s.messages);
  const isStreaming = useChatStore(s => s.isStreaming);
  const isStopping = useChatStore(s => s.isStopping);
  const streamingContent = useChatStore(s => s.streamingContent);
  const isClearing = useChatStore(s => !!currentSessionId && s.clearingSessionId === currentSessionId);

  useEffect(() => {
    useChatStore.getState().activateSession(currentSessionId);
    if (!currentSessionId) return;
    const id = currentSessionId;
    const epoch = useChatStore.getState().epoch;
    let loaded = false;
    let wasActive = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const revision = useChatStore.getState().historyRevisions[id] ?? 0;
      try {
        const status = await apiClient.get<{active: boolean}>(`/chat/status/${encodeURIComponent(id)}`);
        if (disposed || useChatStore.getState().epoch !== epoch) return;
        // A locally submitted request is authoritative until its HTTP response settles.
        if (status?.active) useChatStore.getState().setStreaming(true, id);
        else if (!requests.has(id)) useChatStore.getState().clearStream(id);
        const history = !requests.has(id) && (!loaded || status?.active || wasActive)
          ? await apiClient.get<ChatMessage[]>(`/sessions/${encodeURIComponent(id)}/messages`) : undefined;
        wasActive = !!status?.active;
        if (!disposed && useChatStore.getState().epoch === epoch && (useChatStore.getState().historyRevisions[id] ?? 0) === revision && Array.isArray(history)) {
          // Do not overwrite a freshly submitted user message with an older snapshot.
          if (!requests.has(id)) {useChatStore.getState().mergeHistory(id, history); loaded = true;}
        }
      } catch { /* Keep existing history on a transient connection failure. */ }
      if (!disposed && useChatStore.getState().epoch === epoch) timer = setTimeout(() => void refresh(), wasActive ? 2000 : 5000);
    };
    void refresh();
    void apiClient.get<Array<{id: string; sessionId: string; title: string; status: import('@/types').BackgroundTaskStatus; createdAt: number; step?: string; endedAt?: number; error?: string | null}>>('/background-tasks').then(tasks => {
      if (disposed || !Array.isArray(tasks)) return;
      for (const task of tasks) if (task.sessionId === id) useChatStore.getState().updateBackgroundTask({
        ...task, taskId: task.id, error: task.error ?? undefined,
      });
    }).catch(() => undefined);
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [currentSessionId]);

  const sendMessage = useCallback(async (content: string, attachments?: Attachment[], model?: string) => {
    const text = content.trim();
    if (!text && !attachments?.length) return;
    let id = useSessionStore.getState().currentSessionId;
    if (!id) id = await useSessionStore.getState().createSession();
    if (!id) return;
    const sessionId = id;
    const state = useChatStore.getState();
    const epoch = state.epoch;
    if (requests.has(id) || sessionChat(state, id).isStreaming || state.clearingSessionId === id) return;
    const turnId = genId("turn");
    const request = Symbol(id);
    requests.set(id, request);
    const revision = (state.historyRevisions[id] ?? 0) + 1;
    useChatStore.setState({historyRevisions: {...state.historyRevisions, [id]: revision}});
    const agent = useSessionStore.getState().currentAgentId ?? undefined;
    state.startStream(id);
    state.addMessage({id: `${turnId}:user`, turnId, turnSequence: 0, role: 'user', content: text, timestamp: Date.now(), attachments, sessionId: id}, id);
    useSessionStore.setState(s => ({sessions: s.sessions.map(item => item.id === sessionId ? {
      ...item, messageCount: item.messageCount + 1, updatedAt: Date.now(),
      title: !item.titleCustomized && item.messageCount === 0 && (item.title === 'New chat' || item.title.startsWith('Session '))
        ? Array.from(text.replace(/\s+/g, ' ')).slice(0, 40).join('') + (Array.from(text).length > 40 ? '…' : '') : item.title,
    } : item)}));
    let failed = false;
    try {
      const response = await apiClient.post<{message?: ChatMessage}>('/chat/send', {
        session: id, turnId, message: text, attachments, ...(model ? {model} : {}), agent, stream: true,
      }, {timeoutMs: 0});
      if (useChatStore.getState().epoch === epoch && response?.message && (useChatStore.getState().historyRevisions[id] ?? 0) === revision) {
        useChatStore.getState().settleAssistantMessage(response.message, id);
      }
    } catch (error) {
      failed = true;
      if (useChatStore.getState().epoch === epoch) {
        const current = sessionChat(useChatStore.getState(), id);
        const recorded = current.messages.find(m => m.id === `${turnId}:status`);
        const cancelled = current.isStopping || recorded?.turnStatus === 'cancelled';
        if (!recorded) useChatStore.getState().addMessage({
          id: `${turnId}:status`, role: 'system', sessionId: id, turnId, phase: 'status',
          turnSequence: Number.MAX_SAFE_INTEGER, turnStatus: cancelled ? 'cancelled' : 'failed',
          content: cancelled ? wt('已停止') : wt('发送失败：{{v0}}', {v0: error instanceof Error ? error.message : wt('未知错误')}), timestamp: Date.now(),
        }, id);
      }
    } finally {
      if (requests.get(id) === request) {
        if (useChatStore.getState().epoch !== epoch) {requests.delete(id); return;}
        // Keep the turn locked until its final transcript has been reconciled.
        try {
          const history = await apiClient.get<ChatMessage[]>(`/sessions/${encodeURIComponent(id)}/messages`);
          if (useChatStore.getState().epoch === epoch && Array.isArray(history) && (useChatStore.getState().historyRevisions[id] ?? 0) === revision)
            useChatStore.getState().mergeHistory(id, history);
        } catch { /* Retain live cards if history refresh fails. */ }
        requests.delete(id);
        if (useChatStore.getState().epoch !== epoch) return;
        if (failed) {
          // A transport error does not prove the server stopped running the task.
          try {
            const status = await apiClient.get<{active: boolean}>(`/chat/status/${encodeURIComponent(id)}`);
            if (!status?.active) useChatStore.getState().clearStream(id);
          } catch { /* Reconciliation polling will unlock after reconnect. */ }
        } else useChatStore.getState().clearStream(id);
      }
      void useSessionStore.getState().loadSessions();
    }
  }, []);

  const stopStreaming = useCallback(() => {
    const id = useSessionStore.getState().currentSessionId;
    if (!id || sessionChat(useChatStore.getState(), id).isStopping) return;
    useChatStore.getState().setStopping(id, true);
    // Do not abort the HTTP waiter or unlock the composer before the backend confirms idle.
    void apiClient.post('/chat/stop', {sessionId: id}).catch(error => {
      useChatStore.getState().setStopping(id, false);
      toast.error(wt('停止失败'), error instanceof Error ? error.message : String(error));
    });
  }, []);

  const clearConversation = useCallback(async () => {
    const id = useSessionStore.getState().currentSessionId;
    const state = useChatStore.getState();
    if (!id) { state.activateSession(null); return; }
    if (state.clearingSessionId) return;
    if (sessionChat(state, id).isStreaming || requests.has(id)) throw new Error(wt('请先停止当前任务，再清空对话'));
    useChatStore.setState({clearingSessionId: id});
    try {
      const result = await apiClient.put<{replaced: boolean}>(`/sessions/${encodeURIComponent(id)}/messages`, {messages: []});
      if (!result?.replaced) throw new Error(wt('会话不存在或未能清空，请刷新后重试'));
      useChatStore.setState(current => ({
        historyRevisions: {...current.historyRevisions, [id]: (current.historyRevisions[id] ?? 0) + 1},
        sessions: {...current.sessions, [id]: {...sessionChat(current, id), messages: [], toolCalls: {}}},
        ...(current.messagesSessionId === id ? {messages: [], toolCalls: {}} : {}),
      }));
      useSessionStore.setState(current => ({sessions: current.sessions.map(s => s.id === id ? {...s, messageCount: 0, updatedAt: Date.now()} : s)}));
    } finally { useChatStore.setState({clearingSessionId: null}); }
  }, []);
  return {messages, isStreaming, isStopping, streamingContent, isClearing, sendMessage, stopStreaming, clearConversation};
}
