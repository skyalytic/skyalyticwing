import type { ReactNode, MouseEvent } from 'react';
import { BrandLogo } from '../BrandLogo';
import { isTauri, windowAction } from '@/services/tauri-bridge';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';

/** One row for window controls and workbench actions. Interactive children never drag. */
export function WindowTitlebar({ version = '2.1.0', children, actions }: {
  version?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  useWorkbenchLanguage();
  const desktop = isTauri();
  const startDrag = (event: MouseEvent<HTMLElement>) => {
    if (!desktop || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest('button, a, input, select, [role="button"], [data-no-window-drag]')) return;
    event.preventDefault();
    void windowAction(event.detail === 2 ? 'toggleMaximize' : 'startDragging');
  };
  return (
    <header className="titlebar sky-window-titlebar" onMouseDown={startDrag}>
      <div className="sky-window-brand" title={`SkyalyticWing v${version}`}>
        <BrandLogo className="titlebar-icon" />
        <span className="titlebar-title">SkyalyticWing <small>v{version}</small></span>
      </div>
      {children && <div className="sky-window-context">{children}</div>}
      <div className="sky-window-drag-space" aria-hidden="true" />
      {actions && <div className="sky-window-actions" data-no-window-drag>{actions}</div>}
      {desktop && <div className="titlebar-controls" data-no-window-drag>
        <button type="button" className="titlebar-btn" aria-label={wt('最小化')} title={wt('最小化')} onClick={() => void windowAction('minimize')}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" /></svg>
        </button>
        <button type="button" className="titlebar-btn" aria-label={wt('最大化或还原')} title={wt('最大化或还原')} onClick={() => void windowAction('toggleMaximize')}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" /></svg>
        </button>
        <button type="button" className="titlebar-btn close" aria-label={wt('关闭窗口')} title={wt('关闭窗口')} onClick={() => void windowAction('close')}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m1 1 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>}
    </header>
  );
}
