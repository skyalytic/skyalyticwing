import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工具策略创建弹窗（对齐旧版 modal.js toolPolicyCreate）
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface ToolPolicyFormValues {
  name: string;
  allow: string;
  deny: string;
}

export interface ToolPolicyCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: ToolPolicyFormValues) => Promise<void> | void;
}

export function ToolPolicyCreateModal({ open, onClose, onSave }: ToolPolicyCreateModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<ToolPolicyFormValues>({ name: '', allow: '', deny: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValues({ name: '', allow: '', deny: '' });
  }, [open]);

  const validate = (): string | null => {
    if (!values.name.trim()) return wt('请填写策略名称');
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      toast.error(wt('表单校验失败'), err);
      return;
    }
    setSaving(true);
    try {
      await onSave(values);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={
        <span className="flex items-center gap-2">
          <Icon name="shield" size={18} /> {wt('创建工具策略')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('创建中…') : wt('创建策略')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('策略名称 *')}</label>
          <input
            className="input-field"
            placeholder={wt('例: safe-mode / readwrite')}
            value={values.name}
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            {wt('允许的工具 (逗号分隔，空=全部)')}
          </label>
          <input
            className="input-field"
            placeholder="bash, file_read, web_search"
            value={values.allow}
            onChange={(e) => setValues((s) => ({ ...s, allow: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            {wt('禁止的工具 (逗号分隔，支持通配符)')}
          </label>
          <input
            className="input-field"
            placeholder="desktop_*, send_file_to_user"
            value={values.deny}
            onChange={(e) => setValues((s) => ({ ...s, deny: e.target.value }))}
          />
        </div>
      </div>
    </Modal>
  );
}

export default ToolPolicyCreateModal;
