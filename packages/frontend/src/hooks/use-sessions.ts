// 会话 hook
import { useCallback, useEffect } from 'react';
import { useSessionStore, selectCurrentSession } from '@/stores/session-store';
import type { SessionInfo } from '@/types';

export interface UseSessionsReturn {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  currentSessionId: string | null;
  loading: boolean;
  error: string | null;
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => void;
  createSession: (title?: string) => Promise<string | null>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
}

export function useSessions(): UseSessionsReturn {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const loading = useSessionStore((s) => s.loading);
  const error = useSessionStore((s) => s.error);
  const loadSessionsFn = useSessionStore((s) => s.loadSessions);
  const selectSessionFn = useSessionStore((s) => s.selectSession);
  const createSessionFn = useSessionStore((s) => s.createSession);
  const deleteSessionFn = useSessionStore((s) => s.deleteSession);
  const renameSessionFn = useSessionStore((s) => s.renameSession);

  const currentSession = useSessionStore(selectCurrentSession);

  // 首次挂载加载会话列表
  useEffect(() => {
    loadSessionsFn();
  }, [loadSessionsFn]);

  const selectSession = useCallback(
    (id: string) => selectSessionFn(id),
    [selectSessionFn],
  );

  const createSession = useCallback(
    (title?: string) => createSessionFn(title),
    [createSessionFn],
  );

  const deleteSession = useCallback(
    (id: string) => deleteSessionFn(id),
    [deleteSessionFn],
  );

  const renameSession = useCallback(
    (id: string, title: string) => renameSessionFn(id, title),
    [renameSessionFn],
  );

  return {
    sessions,
    currentSession,
    currentSessionId,
    loading,
    error,
    loadSessions: loadSessionsFn,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
  };
}
