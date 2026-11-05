import { shortcutText } from '@/utils/shortcuts';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import './code-editor.css';
import { LargeTextFileEditor } from './LargeTextFileEditor';
import { PreviewFrame, ZoomControls } from './PreviewControls';
import { registerFileCloseGuard, registerPendingDraftCheck } from './file-tab-lifecycle';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type Draft = { content: string; revision?: string };
// Failed writes survive switching files; only a confirmed write removes a draft.
const unsavedDrafts = new Map<string, Draft>();
registerPendingDraftCheck(() => unsavedDrafts.size > 0);

export function TextFileEditor({ filePath, markdownMode = false }: { filePath: string; markdownMode?: boolean }) {
  useWorkbenchLanguage();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [size, setSize] = useState(0);
  const [segmented, setSegmented] = useState(false);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  const timer = useRef<number>();
  const current = useRef('');
  const saved = useRef('');
  const revision = useRef<string>();
  const saving = useRef(false);
  const failed = useRef(false);
  const alive = useRef(true);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (saving.current || current.current === saved.current) return;
    saving.current = true; failed.current = false;
    const batch = current.current;
    if (alive.current) { setSaveState('saving'); setSaveError(''); }
    try {
      const result = await apiClient.post<{ revision?: string }>('/files/write', { path: filePath, content: batch, revision: revision.current });
      revision.current = result.revision; saved.current = batch;
      const pending = unsavedDrafts.get(filePath);
      if (pending?.content === batch) unsavedDrafts.delete(filePath);
      else if (pending) pending.revision = result.revision;
      if (alive.current) setSaveState('saved');
    } catch (error) {
      failed.current = true;
      if (alive.current) { setSaveState('error'); setSaveError(error instanceof Error ? error.message : String(error)); }
    } finally {
      saving.current = false;
      if (!failed.current && current.current !== saved.current) void saveRef.current();
    }
  }, [filePath]);
  saveRef.current = save;
  useEffect(() => registerFileCloseGuard(filePath, async () => {
    for (let n = 0; saving.current && n < 100; n++) await new Promise(r => setTimeout(r, 50));
    await saveRef.current();
    if (saving.current || unsavedDrafts.has(filePath)) throw Error(wt('修改尚未保存，请处理保存提示后再关闭。'));
  }), [filePath]);
  useEffect(() => {
    let active = true;
    setLoading(true); setReadError('');
    apiClient.get<{ content: string; size: number; revision?: string; segmented?: boolean }>(`/files/read?path=${encodeURIComponent(filePath)}&editor=true`).then(data => {
      if (!active) return;
      if (data.segmented) { setSegmented(true); return; }
      const pending = unsavedDrafts.get(filePath);
      saved.current = data.content; current.current = pending?.content ?? data.content;
      revision.current = pending && pending.content !== data.content ? pending.revision : data.revision;
      setDraft(current.current); setSize(data.size);
      if (pending && pending.content !== data.content) {
        failed.current = true; setSaveState('error'); setSaveError(wt('已恢复未保存的草稿，请确认后重试保存。'));
      } else { unsavedDrafts.delete(filePath); failed.current = false; setSaveState('idle'); }
    }).catch(e => { if (active) setReadError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filePath, reloadKey]);
  useEffect(() => {
    alive.current = true;
    const beforeUnload = (e: BeforeUnloadEvent) => { if (unsavedDrafts.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive.current = false; window.clearTimeout(timer.current);
      window.removeEventListener('beforeunload', beforeUnload);
      if (!failed.current && current.current !== saved.current) void saveRef.current();
    };
  }, []);
  const change = (value: string) => {
    setDraft(value); current.current = value;
    unsavedDrafts.set(filePath, { content: value, revision: revision.current });
    window.clearTimeout(timer.current);
    if (value === saved.current && !saving.current) { unsavedDrafts.delete(filePath); setSaveState('idle'); return; }
    // A conflict or filesystem error requires an explicit retry; never silently overwrite.
    if (failed.current) return;
    setSaveState('pending'); timer.current = window.setTimeout(() => void save(), 600);
  };
  const name = filePath.split(/[\\/]/).pop() || filePath;
  const download = () => window.open(`/api/files/serve?path=${encodeURIComponent(filePath)}`, '_blank');
  if (loading) return <SpinnerWrap label={wt('加载文件…')} />;
  if (readError) return <div className="p-4"><p role="alert">{wt('读取失败:')} {readError}</p><Button size="sm" onClick={() => setReloadKey(k => k + 1)}>{wt('重试')}</Button></div>;
  if (segmented) return <LargeTextFileEditor key={filePath} filePath={filePath} />;
  return <div className="flex-1 flex flex-col min-h-0" style={{ minWidth: 0 }}>
    <div className="sky-file-toolbar">
      <span className="sky-file-name" title={filePath}>{name}</span>
      <span role="status" className={`sky-file-save-status ${saveState === 'error' ? 'sky-file-save-error' : ''}`}>
        {wt({ idle:'自动保存已开启', pending:'编辑中…（停顿自动保存）', saving:'保存中…', saved:'已自动保存', error:'自动保存失败' }[saveState])}
      </span>
      <Button size="sm" variant="ghost" disabled={saveState === 'saving'} onClick={() => void save()} title={shortcutText(wt('立即保存（Ctrl/⌘ S）'))}>{wt(saveState === 'error' ? '重试保存' : '保存')}</Button>
      {markdownMode && <Button size="sm" variant="ghost" onClick={() => setPreview(v => !v)}>{wt(preview ? '源代码' : '预览')}</Button>}
      <Button size="sm" variant="ghost" onClick={download}>{wt('下载')}</Button>
    </div>
    {saveState === 'error' && <div role="alert" className="sky-file-save-error p-2 text-xs">{wt('保存失败，草稿已保留；文件被外部修改时不会强行覆盖。')} {saveError}</div>}
    {preview ? <PreviewFrame label={name} actions={<ZoomControls scale={previewZoom} onChange={setPreviewZoom} onFit={() => setPreviewZoom(1)} />}><div className="preview-scroll"><div className="p-4" style={{ zoom: previewZoom }}><MarkdownRenderer content={draft} /></div></div></PreviewFrame> :
      <Suspense fallback={<SpinnerWrap label={wt('加载编辑器…')} />}><CodeEditor filePath={filePath} value={draft} onChange={change} onSave={() => void save()} /></Suspense>}
  </div>;
}
