import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { wt } from '@/i18n/workbench-text';

type Template = { id: string; format: string; name: string; description: string };
export function OfficeTemplatePicker({ format, value, onChange, disabled = false }: {
  format: string; value: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    apiClient.get<Template[]>('/files/office/templates').then(items => { if (active) setTemplates(items); })
      .catch(() => { if (active) setError('模板暂时无法加载'); });
    return () => { active = false; };
  }, [retry]);
  return <fieldset className="w-full min-w-0" disabled={disabled}>
    <legend className="text-xs mb-2 opacity-70">{wt('选择模板')}</legend>
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      {(templates.length ? templates.filter(item => item.format === format) : [{ id: 'blank', format, name: '空白', description: '使用默认中文排版' }]).map(item =>
        <label key={item.id} className="rounded-lg border p-3 cursor-pointer" style={{ borderColor: value === item.id ? 'var(--accent)' : 'var(--border)', background: value === item.id ? 'var(--bg-tertiary)' : 'var(--bg-secondary)' }}>
          <span className="flex items-center gap-2 text-sm"><input type="radio" name="office-template" value={item.id} checked={value === item.id} onChange={() => onChange(item.id)} />{wt(item.name)}</span>
          <span className="block text-xs opacity-60 mt-1.5 leading-relaxed">{wt(item.description)}</span>
        </label>)}
    </div>
    {error && <div className="text-xs mt-2" role="status">{wt(error)} · <button type="button" onClick={() => setRetry(n => n + 1)}>{wt('重试')}</button></div>}
  </fieldset>;
}
