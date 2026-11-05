import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作区文件编辑器弹窗（对齐旧版 modal.js wsEdit），保存/取消
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';

export interface WsEditModalProps {
  open: boolean;
  /** 文件名/路径 */
  filename: string;
  /** 可选：所属 Agent ID（用于 agentWsEdit 场景） */
  agentId?: string;
  initialContent?: string;
  onClose: () => void;
  onSave: (filename: string, content: string, agentId?: string) => Promise<void> | void;
}

export function WsEditModal({
  open,
  filename,
  agentId,
  initialContent = '',
  onClose,
  onSave,
}: WsEditModalProps) {
  useWorkbenchLanguage();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setContent(initialContent);
  }, [open, initialContent]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(filename, content, agentId);
    } finally {
      setSaving(false);
    }
  };

  const title = (
    <span className="flex items-center gap-2">
      {wt('编辑')}
      {filename}
      {agentId ? <span className="text-sm text-gray-400">({agentId})</span> : null}
    </span>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={title}
      closeOnOverlay={false}
      footer={
        <>
          <button className="btn-secondary text-sm" onClick={onClose} disabled={saving}>
            {wt('取消')}
          </button>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('保存中…') : wt('保存')}
          </button>
        </>
      }
    >
      <textarea
        className="w-full bg-gray-800 text-gray-200 p-3 rounded border border-gray-600 font-mono text-sm"
        style={{ height: 360 }}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
    </Modal>
  );
}

export default WsEditModal;
