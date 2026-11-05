import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import './desktop-control.css';

interface DesktopStatus {
  active?: boolean;
  mode?: 'visual' | 'uia';
  inputMode?: 'physical';
  phase: string;
  paused: boolean;
  available: boolean;
  sessionId?: string;
  title?: string;
  target?: { title: string };
  lastAction?: string;
  verification?: string;
}
export function DesktopControlBar() {
  useWorkbenchLanguage();
  const [state, setState] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState(false);
  const [pollError, setPollError] = useState(false);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  const mounted = useRef(false);
  const observationRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      // A request started during pause/resume could otherwise restore stale state.
      if (changing.current) {
        timer = setTimeout(() => void poll(), 1000);
        return;
      }
      const current = revision.current;
      const controller = new AbortController();
      observationRequest.current = controller;
      try {
        const next = await apiClient.get<DesktopStatus>('/automation/desktop/control', {
          signal: controller.signal, timeoutMs: 4000,
        });
        if (!stopped && current === revision.current) {
          setState(next);
          setPollError(false);
        }
      } catch {
        if (!stopped && !controller.signal.aborted && current === revision.current) setPollError(true);
      } finally {
        if (observationRequest.current === controller) observationRequest.current = null;
        if (!stopped) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      observationRequest.current?.abort();
      clearTimeout(timer);
    };
  }, []);
  const change = async (action: 'pause' | 'resume' | 'stop') => {
    if (changing.current) return;
    revision.current++;
    changing.current = true;
    observationRequest.current?.abort();
    setBusy(true);
    setError(false);
    try {
      const next = await apiClient.post<DesktopStatus>(`/automation/desktop/control/${action}`, {
        sessionId: state?.sessionId,
      });
      if (mounted.current) {
        setState(next);
        setPollError(false);
      }
    } catch {
      if (mounted.current) setError(true);
    } finally {
      revision.current++;
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const active = state?.active ?? Boolean(state && state.phase !== 'idle' && state.phase !== 'stopped');
  // Stopping a task releases ownership but retains the user's pause latch.
  // Keep its resume control visible so the next task is not permanently blocked.
  if (!active && !state?.paused && !pollError && !error) return null;
  const heading = pollError ? wt('桌面控制状态待确认')
    : state?.paused ? active ? wt('桌面控制已暂停') : wt('桌面控制已停止')
      : active ? wt('Wing 正在控制桌面') : wt('桌面控制状态待确认');
  return <section aria-label={wt('桌面操作')} className={`sky-desktop-control${state?.paused ? ' is-paused' : ''}${pollError ? ' is-disconnected' : ''}`}>
    <div className="sky-desktop-control__indicator" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="m5 3 14 10-7 1-3 7-4-18Z" />
      </svg>
    </div>
    <div className="sky-desktop-control__body">
      <div className="sky-desktop-control__heading" role="status" aria-live="polite">
        <strong>{heading}</strong>
      </div>
      {pollError && <p role="alert" className="sky-desktop-control__warning">{wt('桌面控制状态待确认')}</p>}
      {error && <p role="alert" className="sky-desktop-control__warning">{wt('未能更改桌面控制状态，请重试。')}</p>}
    </div>
    {(active || state?.paused) && <div className="sky-desktop-control__actions" aria-busy={busy}>
      <button type="button" className="sky-desktop-control__button" disabled={busy} onClick={() => void change(state?.paused ? 'resume' : 'pause')}>
        {state?.paused ? wt('允许继续操作') : wt('暂停并接管')}
      </button>
      {active && <button type="button" className="sky-desktop-control__button sky-desktop-control__stop" disabled={busy} onClick={() => void change('stop')}>
        <span aria-hidden="true">■</span> {wt('结束控制')}
      </button>}
    </div>}
  </section>;
}
