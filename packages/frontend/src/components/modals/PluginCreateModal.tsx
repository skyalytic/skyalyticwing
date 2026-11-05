import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 插件创建弹窗（对齐旧版 modal.js pluginCreate），含代码预览
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export interface PluginFormValues {
  name: string;
  version: string;
  description: string;
  author: string;
  hooks: string[];
  tools: string;
  extraCode: string;
}

export interface PluginCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: PluginFormValues) => Promise<void> | void;
}

const HOOKS = ['onLoad', 'onUnload', 'beforeTool', 'afterTool', 'beforeChat', 'afterChat'];

export function PluginCreateModal({ open, onClose, onSave }: PluginCreateModalProps) {
  const language = useWorkbenchLanguage();
  const [values, setValues] = useState<PluginFormValues>({
    name: '',
    version: '1.0.0',
    description: '',
    author: 'SkyalyticWing User',
    hooks: [...HOOKS],
    tools: '',
    extraCode: '',
  });
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({
        name: '',
        version: '1.0.0',
        description: '',
        author: 'SkyalyticWing User',
        hooks: [...HOOKS],
        tools: '',
        extraCode: '',
      });
      setShowPreview(false);
    }
  }, [open]);

  const toggleHook = (h: string) =>
    setValues((s) => ({
      ...s,
      hooks: s.hooks.includes(h) ? s.hooks.filter((x) => x !== h) : [...s.hooks, h],
    }));

  const preview = useMemo(() => {
    const hooks = values.hooks
      .map((h) =>
        wt('  async {{v0}}(...args) {\n    // TODO: {{v1}} 实现\n    {{v2}}\n  }', {
          v0: h,
          v1: h,
          v2: h === 'onLoad' ? 'return true;' : 'return undefined;',
        }),
      )
      .join(',\n');
    return wt(
      '// 插件: {{v0}} v{{v1}}\n// 描述: {{v2}}\n// 作者: {{v3}}\nmodule.exports = {\n  name: {{v4}},\n  version: {{v5}},\n  description: {{v6}},\n  author: {{v7}},\n{{v8}}\n{{v9}}\n{{v10}}\n};\n',
      {
        v0: values.name || 'my-plugin',
        v1: values.version,
        v2: values.description || wt('暂无描述'),
        v3: values.author,
        v4: JSON.stringify(values.name || 'my-plugin'),
        v5: JSON.stringify(values.version || '1.0.0'),
        v6: JSON.stringify(values.description || ''),
        v7: JSON.stringify(values.author || ''),
        v8: hooks,
        v9: values.tools ? `,tools: ${values.tools}` : '',
        v10: values.extraCode ? `,extra: ${values.extraCode}` : '',
      },
    );
  }, [values, language]);

  const validate = (): string | null => {
    if (!values.name.trim()) return wt('请填写插件名称');
    if (values.tools.trim()) {
      try {
        JSON.parse(values.tools.replace(/'/g, '"'));
      } catch {
        return wt('自定义工具不是合法的 JSON');
      }
    }
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
      width={640}
      title={
        <span className="flex items-center gap-2">
          <Icon name="plugin" size={18} /> {wt('创建新插件')}
        </span>
      }
      footer={
        <>
          <button className="btn-secondary text-sm" onClick={() => setShowPreview((v) => !v)}>
            <span className="inline-flex items-center gap-1">
              <Icon name="edit" size={12} /> {wt('预览代码')}
            </span>
          </button>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {saving ? wt('生成中…') : wt('生成并安装')}
            </span>
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('插件名称 *')}</label>
            <input
              className="input-field"
              placeholder="my-awesome-plugin"
              value={values.name}
              onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('版本')}</label>
            <input
              className="input-field"
              value={values.version}
              onChange={(e) => setValues((s) => ({ ...s, version: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('描述')}</label>
          <input
            className="input-field"
            placeholder={wt('这个插件做什么？')}
            value={values.description}
            onChange={(e) => setValues((s) => ({ ...s, description: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('作者')}</label>
          <input
            className="input-field"
            value={values.author}
            onChange={(e) => setValues((s) => ({ ...s, author: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-2">{wt('启用钩子 (勾选需要的)')}</label>
          <div className="flex flex-wrap gap-3">
            {HOOKS.map((h) => (
              <label
                key={h}
                className="flex items-center gap-1.5 text-xs bg-gray-800 px-2 py-1 rounded cursor-pointer hover:bg-gray-700"
              >
                <input
                  type="checkbox"
                  checked={values.hooks.includes(h)}
                  onChange={() => toggleHook(h)}
                />{' '}
                {h}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('自定义工具 (可选)')}</label>
          <textarea
            className="input-field font-mono text-xs"
            rows={3}
            placeholder={wt(
              '[{name:"my_tool",description:"工具描述",execute:function(args){return{output:"result"};}}]',
            )}
            value={values.tools}
            onChange={(e) => setValues((s) => ({ ...s, tools: e.target.value }))}
          />
          <p className="text-[10px] text-gray-600 mt-1">
            {wt('JSON数组格式，每个工具有 name/description/execute 属性')}
          </p>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('额外代码 (高级)')}</label>
          <textarea
            className="input-field font-mono text-xs"
            rows={4}
            placeholder={wt('// 钩子函数体或辅助函数')}
            value={values.extraCode}
            onChange={(e) => setValues((s) => ({ ...s, extraCode: e.target.value }))}
          />
          <p className="text-[10px] text-gray-600 mt-1">
            {wt('钩子的具体实现代码，留空则使用默认空实现')}
          </p>
        </div>
        {showPreview ? (
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('代码预览')}</label>
            <pre className="bg-gray-900 text-gray-200 p-3 rounded border border-gray-700 text-xs max-h-60 overflow-auto whitespace-pre-wrap">
              {preview}
            </pre>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default PluginCreateModal;
