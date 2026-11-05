import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 路由绑定创建弹窗（对齐旧版 modal.js bindingCreate）
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface BindingFormValues {
  agentId: string;
  channel: string;
  accountId: string;
  peerId: string;
  guildId: string;
  teamId: string;
}

export interface BindingCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: BindingFormValues) => Promise<void> | void;
}

export function BindingCreateModal({ open, onClose, onSave }: BindingCreateModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<BindingFormValues>({
    agentId: '',
    channel: '',
    accountId: '',
    peerId: '',
    guildId: '',
    teamId: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open)
      setValues({ agentId: '', channel: '', accountId: '', peerId: '', guildId: '', teamId: '' });
  }, [open]);

  const validate = (): string | null => {
    if (!values.agentId.trim()) return wt('请填写目标 Agent ID');
    if (!values.channel.trim()) return wt('请填写匹配渠道');
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
          <Icon name="channel" size={18} /> {wt('添加路由绑定')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('添加中…') : wt('添加绑定')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('目标Agent ID *')}</label>
          <input
            className="input-field"
            placeholder={wt('例: support-bot / dev-agent')}
            value={values.agentId}
            onChange={(e) => setValues((s) => ({ ...s, agentId: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('匹配渠道 *')}</label>
          <input
            className="input-field"
            placeholder="telegram / discord / feishu / *"
            value={values.channel}
            onChange={(e) => setValues((s) => ({ ...s, channel: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('匹配账户ID (可选)')}</label>
          <input
            className="input-field"
            placeholder={wt('留空=不限制')}
            value={values.accountId}
            onChange={(e) => setValues((s) => ({ ...s, accountId: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('匹配对端ID (可选)')}</label>
          <input
            className="input-field"
            placeholder={wt('用户/群组ID')}
            value={values.peerId}
            onChange={(e) => setValues((s) => ({ ...s, peerId: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('匹配Guild ID (可选)')}</label>
          <input
            className="input-field"
            placeholder="Discord Guild ID"
            value={values.guildId}
            onChange={(e) => setValues((s) => ({ ...s, guildId: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('匹配Team ID (可选)')}</label>
          <input
            className="input-field"
            placeholder={wt('Slack/飞书 Team ID')}
            value={values.teamId}
            onChange={(e) => setValues((s) => ({ ...s, teamId: e.target.value }))}
          />
        </div>
      </div>
    </Modal>
  );
}

export default BindingCreateModal;
