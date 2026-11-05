import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { wt } from '@/i18n/workbench-text';
import { Icon } from '@/components/Icon';

export const PERMISSION_CHOICES = [
  { id: 'ask', label: '手动审批', desc: '重要操作由你确认；已允许的工具与命令免审批' },
  { id: 'auto', label: '自动审批', desc: '自动判断低风险操作，必要时向你询问' },
  { id: 'yolo', label: '完全访问', desc: '工具与命令直接执行，包括定时任务，不弹审批' },
] as const;
export function PermissionModePicker() {
  const [mode, setMode] = useState(''), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const load = () => { void apiClient.get<{ mode: string }>('/permissions').then(d => setMode(d.mode)).catch(e => setError(e.message)); };
    load(); window.addEventListener('sky-permissions-changed', load);
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => { window.removeEventListener('sky-permissions-changed', load); document.removeEventListener('pointerdown', away); };
  }, []);
  const select = async (id: string) => {
    setBusy(true); setError('');
    try { const d = await apiClient.put<{ mode: string }>('/permissions/mode', { mode: id }); setMode(d.mode); setOpen(false); window.dispatchEvent(new Event('sky-permissions-changed')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="sky-permission-picker" ref={root} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
    <button type="button" aria-haspopup="menu" aria-expanded={open} className={mode === 'yolo' ? 'is-full-access' : ''} onClick={() => setOpen(!open)}><Icon name="shield" size={14} /> {wt(PERMISSION_CHOICES.find(c => c.id === mode)?.label || '权限设置')} ▾</button>
    {open && <div className="sky-permission-menu" role="menu" aria-label={wt('操作审批方式')}>
      <strong>{wt('如何批准 AI 的操作？')}</strong>
      {PERMISSION_CHOICES.map(c => <button key={c.id} role="menuitemradio" aria-checked={mode === c.id} disabled={busy} onClick={() => void select(c.id)}><b>{wt(c.label)} {mode === c.id ? '✓' : ''}</b><small>{wt(c.desc)}</small></button>)}
      <p>{wt('全局生效。明确禁用、命令黑名单及系统权限仍有效。')}</p>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
