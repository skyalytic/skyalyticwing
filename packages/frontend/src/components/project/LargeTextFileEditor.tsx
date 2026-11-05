import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { Button } from '@/components/ui/Button';
import { registerFileCloseGuard, registerPendingDraftCheck } from './file-tab-lifecycle';
import { SpinnerWrap } from '@/components/ui/Spinner';
const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));
type Page = { offset: number; end: number; size: number; content: string; revision: string; segmentHash: string };
type Patch = Page & { path: string };
type Job = { state: 'saving' | 'saved' | 'error'; copied: number; total: number; error?: string; result?: Page };
const PAGE_BYTES = 256 * 1024;
const READ_BYTES = 128 * 1024;
const memoryDrafts = new Map<string, { page: Page; content: string }>();
registerPendingDraftCheck(() => memoryDrafts.size > 0);
const sizeText = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(2)} MiB`;

export function LargeTextFileEditor({ filePath }: { filePath: string }) {
  useWorkbenchLanguage();
  const [page, setPage] = useState<Page>();
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Job>();
  const [draftSaved, setDraftSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [jump, setJump] = useState('0');
  const current = useRef('');
  const pageRef = useRef<Page>();
  const timer = useRef<number>();
  const alive = useRef(true);
  const posting = useRef(false);
  const needsSubmit = useRef(false);
  const submitRef = useRef<() => Promise<void>>(async () => {});
  const show = (p: Page, value = p.content) => { pageRef.current = p; current.current = value; setPage(p); setContent(value); };
  const load = useCallback(async (offset: number) => {
    setLoading(true); setError('');
    try {
      const p = await apiClient.get<Page>(`/files/text-page?path=${encodeURIComponent(filePath)}&offset=${offset}`);
      if (alive.current) { show(p); setJob(undefined); setDraftSaved(false); }
    } catch (e) { if (alive.current) setError(String(e instanceof Error ? e.message : e)); }
    finally { if (alive.current) setLoading(false); }
  }, [filePath]);
  const submit = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (posting.current) { needsSubmit.current = true; return; }
    const base = pageRef.current, batch = current.current;
    if (!base || (batch === base.content && !memoryDrafts.has(filePath))) return;
    if (new TextEncoder().encode(batch).length > PAGE_BYTES) {
      if (alive.current) setError(wt('当前分段超过 256 KiB，请缩小本次编辑范围；草稿仍保留。'));
      return;
    }
    posting.current = true; needsSubmit.current = false;
    if (alive.current) { setSending(true); setError(''); }
    try {
      const result = await apiClient.post<{ id: string }>('/files/text-autosave', { path: filePath, offset: base.offset, end: base.end, revision: base.revision, segmentHash: base.segmentHash, content: batch });
      if (alive.current) { setJobId(result.id); setJob({ state: 'saving', copied: 0, total: base.size }); setDraftSaved(current.current === batch); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally {
      posting.current = false;
      if (alive.current) setSending(false);
      // Flush edits that arrived while the durable draft request was in flight, also after switching files.
      if (needsSubmit.current || current.current !== batch) void submitRef.current();
    }
  }, [filePath]);
  submitRef.current = submit;
  useEffect(() => registerFileCloseGuard(filePath, async () => {
    if (!memoryDrafts.has(filePath)) return;
    await submitRef.current();
    for (let n = 0; memoryDrafts.has(filePath) && n < 40; n++) await new Promise(r => setTimeout(r, 250));
    if (memoryDrafts.has(filePath)) throw Error(wt('修改尚未保存，请处理保存提示后再关闭。'));
  }), [filePath]);
  useEffect(() => {
    alive.current = true;
    const init = async () => {
      try {
        const recovery = await apiClient.get<{ patch?: Patch; jobId?: string }>(`/files/text-draft?path=${encodeURIComponent(filePath)}`);
        if (!alive.current) return;
        const retained = memoryDrafts.get(filePath);
        if (retained) { show(retained.page, retained.content); setLoading(false); setError(wt('已恢复未保存的草稿，请确认后重试保存。')); }
        else if (recovery.patch) {
          const p = recovery.patch;
          const info = await apiClient.get<Page>(`/files/text-page?path=${encodeURIComponent(filePath)}&offset=${p.offset}`);
          if (!alive.current) return;
          show({ ...info, offset: p.offset, end: p.end, revision: p.revision, segmentHash: p.segmentHash, content: '' }, p.content);
          setLoading(false); setDraftSaved(true);
          if (!recovery.jobId) setError(wt('已恢复未保存的草稿，请确认后重试保存。'));
        } else await load(0);
        if (recovery.jobId && alive.current) setJobId(recovery.jobId);
      } catch (e) { if (alive.current) { setLoading(false); setError(e instanceof Error ? e.message : String(e)); } }
    };
    void init();
    const warn = (e: BeforeUnloadEvent) => { if (memoryDrafts.has(filePath) && !draftSaved) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { alive.current = false; window.clearTimeout(timer.current); window.removeEventListener('beforeunload', warn); if (memoryDrafts.has(filePath)) void submitRef.current(); };
  }, [filePath, load]);
  useEffect(() => {
    if (!jobId) return;
    let active = true, pollTimer: number;
    const poll = async () => {
      try {
        const result = await apiClient.get<Job>(`/files/text-save/${encodeURIComponent(jobId)}`);
        if (!active) return;
        setJob(result);
        if (result.state === 'error') { setError(result.error || wt('保存失败，草稿已保留；文件被外部修改时不会强行覆盖。')); return; }
        if (result.state === 'saved' && result.result) {
          const p = result.result; pageRef.current = p; setPage(p);
          if (current.current === p.content) { memoryDrafts.delete(filePath); setDraftSaved(true); }
          else { memoryDrafts.set(filePath, { page: p, content: current.current }); }
          if (!posting.current) { setJobId(''); if (current.current !== p.content) void submitRef.current(); return; }
        }
        pollTimer = window.setTimeout(() => void poll(), 1000);
      } catch (e) { if (active) { setError(wt('保存状态暂时无法查询，将继续查询，不会重复提交。')); pollTimer = window.setTimeout(() => void poll(), 3000); } }
    };
    void poll(); return () => { active = false; window.clearTimeout(pollTimer); };
  }, [jobId, filePath]);
  const change = (value: string) => {
    current.current = value; setContent(value); setDraftSaved(false);
    if (pageRef.current) memoryDrafts.set(filePath, { page: pageRef.current, content: value });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void submitRef.current(), 1200);
  };
  const dirty = !!page && content !== page.content;
  const busy = sending || !!jobId;
  if (loading) return <SpinnerWrap label={wt('加载文件…')} />;
  if (!page) return <div className="p-4"><p role="alert">{error}</p><Button onClick={() => void load(0)}>{wt('重试')}</Button></div>;
  return <div className="sky-large-text-editor flex-1 flex flex-col min-h-0" style={{ minWidth: 0 }}>
    <div className="sky-file-toolbar">
      <span className="sky-file-name">{filePath.split(/[\\/]/).pop()} · {sizeText(page.size)}</span>
      <span role="status">{wt(job?.state === 'saving' ? (draftSaved ? '草稿已保存，正在写回文件…' : '正在保存…') : dirty ? '编辑中…（停顿自动保存）' : '文件已保存')}{job?.state === 'saving' && job.total > 0 ? ` ${Math.floor(job.copied / job.total * 100)}%` : ''}</span>
      <Button size="sm" onClick={() => void submit()}>{wt('立即保存')}</Button>
    </div>
    <div className="sky-code-editor-tools">
      <span>{wt('大文件分段编辑 · 查找仅限当前分段')}</span>
      <Button size="sm" disabled={dirty || busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - READ_BYTES))}>{wt('上一段')}</Button>
      <Button size="sm" disabled={dirty || busy || page.end >= page.size} onClick={() => void load(page.end)}>{wt('下一段')}</Button>
      <label>{wt('跳转位置（%）')} <input aria-label={wt('跳转位置（%）')} type="number" min="0" max="100" step="any" value={jump} onChange={e => setJump(e.target.value)} style={{ width: 65, color: 'var(--text-primary)', background: 'var(--bg-primary)', border: '1px solid var(--border)' }} /></label>
      <Button size="sm" disabled={dirty || busy || !Number.isFinite(Number(jump)) || Number(jump) < 0 || Number(jump) > 100} onClick={() => void load(Math.min(Math.max(0, page.size - READ_BYTES), Math.floor(page.size * Number(jump) / 100)))}>{wt('跳转')}</Button>
    </div>
    <p className="px-3 py-1 text-xs opacity-70">{wt('字节 {{start}}–{{end}} / {{total}}；自动保存草稿并在后台写回，保存期间可以继续编辑。', { start: page.offset, end: page.end, total: page.size })}</p>
    {error && <p role="alert" className="sky-file-save-error p-2 text-xs">{error}</p>}
    <Suspense fallback={<SpinnerWrap label={wt('加载编辑器…')} />}><CodeEditor key={page.offset} filePath={filePath} value={content} onChange={change} onSave={() => void submit()} segmented segmentOffset={page.offset} /></Suspense>
  </div>;
}
