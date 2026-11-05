import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 代理编辑/创建弹窗（对齐旧版 modal.js agentEdit）
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface AgentFormValues {
  id: string;
  name: string;
  description: string;
  type: string;
  emoji: string;
  model: string;
  capabilities: string[];
}

export interface AgentEditModalProps {
  open: boolean;
  /** 编辑模式传入原代理；新建传 null */
  agent?: Partial<AgentFormValues> | null;
  isEdit?: boolean;
  /** 可用模型列表：{id,name,providerName,available} */
  models?: Array<{ id: string; name: string; providerName?: string; available?: boolean }>;
  onClose: () => void;
  onSave: (values: AgentFormValues) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
}

const CAPABILITIES = [
  'chat',
  'tool_use',
  'planning',
  'code_generation',
  'debugging',
  'refactoring',
  'review',
  'writing',
  'summarization',
  'translation',
  'formatting',
  'query',
  'visualization',
  'statistics',
  'reporting',
  'monitoring',
  'troubleshooting',
  'automation',
  'deployment',
  'search',
  'navigate',
  'analyze',
];

const AGENT_TYPES = [
  {
    value: 'primary',
    get label() {
      return wt('主代理');
    },
  },
  {
    value: 'specialist',
    get label() {
      return wt('专家');
    },
  },
  {
    value: 'researcher',
    get label() {
      return wt('研究员');
    },
  },
];

const AGENT_ICONS = [
  {
    value: 'agent',
    get label() {
      return wt('Agent 代理');
    },
  },
  {
    value: 'code',
    get label() {
      return wt('Code 代码专家');
    },
  },
  {
    value: 'doc',
    get label() {
      return wt('Doc 文档专家');
    },
  },
  {
    value: 'data',
    get label() {
      return wt('Data 数据分析师');
    },
  },
  {
    value: 'ops',
    get label() {
      return wt('Ops 运维专家');
    },
  },
  {
    value: 'explore',
    get label() {
      return wt('Explore 探索者');
    },
  },
];

export function AgentEditModal({
  open,
  agent,
  isEdit = false,
  models = [],
  onClose,
  onSave,
  onDelete,
}: AgentEditModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<AgentFormValues>({
    id: '',
    name: '',
    description: '',
    type: 'specialist',
    emoji: 'agent',
    model: '',
    capabilities: [],
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({
        id: agent?.id || '',
        name: agent?.name || '',
        description: agent?.description || '',
        type: agent?.type || 'specialist',
        emoji: agent?.emoji || 'agent',
        model: agent?.model || '',
        capabilities: agent?.capabilities || [],
      });
    }
  }, [open, agent]);

  const availModels = useMemo(() => (models || []).filter((m) => m.available !== false), [models]);

  const toggleCap = (c: string) =>
    setValues((s) => ({
      ...s,
      capabilities: s.capabilities.includes(c)
        ? s.capabilities.filter((x) => x !== c)
        : [...s.capabilities, c],
    }));

  const validate = (): string | null => {
    if (!values.id.trim()) return wt('请填写 ID');
    if (!values.name.trim()) return wt('请填写名称');
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

  const del = async () => {
    if (!onDelete || !values.id) return;
    setDeleting(true);
    try {
      await onDelete(values.id);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      title={<span className="text-blue-400">{isEdit ? wt('编辑代理') : wt('创建新代理')}</span>}
      footer={
        <>
          {isEdit && onDelete ? (
            <button
              className="btn-secondary text-sm"
              style={{ background: 'rgba(220,38,38,0.2)', color: 'var(--error)' }}
              onClick={del}
              disabled={deleting}
            >
              {deleting ? wt('删除中…') : wt('删除')}
            </button>
          ) : null}
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('保存中…') : wt('保存')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">ID *</label>
            <input
              className="input-field"
              value={values.id}
              placeholder={wt('例: my_agent')}
              readOnly={isEdit}
              onChange={(e) => setValues((s) => ({ ...s, id: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('名称 *')}</label>
            <input
              className="input-field"
              value={values.name}
              placeholder={wt('例: 我的助手')}
              onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('描述')}</label>
          <textarea
            className="input-field"
            rows={2}
            value={values.description}
            placeholder={wt('描述这个代理的用途...')}
            onChange={(e) => setValues((s) => ({ ...s, description: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('类型')}</label>
            <select
              className="input-field"
              value={values.type}
              onChange={(e) => setValues((s) => ({ ...s, type: e.target.value }))}
            >
              {AGENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('图标')}</label>
            <select
              className="input-field"
              value={values.emoji}
              onChange={(e) => setValues((s) => ({ ...s, emoji: e.target.value }))}
            >
              {AGENT_ICONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('模型')}</label>
          <select
            className="input-field"
            value={values.model}
            onChange={(e) => setValues((s) => ({ ...s, model: e.target.value }))}
          >
            {availModels.length === 0 ? (
              <option value="" disabled>
                {wt('未配置模型')}
              </option>
            ) : (
              availModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.providerName})
                </option>
              ))
            )}
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-2">{wt('能力标签')}</label>
          <div className="flex flex-wrap gap-y-2">
            {CAPABILITIES.map((c) => (
              <label key={c} className="flex items-center gap-1 text-xs mr-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={values.capabilities.includes(c)}
                  onChange={() => toggleCap(c)}
                />
                {c}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default AgentEditModal;
