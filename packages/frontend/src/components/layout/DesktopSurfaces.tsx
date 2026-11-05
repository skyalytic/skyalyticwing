import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { nativeInvoke } from '@/services/native-browser';
import { isTauri } from '@/services/tauri-bridge';
import { useApprovalStore } from '@/stores/approval-store';
import { useAskUserStore, type AskUserRequest } from '@/stores/ask-user-store';
import { AskUserModal } from '@/components/modals/AskUserModal';
import { ApprovalInlineCard } from '@/components/chat/ApprovalInlineCard';
import { ToastContainer } from '@/components/ui/Toast';
import { DesktopControlBar } from './DesktopControlBar';
import type { ToolApprovalRequest } from '@/types';

export const desktopSurface = new URLSearchParams(window.location.search).get('wingSurface');

/** One shell owns all surfaces. Each surface has no app-management IPC privilege. */
export function DesktopSurfaceCoordinator() {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const shown = new Map<string, string>();
    let approvalIds = ''; 
    const display = async (surface: string, visible: boolean, position = {}) => {
      const next = { surface, visible, ...position }, key = JSON.stringify(next);
      if (shown.get(surface) === key) return;
      await nativeInvoke('desktop_surface', next);
      shown.set(surface, key);
    };
    const poll = async () => {
      try {
        const [approvalResult, controlResult, questionResult] = await Promise.allSettled([
          apiClient.get<ToolApprovalRequest[]>('/approvals', { timeoutMs: 4000 }),
          apiClient.get<{ active: boolean; paused: boolean; inputMode?: string; platform?: string; cursor?: { x: number; y: number; visible: boolean } }>('/automation/desktop/control', { timeoutMs: 4000 }),
          apiClient.get<AskUserRequest[]>('/tools/ask-user/pending', { timeoutMs: 4000 }),
        ]);
        if (disposed) return;
        const updates: Promise<unknown>[] = [];
        // A desktop status failure must never hide a valid approval (or the reverse).
        if (approvalResult.status === 'fulfilled') {
          const approvals = approvalResult.value;
          for (const request of approvals) useApprovalStore.getState().addApproval(request);
          for (const old of useApprovalStore.getState().pendingApprovals) {
            if (!approvals.some(a => a.id === old.id)) useApprovalStore.getState().removeApproval(old.id);
          }
        }
        if (questionResult.status === 'fulfilled' && Array.isArray(questionResult.value)) useAskUserStore.getState().sync(questionResult.value);
        if (approvalResult.status === 'fulfilled' || questionResult.status === 'fulfilled') {
          const approvals = useApprovalStore.getState().pendingApprovals;
          const questions = useAskUserStore.getState().requests;
          const ids = [...approvals, ...questions].map(a => a.id).join(',');
          if (ids !== approvalIds) { shown.delete('approval'); approvalIds = ids; }
          updates.push(display('approval', approvals.length > 0 || questions.length > 0));
        }
        if (controlResult.status === 'fulfilled') {
          const control = controlResult.value;
          // Windows uses the tool's native overlay; other desktops use shell surfaces.
          updates.push(display('control', !!control.paused || (control.active && control.platform !== 'win32')));
          updates.push(display('effects', control.active && !control.paused && control.platform !== 'win32'));

        }
        await Promise.allSettled(updates);
      } catch { /* Retry; never clear pending approvals on a network or native window error. */ }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 500); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  return null;
}

export function DesktopSurfacePage() {
  const pending = useApprovalStore(s => s.pendingApprovals);
  const questions = useAskUserStore(s => s.requests);
  const [error, setError] = useState(false);
  useEffect(() => {
    // Reuse the existing content header as the drag handle; no second title bar.
    const drag = (event: MouseEvent) => {
      if (event.button !== 0 || !isTauri() || !(event.target instanceof Element)) return;
      if (event.target.closest('button, input, textarea, select, a')) return;
      if (event.target.closest('.modal-header, .sky-desktop-control__body, .sky-desktop-control__indicator')) {
        void nativeInvoke('plugin:window|start_dragging', {
          label: desktopSurface === 'approval' ? 'wing-approval' : 'wing-desktop-control',
        }).catch(() => setError(true));
      }
    };
    document.addEventListener('mousedown', drag);
    return () => document.removeEventListener('mousedown', drag);
  }, []);
  useEffect(() => {
    const close = () => {
      if (desktopSurface === 'approval') {
        void Promise.all(useApprovalStore.getState().pendingApprovals.map(r => useApprovalStore.getState().respondApproval(r.id, 'denied'))).catch(() => setError(true));
        void Promise.all(useAskUserStore.getState().requests.map(r => apiClient.post('/tools/ask-user/respond', { id: r.id, answer: [] }))).catch(() => setError(true));
      } else if (desktopSurface === 'control') void apiClient.post('/automation/desktop/control/stop', {}).catch(() => setError(true));
    };
    window.addEventListener('wing-surface-close', close);
    return () => window.removeEventListener('wing-surface-close', close);
  }, []);
  useEffect(() => {
    if (desktopSurface !== 'approval') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const requests = await apiClient.get<ToolApprovalRequest[]>('/approvals', { timeoutMs: 4000 });
        const asks = await apiClient.get<AskUserRequest[]>('/tools/ask-user/pending', { timeoutMs: 4000 });
        if (disposed) return;
        requests.forEach(r => useApprovalStore.getState().addApproval(r));
        useAskUserStore.getState().sync(asks);
        useApprovalStore.getState().pendingApprovals.forEach(r => {
          if (!requests.some(p => p.id === r.id)) useApprovalStore.getState().removeApproval(r.id);
        });
        setError(false);
      } catch { if (!disposed) setError(true); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 700); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, []);
  if (desktopSurface === 'pointer') return <svg aria-hidden="true" width="28" height="34" viewBox="0 0 28 34"><path d="M1 1v23l6-6 5 11 5-2-5-11h10Z" fill="#1eb6d8" stroke="white" strokeWidth="1.7" /></svg>;
  if (desktopSurface === 'edge') return <div className="sky-screen-edge" style={{ '--edge-angle': `${Number(new URLSearchParams(location.search).get('angle') || 180)}deg` } as React.CSSProperties} />;
  if (desktopSurface === 'control') return <main><DesktopControlBar /></main>;
  return <main style={{ padding: 20, overflow: 'auto', height: '100vh' }}>
    <ToastContainer />
    {error && <p role="alert">暂时无法连接 Wing，正在重试；尚未提交审批。</p>}
    {pending.map(request => <ApprovalInlineCard key={request.id} request={request} />)}
    <AskUserModal allSessions />
    {!pending.length && !questions.length && !error && <p>当前没有待处理审批。</p>}
  </main>;
}
