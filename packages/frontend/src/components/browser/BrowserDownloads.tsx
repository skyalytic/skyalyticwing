import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { wt } from '@/i18n/workbench-text';
import { apiClient } from '@/services/api-client';
import { nativeBrowser } from '@/services/native-browser';
import { useBrowserPanel } from '@/stores/browser-store';

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BrowserDownloads({ onClose }: { onClose: () => void }) {
  const downloads = useBrowserPanel((s) => s.downloads);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const items = [...downloads].reverse().filter((d) =>
    `${d.name} ${d.url || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const perform = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };
  const remove = async (id: string) => {
    await nativeBrowser('remove-download', { id });
    useBrowserPanel.setState((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }));
  };
  return <aside className="wing-browser-menu wing-browser-downloads" aria-label={wt('下载记录面板')}>
    <header><strong>{wt('下载')}</strong><button onClick={onClose} aria-label={wt('关闭下载记录')} title={wt('关闭')}>×</button></header>
    <input autoFocus type="search" aria-label={wt('搜索下载记录')} placeholder={wt('搜索下载记录')} value={query} onChange={(e) => setQuery(e.target.value)} />
    {error && <p role="alert" className="wing-download-error">{error}</p>}
    <div className="wing-download-list">
      {!items.length && <p className="wing-download-empty">{wt(query ? '没有匹配的下载记录' : '暂无下载')}</p>}
      {items.map((d) => {
        const percent = d.total_bytes && d.total_bytes > 0 && d.bytes != null ? Math.min(100, Math.max(0, Math.floor(d.bytes / d.total_bytes * 100))) : undefined;
        const finalizing = d.status === 'pending' && percent === 100;
        return <article key={d.id} className="wing-download-row">
        <span className={'wing-download-file ' + (d.status === 'pending' ? 'is-downloading' : '')} aria-hidden="true"><Icon name="file" size={19} /></span>
        <div className="wing-download-info">
          <button className="wing-download-name" disabled={d.status !== 'ready' || !d.path || !!busy} title={d.name} onClick={() => void perform(d.id, () => apiClient.post('/files/local-action', { path: d.path, action: 'open' }))}>{d.name}</button>
          <p title={d.error || undefined}>{wt(d.status === 'ready' ? '已下载' : d.status === 'failed' ? '下载失败' : finalizing ? '已接收文件，等待浏览器完成处理' : d.bytes === 0 && !d.total_bytes ? '正在获取文件大小…' : '下载中…')}
            {d.bytes != null && <> · {size(d.bytes)}{d.status === 'pending' && d.total_bytes ? ` / ${size(d.total_bytes)}` : ''}</>}
            {d.status === 'pending' && percent !== undefined && <> · {percent}%</>}
            {d.created_at ? <> · <time dateTime={new Date(d.created_at).toISOString()} title={new Date(d.created_at).toLocaleString()}>{new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></> : null}
          </p>
          {d.status === 'pending' && percent !== undefined && <div className="wing-download-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={wt('正在下载 {{name}}', { name: d.name })}><span style={{ width: `${percent}%` }} /></div>}
          {d.status === 'pending' && percent === undefined && <p>{wt('文件总大小未知')}</p>}
          {finalizing && /Win/i.test(navigator.platform) && <button disabled={!!busy} onClick={() => void perform(d.id, async () => { await nativeBrowser('download-dialog'); onClose(); })}>{wt('查看浏览器下载提示')}</button>}
          {d.status === 'failed' && d.error && <p className="wing-download-error">{d.error}</p>}
        </div>
        <div className="wing-download-actions">
          {d.status === 'ready' && d.path && <button disabled={!!busy} title={wt('打开所在文件夹')} aria-label={wt('打开所在文件夹：{{name}}', { name: d.name })} onClick={() => void perform(d.id, () => apiClient.post('/files/local-action', { path: d.path, action: 'reveal' }))}><Icon name="folder" size={15} /></button>}
          {d.status !== 'pending' && <button disabled={!!busy} title={wt('删除记录，不删除文件')} aria-label={wt('删除下载记录：{{name}}', { name: d.name })} onClick={() => void perform(d.id, () => remove(d.id))}><Icon name="trash" size={15} /></button>}
        </div>
      </article>;
      })}
    </div>
    <footer><span>{wt('删除记录不会删除文件')}</span><button disabled={!!busy || !downloads.some((d) => d.status !== 'pending')} onClick={() => void perform('clear', async () => { await nativeBrowser('clear-downloads'); useBrowserPanel.setState((s) => ({ downloads: s.downloads.filter((d) => d.status === 'pending') })); })}>{wt('清除已结束记录')}</button></footer>
  </aside>;
}
