import { useEffect, useRef, useState } from 'react';
import { OfficeTemplatePicker } from './OfficeTemplatePicker';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/services/api-client';
import { wt } from '@/i18n/workbench-text';

export function CreateEntryDialog({ directory, type, onClose, onCreated }: {
  directory: string; type: 'file' | 'dir'; onClose: () => void; onCreated: (path: string) => void;
}) {
  const [name, setName] = useState(type === 'file' ? '新建文件.txt' : '新建文件夹');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submitting = useRef(false);
  const officeFormat = type === 'file' ? /\.(docx|xlsx|pptx)$/i.exec(name)?.[1]?.toLowerCase() : undefined;
  const [template, setTemplate] = useState('blank');
  useEffect(() => setTemplate('blank'), [officeFormat]);
  const create = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const office = type === 'file' && /\.(docx|xlsx|pptx)$/i.exec(name);
      const result = await apiClient.post<{ path: string }>(office ? '/files/office/create' : '/files/create-entry', office
        ? { directory, name: name.slice(0, -office[0].length), format: office[1].toLowerCase(), template }
        : { directory, name, type });
      onCreated(result.path);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Modal open title={wt(type === 'file' ? '新建文件' : '新建文件夹')} onClose={() => { if (!submitting.current) onClose(); }} width={420}>
    <form onSubmit={e => { e.preventDefault(); void create(); }}>
      <p className="text-xs opacity-60 break-all mb-3">{directory}</p>
      <label className="text-sm">{wt('名称')}
        <input autoFocus className="input-field w-full mt-2" aria-label={wt('名称')} value={name} disabled={busy}
          onFocus={e => { const end = type === 'file' ? e.currentTarget.value.lastIndexOf('.') : -1; e.currentTarget.setSelectionRange(0, end > 0 ? end : e.currentTarget.value.length); }}
          onChange={e => setName(e.target.value)} />
      </label>
      {officeFormat && <div className="mt-4"><OfficeTemplatePicker format={officeFormat} value={template} onChange={setTemplate} disabled={busy} /></div>}
      {error && <p role="alert" className="text-red-500 text-sm mt-2">{error}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{wt('取消')}</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{wt(busy ? '正在创建…' : '创建')}</Button>
      </div>
    </form>
  </Modal>;
}
