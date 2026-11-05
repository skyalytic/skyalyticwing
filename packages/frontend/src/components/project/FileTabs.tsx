import { useEffect, useRef, useState } from 'react';
import { useProjectPanel } from '@/stores/project-panel-store';
import { toast } from '@/components/ui/Toast';
import { wt } from '@/i18n/workbench-text';
import { prepareFileClose } from './file-tab-lifecycle';

export function FileTabs() {
  const { openFiles, currentFile, openFile, closeFile } = useProjectPanel();
  const [closing, setClosing] = useState<string[]>([]);
  const busy = useRef(new Set<string>()), strip = useRef<HTMLDivElement>(null);
  useEffect(() => { strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [currentFile]);
  const close = async (path: string) => {
    if (busy.current.has(path)) return;
    busy.current.add(path); setClosing([...busy.current]);
    try { await prepareFileClose(path); closeFile(path); }
    catch (e) { openFile(path); toast.error(wt('文件尚未关闭'), e instanceof Error ? e.message : String(e)); }
    finally { busy.current.delete(path); setClosing([...busy.current]); }
  };
  if (!openFiles.length) return null;
  return <div ref={strip} className="sky-file-tabs" role="tablist" aria-label={wt('已打开的文件')}>
    {openFiles.map((path, i) => {
      const name = path.split(/[\\/]/).pop() || path;
      const duplicate = openFiles.some(p => p !== path && p.split(/[\\/]/).pop() === name);
      const label = duplicate ? (path.split(/[\\/]/).slice(-2).join('/')) : name;
      return <div key={path} className={`sky-file-tab ${path === currentFile ? 'active' : ''}`}>
        <button role="tab" title={path} aria-selected={path === currentFile} tabIndex={path === currentFile || !currentFile && i === 0 ? 0 : -1}
          onClick={() => openFile(path)} onKeyDown={e => {
            const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (delta) { e.preventDefault(); const next = (i + delta + openFiles.length) % openFiles.length; openFile(openFiles[next]); strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }
            if (e.key === 'Delete') { e.preventDefault(); void close(path); }
          }}>{label}</button>
        <button className="sky-file-tab-close" disabled={closing.includes(path)} aria-label={wt('关闭文件') + ' ' + label} title={wt('关闭文件')} onClick={() => void close(path)}>{closing.includes(path) ? '…' : '×'}</button>
      </div>;
    })}
  </div>;
}
