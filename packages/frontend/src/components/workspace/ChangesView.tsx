import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { authHeaders } from '@/services/auth-token';
import { useProjectPanel } from '@/stores/project-panel-store';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { GitChangesView } from './GitChangesView';

interface Change { id: string; path: string; name: string; at: number; source: string; state: 'applied' | 'undone' | 'prepared'; before: { hash: string; size: number } | null; after: { hash: string; size: number } | null; binary: boolean }
interface Detail extends Change { officeText?: boolean; reviewNote?: string; diff: string; added: number; removed: number; compatible: boolean; reason: string }
export function ChangesView() {
  useWorkbenchLanguage();
  const dir = useProjectPanel(s => s.projectDir), setPickerOpen = useProjectPanel(s => s.setPickerOpen);
  const [view, setView] = useState('documents'), [changes, setChanges] = useState<Change[]>([]), [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const generation = useRef(0), listGeneration = useRef(0);
  const treeVersion = useProjectPanel(s => s.treeVersion);
  const lastTreeVersion = useRef(treeVersion);
  const load = useCallback(async () => {
    if (!dir) return;
    const run = ++listGeneration.current;
    try { const data = await apiClient.get<{ changes: Change[] }>(`/files/changes?dir=${encodeURIComponent(dir)}`); if (run !== listGeneration.current) return; setChanges(data.changes); setSelected(s => data.changes.some(c => c.id === s) ? s : data.changes[0]?.id || ''); }
    catch (e) { if (run === listGeneration.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [dir]);
  useEffect(() => { setChanges([]); setSelected(''); setDetail(null); void load(); return () => { listGeneration.current++; generation.current++; }; }, [load]);
  const select = useCallback(async (id: string) => {
    const run = ++generation.current; setConfirm(false); setDetail(null);
    if (!id) return;
    try { const data = await apiClient.get<Detail>(`/files/changes/${id}`); if (run === generation.current) setDetail(data); }
    catch (e) { if (run === generation.current) setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void select(selected); }, [selected, select]);
  useEffect(() => {
    if (lastTreeVersion.current === treeVersion) return;
    lastTreeVersion.current = treeVersion;
    void load();
    if (selected) void select(selected);
  }, [treeVersion, load, select, selected]);
  const refresh = async () => { setError(''); await load(); if (selected) await select(selected); };
  const restore = async () => {
    if (!detail || busy) return;
    setBusy(true); setError('');
    try { await apiClient.post(`/files/changes/${detail.id}/restore`, { state: detail.state }); setConfirm(false); await refresh(); useProjectPanel.getState().bumpTreeVersion(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); await select(detail.id); }
    finally { setBusy(false); }
  };
  const download = async (version: 'before' | 'after') => {
    if (!detail) return;
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE || '/api'}/files/changes/${detail.id}/snapshot?version=${version}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(wt('下载快照失败'));
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = (version === 'before' ? '修改前-' : '修改后-') + detail.path.split(/[\\/]/).pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <section className="sky-changes" aria-label={wt('文档变更')}>
    <header className="sky-changes-toolbar"><button aria-pressed={view === 'documents'} onClick={() => setView('documents')}>{wt('文档历史')}</button><button aria-pressed={view === 'git'} onClick={() => setView('git')}>Git</button><span />{view === 'documents' && <button disabled={busy} onClick={() => void refresh()}>{wt('刷新')}</button>}</header>
    {view === 'git' ? <GitChangesView /> : <>
      {error && <div className="sky-terminal-error" role="alert">{error}</div>}
      {!dir ? <div className="sky-changes-empty"><p>{wt('选择项目文件夹后查看文档变更')}</p><button onClick={() => setPickerOpen(true)}>{wt('选择项目文件夹')}</button></div> : !changes.length ? <div className="sky-changes-empty"><h3>{wt('还没有文档变更')}</h3><p>{wt('保存文档或让 AI 修改文件后，这里会显示修改前后版本。')}</p></div> : <div className="sky-changes-layout">
        <main className="sky-change-detail">
          {detail && <><header><strong title={detail.path}>{detail.path.split(/[\\/]/).pop()}</strong><span className="sky-diff-added">{(!detail.binary || detail.officeText) && `+${detail.added}`}</span><span className="sky-diff-removed">{(!detail.binary || detail.officeText) && `−${detail.removed}`}</span></header>
            <div className="sky-change-actions"><button disabled={busy || !detail.compatible} onClick={() => setConfirm(true)}>{detail.state === 'undone' ? wt('重做此变更') : wt('撤销此变更')}</button><button disabled={!detail.before} onClick={() => void download('before')}>{wt('下载修改前版本')}</button><button disabled={!detail.after} onClick={() => void download('after')}>{wt('下载修改后版本')}</button></div>
            {confirm && <div className="sky-restore-confirm" role="alertdialog" aria-label={wt('确认恢复文档')}><p>{detail.state === 'undone' ? wt('将恢复这次修改，之后仍可撤销。') : !detail.before ? wt('这次变更新建了文件，撤销会移除该文件，之后仍可重做。') : wt('将恢复修改前的完整文件，之后仍可重做。')}{wt('请先保存并关闭正在编辑此文件的窗口。')}</p><button disabled={busy} onClick={() => void restore()}>{wt('确认恢复')}</button><button disabled={busy} onClick={() => setConfirm(false)}>{wt('取消')}</button></div>}
            {detail.reason && <p className="sky-change-conflict">{detail.reason}</p>}
            {detail.reviewNote && <p className="sky-history-help">{detail.reviewNote}</p>}
            {detail.binary && !detail.officeText ? <div className="sky-binary-change"><h3>{wt('完整文件版本')}</h3><p>{wt('文档、表格、幻灯片及图片按完整文件保存。下载前后版本可查看版式和内容。')}</p><div>{wt('修改前')}：{detail.before ? `${detail.before.size.toLocaleString()} B` : wt('不存在')}</div><div>{wt('修改后')}：{detail.after ? `${detail.after.size.toLocaleString()} B` : wt('不存在')}</div></div> : <pre className="sky-change-diff">{detail.diff.split('\n').map((line, i) => <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'is-added' : line.startsWith('-') && !line.startsWith('---') ? 'is-removed' : line.startsWith('@@') ? 'is-hunk' : ''}><span className="sky-diff-line">{i + 1}</span>{line || ' '}</div>)}</pre>}
          </>}
        </main>
        <aside className="sky-changes-list" aria-label={wt('变更文件列表')}>{changes.map(c => <button key={c.id} aria-pressed={selected === c.id} onClick={() => { setError(''); setSelected(c.id); }}><strong>{c.name}</strong><span>{c.state === 'undone' ? wt('已撤销') : c.state === 'prepared' ? wt('操作中断') : !c.before ? wt('新增') : !c.after ? wt('删除') : wt('修改')} · {new Date(c.at).toLocaleString()}</span><small>{c.source}</small></button>)}</aside>
      </div>}
    </>}
  </section>;
}
