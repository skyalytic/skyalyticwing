import { useChatStore } from './chat-store';
import { wt } from '@/i18n/workbench-text';
// 会话状态 store
import { create } from 'zustand';
import { apiClient } from '@/services/api-client';
import type { ChatMessage, SessionInfo } from '@/types';

interface CreateSessionBody {
  title?: string;
  model?: string;
  agent?: string;
}

export interface SessionState {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  /** 当前对话使用的代理 ID（null = 主对话，无代理人设） */
  currentAgentId: string | null;
  loading: boolean;
  error: string | null;
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => void;
  /** 切换对话代理（null 回到主对话） */
  selectAgent: (id: string | null) => void;
  createSession: (title?: string, projectDir?: string) => Promise<string | null>;
  deleteSession: (id: string) => Promise<void>;
  loadMessages: (id: string) => Promise<ChatMessage[]>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** 置顶/取消置顶（置顶会话在侧栏列表最前） */
  pinSession: (id: string, pinned: boolean) => Promise<void>;
  /** 归档/取消归档（归档会话灰显收进折叠组） */
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  /** 从指定时间戳分叉新会话（复制该时刻前的消息），返回新会话 id */
  forkSession: (id: string, sinceTs: number) => Promise<string | null>;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  currentSessionId: null,
  currentAgentId: null,
  loading: false,
  error: null,

  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await apiClient.get<SessionInfo[]>('/sessions');
      set({ sessions: sessions ?? [], loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : wt('加载会话失败'),
      });
    }
  },

  selectSession: (id) => set({ currentSessionId: id }),

  selectAgent: (id) => set({ currentAgentId: id }),

  createSession: async (title, projectDir) => {
    try {
      const draft = get().sessions.find(s => s.id === get().currentSessionId);
      if (!title && draft?.messageCount === 0 && draft.title === 'New chat' &&
          (draft.projectDir || '') === (projectDir || '') && !draft.archived) return draft.id;
      const body: CreateSessionBody = {};
      if (title) body.title = title;
      const session = await apiClient.post<SessionInfo>('/sessions', body);
      if (projectDir) {
        try {
          const binding = await apiClient.post<{path: string}>('/files/project', { path: projectDir, sessionId: session.id });
          session.projectDir = binding.path;
        } catch (error) {
          await apiClient.delete(`/sessions/${session.id}`);
          throw error;
        }
      }
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
      }));
      return session.id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('创建会话失败') });
      return null;
    }
  },

  deleteSession: async (id) => {
    try {
      await apiClient.delete(`/sessions/${id}`);
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== id);
        const currentSessionId = state.currentSessionId === id ? null : state.currentSessionId;
        return { sessions, currentSessionId };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('删除会话失败') });
    }
  },

  loadMessages: async (id) => {
    try {
      const messages = await apiClient.get<ChatMessage[]>(`/sessions/${id}/messages`);
      return messages ?? [];
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('加载消息失败') });
      return [];
    }
  },

  renameSession: async (id, title) => {
    try {
      await apiClient.put(`/sessions/${id}/meta`, { title });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title, titleCustomized: true } : s)),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('重命名会话失败') });
    }
  },

  pinSession: async (id, pinned) => {
    try {
      await apiClient.put(`/sessions/${id}/meta`, { pinned });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, pinned } : s)),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('置顶失败') });
    }
  },

  archiveSession: async (id, archived) => {
    try {
      await apiClient.put(`/sessions/${id}/meta`, { archived });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, archived } : s)),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('归档失败') });
    }
  },

  forkSession: async (id, sinceTs) => {
    try {
      const forked = await apiClient.post<SessionInfo>(`/sessions/${id}/fork`, { sinceTs });
      if (!forked) return null;
      set((state) => ({
        sessions: [forked, ...state.sessions.filter((s) => s.id !== forked.id)],
        currentSessionId: forked.id,
      }));
      return forked.id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : wt('分叉会话失败') });
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));

// 便捷选择器
export const selectCurrentSession = (state: SessionState): SessionInfo | null => {
  if (!state.currentSessionId) return null;
  return state.sessions.find((s) => s.id === state.currentSessionId) ?? null;
};

// Switch the visible projection synchronously, before React effects or network replies run.
useSessionStore.subscribe((state, previous) => {
  if (state.currentSessionId !== previous.currentSessionId) useChatStore.getState().activateSession(state.currentSessionId);
});
