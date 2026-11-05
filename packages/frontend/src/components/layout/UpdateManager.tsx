import { useEffect, useState } from 'react';
import { isTauri } from '@/services/tauri-bridge';
import { nativeInvoke } from '@/services/native-browser';
import { apiClient } from '@/services/api-client';
import { prepareAllFilesForUpdate } from '../project/file-tab-lifecycle';

type Notice = { id?: string; phase: string; message: string; version?: string; percent?: number };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export function UpdateManager() {
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false, request = '', stopped = false;
    const prepare = async (id: string) => {
      request = id; cancelled = false;
      try {
        await apiClient.post('/update/prepare', { id });
        for (;;) {
          if (cancelled || stopped) throw Error('已取消更新');
          const state = await apiClient.post<{ blockers: string[] }>('/update/status', { id });
          if (!state.blockers.length) break;
          setNotice({ phase: 'waiting', message: '等待任务结束：' + state.blockers.join('、'), id });
          await delay(750);
        }
        setNotice({ phase: 'saving', message: '正在保存打开的文档…', id });
        // Keep the backend lease alive while a large file is being written.
        const heartbeat = setInterval(() => { void apiClient.post('/update/status', { id }).catch(() => {}); }, 15_000);
        try { await prepareAllFilesForUpdate(); } finally { clearInterval(heartbeat); }
        if (cancelled || stopped) throw Error('已取消更新');
        for (;;) {
          const state = await apiClient.post<{ blockers: string[] }>('/update/status', { id });
          if (!state.blockers.length) break;
          if (cancelled || stopped) throw Error('已取消更新');
          setNotice({phase: 'saving', message: '等待文件写入完成：' + state.blockers.join('、'), id});
          await delay(750);
        }
        await apiClient.post('/update/freeze', { id });
        await nativeInvoke('update_prepared', { id, error: null });
        setNotice({ phase: 'installing', message: '正在备份并安装更新，请稍候…', id });
      } catch (error) {
        await apiClient.post('/update/cancel', { id }).catch(() => {});
        await nativeInvoke('update_prepared', { id, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      }
    };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Notice>).detail;
      setNotice(detail);
      if (detail.phase === 'prepare' && detail.id) void prepare(detail.id);
      if (detail.phase === 'error' || detail.phase === 'cancelled') {
        cancelled = true;
        if (request) void apiClient.post('/update/cancel', { id: request }).catch(() => {});
      }
      if (detail.phase === 'shutdown' && detail.id) {
        void apiClient.post('/update/shutdown', { id: detail.id }).then(() => nativeInvoke('update_prepared', { id: detail.id, error: null }))
          .catch(error => nativeInvoke('update_prepared', { id: detail.id, error: String(error) }));
      }
    };
    const cancel = () => {
      cancelled = true;
      if (request) void apiClient.post('/update/cancel', { id: request }).catch(() => {});
      void nativeInvoke('cancel_update', {}).catch(() => {});
    };
    window.addEventListener('wing-update', listener);
    window.addEventListener('wing-update-cancel', cancel);
    // The shell accepts this only for its own pending target version, after backend readiness.
    void apiClient.get('/health').then(() => nativeInvoke('update_healthy', {})).catch(() => {});
    return () => { stopped = true; cancel(); window.removeEventListener('wing-update', listener); window.removeEventListener('wing-update-cancel', cancel); };
  }, []);
  if (!notice) return null;
  const passive = ['available', 'error', 'cancelled', 'current'].includes(notice.phase);
  return <div role="dialog" aria-modal="true" aria-label="Wing 更新" style={{ position: 'fixed', zIndex: 100000, inset: 0, background: '#0006', display: 'grid', placeItems: 'center' }}>
    <div style={{ width: 'min(440px,90vw)', padding: 24, borderRadius: 12, background: 'var(--bg-primary)', color: 'var(--text-primary)', boxShadow: '0 16px 60px #0003' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Wing 更新{notice.version ? ` · ${notice.version}` : ''}</h2>
      <p role="status">{notice.message}</p>
      {typeof notice.percent === 'number' && <progress max={100} value={notice.percent} style={{ width: '100%' }} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
        {notice.phase === 'available' && <button className="btn btn-primary" onClick={() => { setNotice({phase:'downloading', message:'正在检查并下载更新…'}); void nativeInvoke('install_update', {}).catch(error => setNotice({phase:'error', message:String(error)})); }}>下载并更新</button>}
        {passive ? <button className="btn" onClick={() => setNotice(undefined)}>{notice.phase === 'available' ? '稍后' : '关闭'}</button> : !['installing', 'shutdown'].includes(notice.phase) && <button className="btn" onClick={() => window.dispatchEvent(new Event('wing-update-cancel'))}>取消更新</button>}
      </div>
      {notice.phase === 'waiting' && <button className="btn" onClick={() => window.dispatchEvent(new Event('wing-update-cancel'))}>返回处理任务或终端</button>}
    </div>
  </div>;
}
