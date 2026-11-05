import { wt } from '@/i18n/workbench-text';
import { apiClient } from './api-client';
import { useSessionStore } from '@/stores/session-store';
export const browserSession = () => useSessionStore.getState().currentSessionId || undefined;
export const browserApi = {
  async get<T>(path: string): Promise<T> {
    const sessionId = browserSession();
    const value = await apiClient.get<T>(
      path + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''),
    );
    if (browserSession() !== sessionId) throw new Error(wt('浏览器会话已切换'));
    return value;
  },
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const sessionId = browserSession();
    const value = await apiClient.post<T>(path, { ...body, sessionId });
    if (browserSession() !== sessionId) throw new Error(wt('浏览器会话已切换'));
    return value;
  },
};
