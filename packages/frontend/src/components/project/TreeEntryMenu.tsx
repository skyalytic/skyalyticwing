import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileActions } from './FileActions';
import { wt } from '@/i18n/workbench-text';

export type TreeMenuTarget = { path: string; directory: boolean; x: number; y: number };
export function TreeEntryMenu({ target, onClose, onCreate }: {
  target: TreeMenuTarget; onClose: () => void; onCreate: (type: 'file' | 'dir') => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    menu.current?.querySelector('button')?.focus();
    const close = (e: Event) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', keys);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', keys); window.removeEventListener('resize', onClose); previous?.focus(); };
  }, [onClose]);
  const zoom = Number(document.body.style.zoom) || 1;
  return createPortal(<div ref={menu} className="file-action-menu" role="menu" aria-label={wt(target.directory ? '文件夹操作' : '文件操作')}
    style={{ position: 'fixed', left: Math.max(8, Math.min(target.x / zoom, window.innerWidth / zoom - 240)), top: Math.max(8, Math.min(target.y / zoom, window.innerHeight / zoom - 220)) }}>
    <FileActions filePath={target.path} directory={target.directory} onDone={onClose} />
    {target.directory && <>
      <button role="menuitem" onClick={() => onCreate('file')}>{wt('新建文件')}</button>
      <button role="menuitem" onClick={() => onCreate('dir')}>{wt('新建文件夹')}</button>
    </>}
  </div>, document.body);
}
