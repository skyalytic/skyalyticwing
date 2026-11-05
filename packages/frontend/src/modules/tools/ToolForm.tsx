import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工具动态专属表单：按工具名称渲染对应字段（恢复旧版 tool-panel 表单能力）
import { useEffect, useMemo, useState } from 'react';
import type { ToolListItem } from '@/types';

/** 单个字段定义 */
export interface ToolField {
  key: string;
  label: string;
  placeholder?: string;
  /** 控件类型，默认 'text' */
  type?: 'text' | 'textarea' | 'number' | 'select';
  options?: string[];
  rows?: number;
  defaultValue?: string | number;
  mono?: boolean;
  hint?: string;
}

/** 各工具的字段 schema（按工具 name 索引） */
const TOOL_FIELDS: Record<string, ToolField[]> = {
  file_read: [
    {
      key: 'filePath',
      get label() {
        return wt('文件路径');
      },
      placeholder: './path/to/file.txt',
      defaultValue: './',
      mono: true,
    },
  ],
  file_write: [
    {
      key: 'filePath',
      get label() {
        return wt('文件路径');
      },
      placeholder: './path/to/file.txt',
      defaultValue: './',
      mono: true,
    },
    {
      key: 'content',
      get label() {
        return wt('内容');
      },
      type: 'textarea',
      rows: 6,
      get placeholder() {
        return wt('文件内容…');
      },
      mono: true,
    },
  ],
  file_edit: [
    {
      key: 'filePath',
      get label() {
        return wt('文件路径');
      },
      placeholder: './path/to/file.txt',
      defaultValue: './',
      mono: true,
    },
    {
      key: 'searchStr',
      get label() {
        return wt('查找字符串');
      },
      get placeholder() {
        return wt('要查找的内容');
      },
      mono: true,
    },
    {
      key: 'replaceStr',
      get label() {
        return wt('替换字符串');
      },
      type: 'textarea',
      rows: 3,
      get placeholder() {
        return wt('替换为…');
      },
      mono: true,
    },
  ],
  file_delete: [
    {
      key: 'filePath',
      get label() {
        return wt('文件路径');
      },
      placeholder: './path/to/file.txt',
      defaultValue: './',
      mono: true,
      get hint() {
        return wt('危险：该操作将立即删除文件，请谨慎');
      },
    },
  ],
  directory_list: [
    {
      key: 'dirPath',
      get label() {
        return wt('目录路径');
      },
      placeholder: './',
      defaultValue: '.',
      mono: true,
    },
  ],
  glob: [
    {
      key: 'pattern',
      get label() {
        return wt('匹配模式');
      },
      placeholder: '**/*.ts',
      defaultValue: '*.*',
      mono: true,
    },
    {
      key: 'path',
      get label() {
        return wt('路径');
      },
      placeholder: './',
      defaultValue: '.',
      mono: true,
    },
  ],
  grep: [
    {
      key: 'pattern',
      get label() {
        return wt('匹配模式（正则）');
      },
      placeholder: 'TODO|FIXME',
      mono: true,
    },
    {
      key: 'path',
      get label() {
        return wt('路径');
      },
      placeholder: './',
      defaultValue: '.',
      mono: true,
    },
    {
      key: 'include',
      get label() {
        return wt('包含文件（glob）');
      },
      placeholder: '*.ts,*.tsx',
      mono: true,
    },
    {
      key: 'outputMode',
      get label() {
        return wt('输出模式');
      },
      type: 'select',
      options: ['content', 'files_with_matches', 'count'],
      defaultValue: 'content',
    },
  ],
  bash: [
    {
      key: 'command',
      get label() {
        return wt('命令');
      },
      placeholder: 'ls -la',
      mono: true,
    },
    {
      key: 'cwd',
      get label() {
        return wt('工作目录');
      },
      placeholder: '.',
      defaultValue: '.',
      mono: true,
    },
  ],
  powershell: [
    {
      key: 'command',
      get label() {
        return wt('命令');
      },
      placeholder: 'Get-Process',
      mono: true,
    },
    {
      key: 'cwd',
      get label() {
        return wt('工作目录');
      },
      placeholder: '.',
      defaultValue: '.',
      mono: true,
    },
  ],
  web_fetch: [
    { key: 'url', label: 'URL', placeholder: 'https://example.com', mono: true },
    {
      key: 'method',
      get label() {
        return wt('方法');
      },
      type: 'select',
      options: ['GET', 'POST'],
      defaultValue: 'GET',
    },
    {
      key: 'headers',
      get label() {
        return wt('请求头（JSON）');
      },
      type: 'textarea',
      rows: 3,
      placeholder: '{\n  "Authorization": "Bearer xxx"\n}',
      mono: true,
    },
    {
      key: 'body',
      get label() {
        return wt('请求体');
      },
      type: 'textarea',
      rows: 3,
      get placeholder() {
        return wt('请求体…');
      },
      mono: true,
    },
  ],
  web_search: [
    {
      key: 'query',
      get label() {
        return wt('搜索关键词');
      },
      get placeholder() {
        return wt('关键词');
      },
    },
    {
      key: 'maxResults',
      get label() {
        return wt('最大结果数');
      },
      type: 'number',
      defaultValue: 10,
    },
  ],
  api_call: [
    { key: 'url', label: 'URL', placeholder: 'https://api.example.com/endpoint', mono: true },
    {
      key: 'method',
      get label() {
        return wt('方法');
      },
      type: 'select',
      options: ['GET', 'POST', 'PUT', 'DELETE'],
      defaultValue: 'GET',
    },
    {
      key: 'headers',
      get label() {
        return wt('请求头（JSON）');
      },
      type: 'textarea',
      rows: 3,
      placeholder: '{\n  "Content-Type": "application/json"\n}',
      mono: true,
    },
    {
      key: 'body',
      get label() {
        return wt('请求体');
      },
      type: 'textarea',
      rows: 3,
      placeholder: '{\n  "key": "value"\n}',
      mono: true,
    },
  ],
  browser_open: [{ key: 'url', label: 'URL', placeholder: 'https://example.com', mono: true }],
  git_operation: [
    {
      key: 'command',
      get label() {
        return wt('Git 命令');
      },
      type: 'select',
      options: ['clone', 'pull', 'push', 'status', 'log', 'diff'],
      defaultValue: 'status',
    },
    {
      key: 'args',
      get label() {
        return wt('附加参数');
      },
      get placeholder() {
        return wt('自定义命令（覆盖上面的选择）');
      },
      mono: true,
      get hint() {
        return wt('填写后将覆盖上方选择的命令');
      },
    },
    {
      key: 'repoPath',
      get label() {
        return wt('仓库路径');
      },
      placeholder: '.',
      defaultValue: '.',
      mono: true,
    },
  ],
  http_request: [
    { key: 'url', label: 'URL', placeholder: 'https://api.example.com/endpoint', mono: true },
    {
      key: 'method',
      get label() {
        return wt('方法');
      },
      type: 'select',
      options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      defaultValue: 'GET',
    },
    {
      key: 'headers',
      get label() {
        return wt('请求头（JSON）');
      },
      type: 'textarea',
      rows: 3,
      placeholder: '{\n  "Content-Type": "application/json"\n}',
      mono: true,
    },
    {
      key: 'body',
      get label() {
        return wt('请求体');
      },
      type: 'textarea',
      rows: 3,
      placeholder: '{\n  "key": "value"\n}',
      mono: true,
    },
    {
      key: 'timeout',
      get label() {
        return wt('超时（ms）');
      },
      type: 'number',
      defaultValue: 30000,
    },
  ],
  code_build: [
    {
      key: 'language',
      get label() {
        return wt('语言');
      },
      type: 'select',
      options: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp'],
      defaultValue: 'javascript',
    },
    {
      key: 'code',
      get label() {
        return wt('代码');
      },
      type: 'textarea',
      rows: 8,
      get placeholder() {
        return wt('要执行的代码…');
      },
      mono: true,
    },
    {
      key: 'stdin',
      get label() {
        return wt('标准输入');
      },
      type: 'textarea',
      rows: 3,
      get placeholder() {
        return wt('可选 stdin…');
      },
      mono: true,
    },
  ],
  env_get: [
    {
      key: 'key',
      get label() {
        return wt('变量名');
      },
      placeholder: 'PATH / HOME / NODE_ENV',
      mono: true,
    },
  ],
  env_set: [
    {
      key: 'key',
      get label() {
        return wt('变量名');
      },
      placeholder: 'NODE_ENV',
      mono: true,
    },
    {
      key: 'value',
      get label() {
        return wt('值');
      },
      placeholder: 'production',
      mono: true,
    },
  ],
  process_list: [],
  process_kill: [
    {
      key: 'pid',
      get label() {
        return wt('进程 PID');
      },
      type: 'number',
      placeholder: 'PID',
      mono: true,
      get hint() {
        return wt('此操作将立即终止该进程！');
      },
    },
    {
      key: 'signal',
      get label() {
        return wt('信号');
      },
      placeholder: 'SIGTERM',
      defaultValue: 'SIGTERM',
      mono: true,
    },
  ],
  show_message: [
    {
      key: 'title',
      get label() {
        return wt('标题');
      },
      get placeholder() {
        return wt('标题（可选）');
      },
    },
    {
      key: 'message',
      get label() {
        return wt('消息');
      },
      type: 'textarea',
      rows: 3,
      get placeholder() {
        return wt('消息内容…');
      },
    },
    {
      key: 'type',
      get label() {
        return wt('类型');
      },
      type: 'select',
      options: ['info', 'warn', 'error'],
      defaultValue: 'info',
    },
  ],
  notify: [
    {
      key: 'title',
      get label() {
        return wt('标题');
      },
      get placeholder() {
        return wt('通知标题');
      },
    },
    {
      key: 'message',
      get label() {
        return wt('消息');
      },
      type: 'textarea',
      rows: 3,
      get placeholder() {
        return wt('通知内容…');
      },
    },
  ],
};

