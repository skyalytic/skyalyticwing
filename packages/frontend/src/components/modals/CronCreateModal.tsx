import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import i18n from '@/i18n';
// 定时任务创建弹窗（对齐旧版 modal.js cronCreate）
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';

export type CronTaskType = 'shell' | 'ai' | 'tool';

export interface CronFormValues {
  name: string;
  oneTime: boolean;
  expression: string;
  execAt: string;
  delayMin: string;
  taskType: CronTaskType;
  model: string;
  command: string;
  aiPrompt: string;
  toolName: string;
  toolArgs: string;
}

export interface CronCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: CronFormValues) => Promise<void> | void;
}

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  {
    get label() {
      return wt('每分钟');
    },
    expr: '* * * * *',
  },
  {
    get label() {
      return wt('每小时');
    },
    expr: '0 * * * *',
  },
  {
    get label() {
      return wt('每天 00:00');
    },
    expr: '0 0 * * *',
  },
  {
    get label() {
      return wt('每天 09:00');
    },
    expr: '0 9 * * *',
  },
  {
    get label() {
      return wt('每周一 09:00');
    },
    expr: '0 9 * * 1',
  },
  {
    get label() {
      return wt('每月1日 00:00');
    },
    expr: '0 0 1 * *',
  },
];

const TOOL_NAMES = [
  'bash',
  'powershell',
  'web_fetch',
  'file_read',
  'file_write',
  'git_operation',
  'browser_open',
  'http_request',
  'code_build',
];

const FIELD_LABELS = ['分钟', '小时', '日', '月', '周'];

/** 将 cron 表达式翻译为可读说明 */
export function explainCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return wt('请输入或选择上方预设');
  const [m, h, d, mo, w] = parts;
  const all = (v: string) => v === '*' || v === '*/1';
  if (all(m) && all(h) && d === '*' && mo === '*' && w === '*') return wt('每分钟执行');
  if (m !== '*' && /^\d+$/.test(m) && h === '*' && d === '*' && mo === '*' && w === '*')
    return wt('每小时的第 {{v0}} 分钟执行', { v0: m });
  if (/^\*\/(\d+)$/.test(m)) return wt('每 {{v0}} 分钟执行', { v0: RegExp.$1 });
  if (/^\*\/(\d+)$/.test(h)) return wt('每 {{v0}} 小时执行', { v0: RegExp.$1 });
  if (
    m !== '*' &&
    h !== '*' &&
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    d === '*' &&
    mo === '*' &&
    w === '*'
  )
    return wt('每天 {{v0}}:{{v1}} 执行', { v0: h.padStart(2, '0'), v1: m.padStart(2, '0') });
  if (m !== '*' && h !== '*' && w !== '*' && /^\d+$/.test(m) && /^\d+$/.test(h))
    return wt('每{{v0}} {{v1}}:{{v2}} 执行', {
      v0: new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + (Number(w) % 7))),
      ),
      v1: h.padStart(2, '0'),
      v2: m.padStart(2, '0'),
    });
  if (m !== '*' && h !== '*' && d !== '*' && mo === '*' && w === '*')
    return wt('每月 {{v0}} 日 {{v1}}:{{v2}} 执行', {
      v0: d,
      v1: h.padStart(2, '0'),
      v2: m.padStart(2, '0'),
    });
  return wt('分 {{v0}} · 时 {{v1}} · 日 {{v2}} · 月 {{v3}} · 周 {{v4}}', {
    v0: m,
    v1: h,
    v2: d,
    v3: mo,
    v4: w,
  });
}

