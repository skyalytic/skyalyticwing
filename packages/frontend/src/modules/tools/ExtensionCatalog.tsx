import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { wt } from '@/i18n/workbench-text';

interface Entry { id?: string; name: string; installed: boolean; version?: string }
/** Package guides are not exposed as user skills or editable skill entries. */
export function ExtensionCatalog({ kind = 'tools', onChange }: { kind?: 'tools' | 'plugins' | 'skills'; onChange?: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const endpoint = kind === 'tools' ? '/extensions' : `/${kind}/catalog`;
  const load = useCallback(async () => {
    try { setEntries(await apiClient.get<Entry[]>(endpoint) || []); }
    catch (error) { toast.error(wt('加载失败'), error instanceof Error ? error.message : undefined); }
  }, [endpoint]);
  useEffect(() => { const refresh = () => { void load(); }; refresh(); window.addEventListener('wing:extensions-changed', refresh); return () => window.removeEventListener('wing:extensions-changed', refresh); }, [load]);
  async function change(entry: Entry) {
    const id = entry.id || entry.name, encoded = encodeURIComponent(id);
    setBusy(id);
    try {
      if (entry.installed) await apiClient.delete(kind === 'tools' ? `/extensions/${encoded}` : `/${kind}/${encoded}`);
      else await apiClient.post(kind === 'tools' ? `/extensions/${encoded}/install` : kind === 'plugins' ? `/plugins/${encoded}/install-bundled` : `/skills/${encoded}/install`, {});
      await load(); onChange?.();
      window.dispatchEvent(new Event('wing:extensions-changed'));
    } catch (error) { toast.error(wt('操作失败'), error instanceof Error ? error.message : undefined); }
    finally { setBusy(null); }
  }
  if (!entries.length) return null;
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
    {entries.map(entry => <div key={entry.id || entry.name} className="card p-3 flex items-center gap-3">
      <span className="flex-1">{entry.name}</span>
      <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === (entry.id || entry.name)} onClick={() => void change(entry)}>
        {entry.installed ? wt('卸载') : wt('安装')}
      </Button>
    </div>)}
  </div>;
}
