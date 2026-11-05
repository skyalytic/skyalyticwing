import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// One catalog for installed and available tools; permissions remain independent of installation.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { TextArea } from '@/components/ui/TextArea';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { JsonBlock } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/Icon';
import { toast } from '@/components/ui/Toast';
import { ToolForm } from './ToolForm';
import { AddToolModal } from '@/components/modals/AddToolModal';
import type { ToolExecuteResult, ToolListItem } from '@/types';

/** 旧版 7 大分类（顺序与中文名与 renderToolsView 一致） */
const CATEGORY_CN: Record<string, string> = {
  get file() {
    return wt('文件操作');
  },
  get command() {
    return wt('命令执行');
  },
  get network() {
    return wt('网络工具');
  },
  get code() {
    return wt('代码工具');
  },
  get git() {
    return wt('版本控制');
  },
  get interactive() {
    return wt('交互工具');
  },
  get system() {
    return wt('系统管理');
  },
};

/** 新版后端 category → 旧版 7 类映射（全部工具归入旧版分类，不丢功能） */
const CATEGORY_MAP: Record<string, string> = {
  file: 'file',
  filesystem: 'file',
  command: 'command',
  shell: 'command',
  network: 'network',
  web: 'network',
  code: 'code',
  interactive: 'interactive',
  ui: 'interactive',
  system: 'system',
  media: 'system',
  session: 'system',
  memory: 'system',
  skill: 'system',
  cron: 'system',
  plugin: 'system',
  mcp: 'system',
  agent: 'system',
  channel: 'system',
};

/** git 工具特判归"版本控制" */
function mapCategory(tool: ToolListItem): string {
  if (/^git[-_]/i.test(tool.name) || tool.category === 'git') return 'git';
  return CATEGORY_MAP[tool.category] ?? 'system';
}

/** 工具名归一化：kebab → 下划线（file-read → file_read，与旧版 id 一致） */
export function normalizeToolName(name: string): string {
  return name.replace(/-/g, '_');
}