export function CronCreateModal({ open, onClose, onSave }: CronCreateModalProps) {
  const language = useWorkbenchLanguage();
  const [values, setValues] = useState<CronFormValues>({
    name: '',
    oneTime: false,
    expression: '0 9 * * *',
    execAt: '',
    delayMin: '',
    taskType: 'shell',
    model: '',
    command: '',
    aiPrompt: '',
    toolName: 'bash',
    toolArgs: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({
        name: '',
        oneTime: false,
        expression: '0 9 * * *',
        execAt: '',
        delayMin: '',
        taskType: 'shell',
        model: '',
        command: '',
        aiPrompt: '',
        toolName: 'bash',
        toolArgs: '',
      });
    }
  }, [open]);

  const explanation = useMemo(
    () =>
      values.oneTime ? wt('一次性任务：到点执行一次后自动删除') : explainCron(values.expression),
    [values.oneTime, values.expression, language],
  );

  const validate = (): string | null => {
    if (!values.name.trim()) return wt('请填写任务名称');
    if (!values.oneTime) {
      if (!values.expression.trim()) return wt('请填写 cron 表达式');
      if (values.expression.trim().split(/\s+/).length !== 5)
        return wt('cron 表达式格式错误（应为 5 段）');
    }
    if (values.taskType === 'shell' && !values.command.trim()) return wt('请填写执行命令');
    if (values.taskType === 'ai' && !values.aiPrompt.trim()) return wt('请填写 AI 任务描述');
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
          <Icon name="cron" size={18} /> {wt('新建定时任务')}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {saving ? wt('创建中…') : wt('创建任务')}
            </span>
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('任务名称')}</label>
          <input
            className="input-field"
            placeholder={wt('例：每日备份 / AI内容审核 / B站巡检')}
            value={values.name}
            onChange={(e) => setValues((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            {wt('执行频率')}
            <span className="text-xs text-gray-600">{wt('(点击预设或手动输入)')}</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-green-400 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={values.oneTime}
              onChange={(e) => setValues((s) => ({ ...s, oneTime: e.target.checked }))}
            />
            {wt('一次性任务 (指定时间执行一次)')}
          </label>
          {!values.oneTime ? (
            <>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    type="button"
                    className={`text-[11px] px-2 py-1 rounded ${values.expression === p.expr ? 'bg-blue-900/40 text-blue-300' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    onClick={() => setValues((s) => ({ ...s, expression: p.expr }))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <input
                    type="text"
                    className="input-field font-mono text-sm"
                    placeholder="0 9 * * *"
                    value={values.expression}
                    onChange={(e) => setValues((s) => ({ ...s, expression: e.target.value }))}
                  />
                  <p className="text-[10px] text-gray-600 mt-1">
                    {wt('格式:')}
                    {FIELD_LABELS.map((label) => wt(label)).join(' ')}
                  </p>
                </div>
                <div className="bg-gray-800/60 rounded-lg p-2.5 text-xs border border-gray-700">
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">
                    {wt('含义解释')}
                  </div>
                  <div className="text-cyan-300">{explanation}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('指定执行时间')}</label>
                <input
                  type="datetime-local"
                  className="input-field text-sm"
                  value={values.execAt}
                  onChange={(e) => setValues((s) => ({ ...s, execAt: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('或 N 分钟后执行')}</label>
                <input
                  type="number"
                  min={1}
                  className="input-field text-sm"
                  placeholder="5"
                  value={values.delayMin}
                  onChange={(e) => setValues((s) => ({ ...s, delayMin: e.target.value }))}
                />
              </div>
              <p className="col-span-2 text-[10px] text-green-400/70">
                {wt('留空则1分钟后执行；指定时间优先')}
              </p>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('任务类型')}</label>
            <select
              className="input-field"
              value={values.taskType}
              onChange={(e) =>
                setValues((s) => ({ ...s, taskType: e.target.value as CronTaskType }))
              }
            >
              <option value="shell">{wt('Shell命令 (bash/shell)')}</option>
              <option value="ai">{wt('AI智能任务 (调用AI助手)')}</option>
              <option value="tool">{wt('工具调用 (指定工具)')}</option>
            </select>
          </div>
          {(values.taskType === 'ai' || values.taskType === 'tool') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">{wt('AI模型 (可选)')}</label>
              <input
                className="input-field text-sm"
                placeholder={wt('留空使用默认模型')}
                value={values.model}
                onChange={(e) => setValues((s) => ({ ...s, model: e.target.value }))}
              />
            </div>
          )}
        </div>
        {values.taskType === 'shell' && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('执行命令')}</label>
            <textarea
              className="input-field font-mono text-xs"
              rows={2}
              placeholder={wt('例: npm run build&#10;或: python script.py --daily')}
              value={values.command}
              onChange={(e) => setValues((s) => ({ ...s, command: e.target.value }))}
            />
            <p className="text-[10px] text-gray-600 mt-1">
              {wt('输入要执行的 Shell/PowerShell 命令')}
            </p>
          </div>
        )}
        {values.taskType === 'ai' && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('AI任务描述')}</label>
            <textarea
              className="input-field"
              rows={3}
              placeholder={wt('例: 检查系统状态并生成日报')}
              value={values.aiPrompt}
              onChange={(e) => setValues((s) => ({ ...s, aiPrompt: e.target.value }))}
            />
            <p className="text-[10px] text-purple-400/70 mt-1">
              {wt('AI将在触发时自动执行此任务，可使用浏览器、文件操作等全部工具')}
            </p>
          </div>
        )}
        {values.taskType === 'tool' && (
          <div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('工具名称')}</label>
                <select
                  className="input-field text-sm"
                  value={values.toolName}
                  onChange={(e) => setValues((s) => ({ ...s, toolName: e.target.value }))}
                >
                  {TOOL_NAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{wt('AI模型 (可选)')}</label>
                <input
                  className="input-field text-sm"
                  placeholder={wt('留空使用默认模型')}
                  value={values.model}
                  onChange={(e) => setValues((s) => ({ ...s, model: e.target.value }))}
                />
              </div>
            </div>
            <label className="block text-sm text-gray-400 mb-1 mt-2">{wt('工具参数 (JSON)')}</label>
            <textarea
              className="input-field font-mono text-xs"
              rows={2}
              placeholder='{"cmd":"ls -la"}'
              value={values.toolArgs}
              onChange={(e) => setValues((s) => ({ ...s, toolArgs: e.target.value }))}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

export default CronCreateModal;
