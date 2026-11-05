import { useState } from 'react';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
import { wt } from '@/i18n/workbench-text';
import './preview-controls.css';

export function FileActions({ filePath, directory = false, onDone }: { filePath: string; directory?: boolean; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (action: 'open' | 'reveal') => {
    setBusy(true); setError('');
    try { await apiClient.post('/files/local-action', { path: filePath, action }); onDone?.(); }
    catch (e) { const message = e instanceof Error ? e.message : String(e); setError(message); toast.error(wt('文件操作失败'), message); }
    finally { setBusy(false); }
  };
  return <div className="file-actions">
    <button disabled={busy} title={filePath} onClick={() => void act('reveal')}>{wt('打开所在文件夹')}</button>
    <button disabled={busy} onClick={() => void act('open')}>{wt(directory ? '打开此文件夹' : '用默认应用打开')}</button>
    {error && <span role="alert" className="text-red-500 break-all">{error}</span>}
  </div>;
}
