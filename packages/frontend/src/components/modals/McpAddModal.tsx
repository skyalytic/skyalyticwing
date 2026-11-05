import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// MCP 服务器添加弹窗（对齐旧版 modal.js mcpAdd），含快速模板
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export type McpTransport = 'stdio' | 'http';

export interface McpFormValues {
  name: string;
  transport: McpTransport;
  command: string;
  cwd: string;
  args: string;
  url: string;
  enabled: boolean;
}

export interface McpAddModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: McpFormValues) => Promise<void> | void;
}

const TEMPLATES: Record<string, Partial<McpFormValues>> = {
  filesystem: {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-filesystem\n/',
  },
  github: {
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-github',
  },
  memory: {
    name: 'memory',
    transport: 'stdio',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-memory',
  },
  'brave-search': {
    name: 'brave-search',
    transport: 'stdio',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-brave-search',
  },
};

export function McpAddModal({ open, onClose, onSave }: McpAddModalProps) {
  useWorkbenchLanguage();
  const [values, setValues] = useState<McpFormValues>({
    name: '',
    transport: 'stdio',
    command: '',
    cwd: '',
    args: '',
    url: '',
    enabled: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({
        name: '',
        transport: 'stdio',
        command: '',
        cwd: '',
        args: '',
        url: '',
        enabled: true,
      });
    }
  }, [open]);

  const applyTemplate = (key: string) => {
    const t = TEMPLATES[key];
    if (t) setValues((s) => ({ ...s, ...t }));
  };

  const validate = (): string | null => {
    if (!values.name.trim()) return wt('请填写服务器名称');
    if (values.transport === 'stdio' && !values.command.trim()) return wt('请填写命令');
    if (values.transport === 'http' && !values.url.trim()) return wt('请填写服务器 URL');
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
      width={580}
      title={
        <span className="flex items-center gap-2">
          <Icon name="mcp" size={18} /> {wt('添加MCP服务器')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('注册中…') : wt('注册并启动')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('服务器名称 *')}</label>
          <input
            className="input-field"
            placeholder={wt('例: filesystem / github-copilot / custom-tool')}
            value={values.name}
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('传输方式')}</label>
          <select
            className="input-field"
            value={values.transport}
            onChange={(e) =>
              setValues((s) => ({ ...s, transport: e.target.value as McpTransport }))
            }
          >
            <option value="stdio">{wt('Stdio (子进程)')}</option>
            <option value="http">{wt('HTTP/SSE (远程连接)')}</option>
          </select>
        </div>
        {values.transport === 'stdio' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('命令 *')}</label>
                <input
                  className="input-field text-sm"
                  placeholder={wt('例: npx / node / python3')}
                  value={values.command}
                  onChange={(e) => setValues((s) => ({ ...s, command: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('工作目录(可选)')}</label>
                <input
                  className="input-field text-sm"
                  placeholder={wt('留空使用当前目录')}
                  value={values.cwd}
                  onChange={(e) => setValues((s) => ({ ...s, cwd: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{wt('参数 (每行一个)')}</label>
              <textarea
                className="input-field font-mono text-xs"
                rows={2}
                placeholder="--port=19111\n--allow-remote"
                value={values.args}
                onChange={(e) => setValues((s) => ({ ...s, args: e.target.value }))}
              />
            </div>
          </>
        ) : (
          <div>
            <label className="block text-xs text-gray-500 mb-1">{wt('服务器URL *')}</label>
            <input
              className="input-field text-sm"
              placeholder={wt('http://127.0.0.1:19111/mcp 或 https://api.example.com/mcp')}
              value={values.url}
              onChange={(e) => setValues((s) => ({ ...s, url: e.target.value }))}
            />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => setValues((s) => ({ ...s, enabled: e.target.checked }))}
          />
          {wt('注册后自动启动')}
        </label>
        <div className="bg-gray-800/60 rounded-lg p-3">
          <div className="text-xs text-gray-400 font-semibold mb-1">{wt('快速模板')}</div>
          <div className="flex flex-wrap gap-2 mt-1">
            {Object.keys(TEMPLATES).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => applyTemplate(key)}
                className="text-[11px] bg-blue-900/30 text-blue-300 px-2 py-1 rounded hover:bg-blue-900/50"
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default McpAddModal;
