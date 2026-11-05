import { useEffect, useRef, useState, type ReactNode } from 'react';
import { wt } from '@/i18n/workbench-text';
import './preview-controls.css';

export const clampPreviewZoom = (value: number) => Math.min(4, Math.max(0.1, Math.round(value * 100) / 100));
export function ZoomControls({ scale, onChange, onFit }: { scale: number; onChange: (value: number) => void; onFit: () => void }) {
  return <div className="preview-zoom" role="group" aria-label={wt('预览缩放')}>
    <button aria-label={wt('缩小预览')} disabled={scale <= 0.1} onClick={() => onChange(clampPreviewZoom(scale - 0.1))}>−</button>
    <span aria-label={wt('当前缩放比例')}>{Math.round(scale * 100)}%</span>
    <button aria-label={wt('放大预览')} disabled={scale >= 4} onClick={() => onChange(clampPreviewZoom(scale + 0.1))}>＋</button>
    <button onClick={() => onChange(1)}>100%</button>
    <button onClick={onFit}>{wt('适应窗口')}</button>
  </div>;
}

/** Top-layer expansion keeps the same editor/iframe mounted, including unsaved edits. */
export function PreviewFrame({ children, actions, label, expand = true }: { children: ReactNode; actions?: ReactNode; label?: string; expand?: boolean }) {
  const [wide, setWide] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (!node || !wide) return;
    const previous = document.activeElement as HTMLElement | null;
    if (node.showPopover) { node.setAttribute('popover', 'manual'); node.showPopover(); }
    node.querySelector<HTMLButtonElement>('[data-preview-close]')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setWide(false); }
      if (event.key === 'Tab') {
        const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea,iframe,[tabindex="0"]')].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keys, true);
    return () => {
      window.removeEventListener('keydown', keys, true);
      if (node.hasAttribute('popover')) { node.hidePopover?.(); node.removeAttribute('popover'); }
      previous?.focus();
    };
  }, [wide]);
  return <div ref={frame} className={`preview-frame${wide ? ' preview-expanded' : ''}`} role={wide ? 'dialog' : undefined} aria-modal={wide || undefined} aria-label={label}>
    <div className="preview-toolbar">{actions}{expand && <button data-preview-close className="preview-expand" onClick={() => setWide(v => !v)}>{wt(wide ? '收起预览' : '扩大预览')}</button>}</div>
    {children}
  </div>;
}
