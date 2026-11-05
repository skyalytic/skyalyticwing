import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 自定义工具添加弹窗（对齐旧版 modal.js addTool）
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface AddToolFormValues {
  id: string;
  name: string;
  description: string;
  category: string;
  permission: string;
  endpoint: string;
}

export interface AddToolModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: AddToolFormValues) => Promise<void> | void;
}

const CATEGORIES = [
  {
    value: 'system',
    get label() {
      return wt('系统管理');
    },
  },
  {
    value: 'file',
    get label() {
      return wt('文件操作');
    },
  },
  {
    value: 'command',
    get label() {
      return wt('命令执行');
    },
  },
  {
    value: 'network',
    get label() {
      return wt('网络工具');
    },
  },
  {
    value: 'interactive',
    get label() {
      return wt('交互工具');
    },
  },
  {
    value: 'code',
    get label() {
      return wt('代码工具');
    },
  },
];

const PERMISSIONS = [
  {
    value: 'ask',
    get label() {
      return wt('需确认');
    },
  },
  {
    value: 'auto',
    get label() {
      return wt('自动');
    },
  },
];

export function AddToolModal({ open, onClose, onSave }: AddToolModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<AddToolFormValues>({
    id: '',
    name: '',
    description: '',
    category: 'system',
    permission: 'ask',
    endpoint: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open)
      setValues({
        id: '',
        name: '',
        description: '',
        category: 'system',
        permission: 'ask',
        endpoint: '',
      });
  }, [open]);

  const validate = (): string | null => {
    if (!values.id.trim()) return wt('请输入工具ID');
    if (!values.name.trim()) return wt('请输入工具名称');
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
          <Icon name="tool" size={18} /> {wt('添加自定义工具')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('添加中…') : wt('添加')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('工具ID *')}</label>
          <input
            className="input-field"
            placeholder={wt('例: my_tool, custom_search')}
            value={values.id}
            onChange={(e) => setValues((s) => ({ ...s, id: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('工具名称')}</label>
          <input
            className="input-field"
            placeholder={wt('显示名称')}
            value={values.name}
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('描述')}</label>
          <input
            className="input-field"
            placeholder={wt('工具功能描述')}
            value={values.description}
            onChange={(e) => setValues((s) => ({ ...s, description: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('分类')}</label>
            <select
              className="input-field"
              value={values.category}
              onChange={(e) => setValues((s) => ({ ...s, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('默认权限')}</label>
            <select
              className="input-field"
              value={values.permission}
              onChange={(e) => setValues((s) => ({ ...s, permission: e.target.value }))}
            >
              {PERMISSIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('接口地址 (API端点)')}</label>
          <input
            className="input-field"
            placeholder="http://127.0.0.1:19111/api/your-tool"
            value={values.endpoint}
            onChange={(e) => setValues((s) => ({ ...s, endpoint: e.target.value }))}
          />
        </div>
      </div>
    </Modal>
  );
}

export default AddToolModal;
