import { wt } from '@/i18n/workbench-text';
import { browserApi } from '@/services/browser-api';
import { useBrowserPanel } from '@/stores/browser-store';
export function BrowserControls() {
  const busy = useBrowserPanel((s) => s.agentBusy),
    manual = useBrowserPanel((s) => s.manual);
  if (!busy || manual) return null;
  return (
    <div className="wing-browser-control" role="status">
      <span>{wt('AI 正在操作浏览器')}</span>
      <button
        onClick={() =>
          void browserApi
            .post('/builtin-browser/control', { manual: true })
            .then(() => useBrowserPanel.setState({ manual: true, agentBusy: false }))
            .catch((e) => useBrowserPanel.setState({ error: String(e.message || e) }))
        }
      >
        {wt('接管浏览器')}
      </button>
    </div>
  );
}
