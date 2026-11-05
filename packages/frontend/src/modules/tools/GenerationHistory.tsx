import { useCallback, useState } from 'react';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { Modal } from '@/components/ui/Modal';
import { VideoTasksPanel } from './VideoTasksPanel';
export function GenerationHistory() {
  useWorkbenchLanguage();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="px-4 py-1 text-right shrink-0">
      <button className="btn-secondary text-xs" onClick={() => setOpen(true)}>
        {wt('生成记录')}
      </button>
      {/* Portal outside clipped panes; the shared modal layer sits above window chrome. */}
      <Modal open={open} onClose={close} title={wt('生成记录')} width={900}
        footer={<button className="btn-secondary" onClick={close}>{wt('返回对话')}</button>}>
        <div className="text-left min-w-0"><VideoTasksPanel /></div>
      </Modal>
    </div>
  );
}
