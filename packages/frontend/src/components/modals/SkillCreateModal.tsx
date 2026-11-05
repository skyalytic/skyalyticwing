import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 技能创建弹窗（对齐旧版 modal.js skillCreate）
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface SkillFormValues {
  name: string;
  emoji: string;
  description: string;
  steps: string;
}

export interface SkillCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: SkillFormValues) => Promise<void> | void;
}

const SKILL_ICONS = [
  {
    value: 'skill',
    get label() {
      return wt('Skill 技能');
    },
  },
  {
    value: 'search',
    get label() {
      return wt('Search 搜索');
    },
  },
  {
    value: 'tool',
    get label() {
      return wt('Tool 工具');
    },
  },
  {
    value: 'file',
    get label() {
      return wt('File 文件');
    },
  },
  {
    value: 'code',
    get label() {
      return wt('Code 代码');
    },
  },
  {
    value: 'zap',
    get label() {
      return wt('Zap 闪电');
    },
  },
  {
    value: 'globe',
    get label() {
      return wt('Globe 全球');
    },
  },
  {
    value: 'shield',
    get label() {
      return wt('Shield 安全');
    },
  },
];

export function SkillCreateModal({ open, onClose, onSave }: SkillCreateModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<SkillFormValues>({
    name: '',
    emoji: 'skill',
    description: '',
    steps: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValues({ name: '', emoji: 'skill', description: '', steps: '' });
  }, [open]);

  const validate = (): string | null => {
    if (!values.name.trim()) return wt('请填写技能名称');
    if (!values.description.trim()) return wt('请填写描述');
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
          <Icon name="skill" size={18} /> {wt('创建新技能')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('创建中…') : wt('创建技能')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('技能名称 *')}</label>
          <input
            className="input-field"
            placeholder={wt('例: web-search / code-review / deploy')}
            value={values.name}
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('图标名称')}</label>
            <select
              className="input-field"
              value={values.emoji}
              onChange={(e) => setValues((s) => ({ ...s, emoji: e.target.value }))}
            >
              {SKILL_ICONS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('描述 *')}</label>
            <input
              className="input-field"
              placeholder={wt('简短描述技能用途')}
              value={values.description}
              onChange={(e) => setValues((s) => ({ ...s, description: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('操作步骤')}</label>
          <textarea
            className="input-field font-mono text-xs"
            rows={6}
            placeholder={wt(
              '## 操作步骤\n\n1. 第一步：用 knowledge_search 搜索\n2. 第二步：用 web_search 搜索网页\n3. 第三步：汇总结果返回',
            )}
            value={values.steps}
            onChange={(e) => setValues((s) => ({ ...s, steps: e.target.value }))}
          />
        </div>
      </div>
    </Modal>
  );
}

export default SkillCreateModal;