export function ToolsPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState<ToolListItem | null>(null);
  const [argsText, setArgsText] = useState('{}');
  const [advancedMode, setAdvancedMode] = useState(false);
  const [result, setResult] = useState<ToolExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const [showAddTool, setShowAddTool] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [permissionSaving, setPermissionSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await apiClient.get<ToolListItem[]>('/tools/catalog');
      setTools(Array.isArray(list) ? list : ((list as { tools?: ToolListItem[] })?.tools ?? []));
    } catch (e) {
      toast.error(wt('加载工具失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('wing:extensions-changed', refresh);
    window.addEventListener('sky-tools-changed', refresh);
    return () => { window.removeEventListener('wing:extensions-changed', refresh); window.removeEventListener('sky-tools-changed', refresh); };
  }, [load]);

  /** 权限切换（旧版 setToolPermission：auto/ask/disabled → POST /tools/permission） */
  const setPermission = useCallback(
    async (tool: ToolListItem, value: string) => {
      const prev = tools;
      setPermissionSaving(true);
      const nextDisabled = value === 'disabled';
      setTools((ts) =>
        ts.map((x) =>
          x.name === tool.name
            ? { ...x, disabled: nextDisabled, permission: value === 'ask' ? 'ask' : 'auto' }
            : x,
        ),
      );
      try {
        await apiClient.post('/tools/permission', {
          toolId: tool.id || tool.name,
          permission: value === 'ask' ? 'ask' : 'auto',
          disabled: nextDisabled,
        });
      } catch (e) {
        setTools(prev);
        toast.error(wt('操作失败'), e instanceof Error ? e.message : undefined);
      } finally { setPermissionSaving(false); }
    },
    [tools],
  );

  const changeInstallation = useCallback(async (tool: ToolListItem) => {
    setChanging(tool.name);
    try {
      await apiClient.post(tool.installed === false ? '/tools/install' : '/tools/uninstall', { name: tool.name });
      if (executing?.name === tool.name) { setExecuting(null); setResult(null); }
      await load();
    } catch (error) {
      toast.error(wt('操作失败'), error instanceof Error ? error.message : undefined);
    } finally { setChanging(null); }
  }, [executing, load]);

  /** 添加自定义工具保存（旧版 saveCustomTool：POST /tools/custom） */
  const saveCustomTool = useCallback(
    async (values: {
      id: string;
      name: string;
      description: string;
      category: string;
      permission: string;
      endpoint: string;
    }) => {
      try {
        await apiClient.post('/tools/custom', { ...values, custom: true });
        toast.success(wt('自定义工具已添加'));
        setShowAddTool(false);
        await load();
      } catch (e) {
        toast.error(wt('添加失败'), e instanceof Error ? e.message : undefined);
      }
    },
    [load],
  );

  const openExec = useCallback((t: ToolListItem) => {
    setExecuting(t);
    setArgsText('{}');
    setResult(null);
    // 未在 schema 中登记的工具默认进入高级 JSON 模式（按旧版 id 归一化匹配）
    setAdvancedMode(!KNOWN_FORM_TOOLS.has(normalizeToolName(t.name)));
  }, []);

  const closeExec = useCallback(() => {
    setExecuting(null);
    setResult(null);
  }, []);

  // 执行：接受已收集的参数对象（动态表单模式）
  const runWithArgs = useCallback(
    async (args: Record<string, unknown>) => {
      if (!executing) return;
      setRunning(true);
      setResult(null);
      try {
        const res = await apiClient.post<ToolExecuteResult>(
          '/tool/execute',
          {
            tool: executing.name,
            args,
          },
          { timeoutMs: 180_000 },
        );
        setResult(res);
        toast.success(wt('执行完成'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : wt('执行失败');
        setResult({ tool: executing.name, success: false, error: msg });
        toast.error(wt('执行失败'), msg);
      } finally {
        setRunning(false);
      }
    },
    [executing],
  );

  // 执行：高级 JSON 模式
  const runJson = useCallback(async () => {
    if (!executing) return;
    setRunning(true);
    setResult(null);
    try {
      const args = JSON.parse(argsText);
      await runWithArgs(args);
    } catch (e) {
      const msg =
        e instanceof SyntaxError
          ? wt('JSON 格式错误')
          : e instanceof Error
            ? e.message
            : wt('执行失败');
      setResult({ tool: executing.name, success: false, error: msg });
      toast.error(wt('执行失败'), msg);
    } finally {
      setRunning(false);
    }
  }, [executing, argsText, runWithArgs]);

  const toolName = executing
    ? executing.name.length > 30
      ? executing.name.slice(0, 30) + '…'
      : executing.name
    : '';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.toolsManage')}</div>
          <div className="page-subtitle">{t('views.toolsLoaded', { count: tools.filter(tool => tool.installed !== false && tool.loaded !== false).length })}</div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={() => setShowAddTool(true)}>
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {wt('添加工具')}
            </span>
          </Button>
        </div>
      </div>


      {loading ? <SpinnerWrap label={wt('加载中…')} /> : tools.length === 0 ? (
        <div className="empty-state"><Icon name="tool" size={48} /><div>{wt('暂无工具')}</div></div>
      ) : (
        <div className="card overflow-auto tool-catalog">
          <table className="tool-table tool-catalog-table">
            <thead><tr>
              <th className="tool-col-name">{wt('工具')}</th>
              <th className="tool-col-category">{wt('分类')}</th>
              <th className="tool-col-desc">{wt('描述')}</th>
              <th className="tool-col-perm">{wt('权限')}</th>
              <th className="tool-col-action">{wt('操作')}</th>
            </tr></thead>
            <tbody>{tools.map(tool => {
              const installed = tool.installed !== false, desc = wt(tool.description || tool.name);
              return <tr key={tool.name}>
                <td className="tool-col-name"><code title={tool.name}>{tool.name}</code></td>
                <td className="tool-col-category">{CATEGORY_CN[mapCategory(tool)]}</td>
                <td className="tool-col-desc" title={desc}>{desc}</td>
                <td className="tool-col-perm">
                  <select aria-label={tool.name + ' ' + wt('权限')} className="tool-permission-select"
                    disabled={!installed || changing !== null || permissionSaving}
                    value={tool.disabled ? 'disabled' : tool.permission === 'ask' ? 'ask' : 'auto'}
                    onChange={e => void setPermission(tool, e.target.value)}>
                    <option value="auto">{wt('自动')}</option>
                    <option value="ask">{wt('需确认')}</option>
                    <option value="disabled">{wt('禁用')}</option>
                  </select>
                </td>
                <td className="tool-col-action"><div className="flex gap-2 items-center justify-end">
                  <Button size="sm" variant="primary" onClick={() => openExec(tool)}
                    disabled={!installed || tool.disabled === true || tool.loaded === false || changing !== null || permissionSaving}>{wt('使用')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => void changeInstallation(tool)}
                    disabled={changing !== null || permissionSaving} loading={changing === tool.name}>{installed ? wt('卸载') : wt('安装')}</Button>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}

      {/* 添加自定义工具（旧版 openModal('addTool')） */}
      {showAddTool ? (
        <AddToolModal open onClose={() => setShowAddTool(false)} onSave={saveCustomTool} />
      ) : null}

      {/* 右侧滑入侧边面板（恢复旧版 UX） */}
      {executing
        ? createPortal(
            <div
              className="modal-overlay"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeExec();
              }}
              style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}
            >
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  background: 'var(--bg-secondary, #1e293b)',
                  width: '100%',
                  maxWidth: 420,
                  height: '100%',
                  maxHeight: '100vh',
                  borderLeft: '1px solid var(--border, #334155)',
                  boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  animation: 'slideInRight 0.22s ease-out',
                }}
              >
                {/* 面板头部 */}
                <div
                  className="flex justify-between items-center p-4"
                  style={{ borderBottom: '1px solid var(--border, #334155)' }}
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="font-bold truncate">{toolName}</h3>
                    <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {wt(executing.description || '')}
                    </p>
                  </div>
                  <button
                    className="modal-close"
                    onClick={closeExec}
                    aria-label={wt('关闭')}
                    style={{ marginLeft: 8, flexShrink: 0, fontSize: uiFontSize(20) }}
                  >
                    ×
                  </button>
                </div>

                {/* 面板主体 */}
                <div className="flex-1 overflow-y-auto p-4">
                  {executing.dangerous ? (
                    <div className="mb-4 flex items-center gap-1" style={{ color: 'var(--error)' }}>
                      <Icon name="alert" size={14} /> {wt('该工具被标记为危险操作，请谨慎执行。')}
                    </div>
                  ) : null}

                  {/* 高级模式切换（仅对有专属表单的工具显示） */}
                  {KNOWN_FORM_TOOLS.has(normalizeToolName(executing.name)) ? (
                    <div className="mb-4 flex justify-end">
                      <label
                        className="text-xs flex items-center gap-1"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <input
                          type="checkbox"
                          checked={advancedMode}
                          onChange={(e) => setAdvancedMode(e.target.checked)}
                          style={{ margin: 0 }}
                        />
                        {wt('高级模式（JSON）')}
                      </label>
                    </div>
                  ) : null}

                  {advancedMode || !KNOWN_FORM_TOOLS.has(normalizeToolName(executing.name)) ? (
                    <TextArea
                      label={wt('参数（JSON）')}
                      rows={8}
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      className="font-mono"
                    />
                  ) : (
                    <ToolForm
                      tool={executing}
                      onSubmit={runWithArgs}
                      onCancel={closeExec}
                      loading={running}
                    />
                  )}

                  {result ? (
                    <div className="mt-4">
                      <div className="text-sm mb-2" style={{ color: 'var(--success)' }}>
                        {wt('执行结果')}
                      </div>
                      <JsonBlock
                        data={{
                          success: result.success,
                          output: result.output,
                          error: result.error,
                          data: result.data,
                          durationMs: result.durationMs,
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                {/* 面板底部按钮（仅在高级模式下显示，动态表单自带按钮） */}
                {advancedMode || !KNOWN_FORM_TOOLS.has(normalizeToolName(executing.name)) ? (
                  <div
                    className="p-4 flex gap-2"
                    style={{ borderTop: '1px solid var(--border, #334155)' }}
                  >
                    <Button variant="ghost" onClick={closeExec}>
                      {wt('关闭')}
                    </Button>
                    <Button variant="primary" onClick={runJson} loading={running} fullWidth>
                      {wt('执行')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 已登记专属表单的工具集合（用于决定是否显示模式切换） */
const KNOWN_FORM_TOOLS = new Set<string>([
  'file_read',
  'file_write',
  'file_edit',
  'file_delete',
  'directory_list',
  'glob',
  'grep',
  'bash',
  'powershell',
  'web_fetch',
  'web_search',
  'api_call',
  'browser_open',
  'git_operation',
  'http_request',
  'code_build',
  'env_get',
  'env_set',
  'process_list',
  'process_kill',
  'show_message',
  'notify',
]);