const processListHint = () => wt('列出所有运行中的进程（PID、名称、CPU 和内存使用）。');

/** 工具名归一化：kebab → 下划线（file-read → file_read，与旧版 id/表单 schema 一致） */
function normalizeName(name: string): string {
  return name.replace(/-/g, '_');
}

/** 收集字段默认值 */
function initValues(tool: ToolListItem): Record<string, string> {
  const fields = TOOL_FIELDS[normalizeName(tool.name)] ?? [];
  const values: Record<string, string> = {};
  for (const f of fields) {
    values[f.key] = f.defaultValue !== undefined ? String(f.defaultValue) : '';
  }
  return values;
}

export interface ToolFormProps {
  tool: ToolListItem;
  /** 提交时回调，传入收集好的参数对象 */
  onSubmit: (args: Record<string, unknown>) => void;
  /** 取消回调 */
  onCancel: () => void;
  /** 提交中 */
  loading?: boolean;
  /** 提交按钮文本 */
  submitLabel?: string;
}

export function ToolForm({
  tool,
  onSubmit,
  onCancel,
  loading,
  submitLabel = wt('执行'),
}: ToolFormProps) {
  useWorkbenchLanguage();
  const fields = useMemo(() => TOOL_FIELDS[normalizeName(tool.name)] ?? [], [tool.name]);
  const [values, setValues] = useState<Record<string, string>>(() => initValues(tool));

  // 切换工具时重置字段
  useEffect(() => {
    setValues(initValues(tool));
  }, [tool]);

  const setField = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 按工具类型收集并转换参数
    const args: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.key] ?? '';
      if (f.type === 'number') {
        if (raw === '') continue;
        const n = Number(raw);
        args[f.key] = Number.isNaN(n) ? raw : n;
      } else if (raw !== '') {
        args[f.key] = raw;
      }
    }
    onSubmit(args);
  };

  // 无参数工具（如 process_list）
  if (fields.length === 0) {
    return (
      <form onSubmit={handleSubmit} className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {tool.description ? wt(tool.description) : processListHint()}
        </p>
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={loading}>
            {wt('关闭')}
          </button>
          <button type="submit" className="btn-primary" disabled={loading}>
            {submitLabel}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {fields.map((f) => {
        const id = `tf-${tool.name}-${f.key}`;
        return (
          <div key={f.key}>
            <label
              htmlFor={id}
              className="block text-sm mb-1"
              style={{ color: 'var(--text-secondary)' }}
            >
              {f.label}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                id={id}
                rows={f.rows ?? 3}
                className={`input-field ${f.mono ? 'font-mono text-xs' : ''}`}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            ) : f.type === 'select' ? (
              <select
                id={id}
                className="input-field"
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              >
                {(f.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={f.type === 'number' ? 'number' : 'text'}
                className={`input-field ${f.mono ? 'font-mono text-xs' : ''}`}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            )}
            {f.hint ? (
              <div
                className="text-xs mt-1"
                style={{
                  color:
                    (f.key === 'filePath' && tool.name === 'file_delete') || f.key === 'pid'
                      ? 'var(--error)'
                      : 'var(--text-muted)',
                }}
              >
                {f.hint}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="flex gap-2 justify-end pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={loading}>
          {wt('关闭')}
        </button>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? wt('执行中…') : submitLabel}
        </button>
      </div>
    </form>
  );
}
