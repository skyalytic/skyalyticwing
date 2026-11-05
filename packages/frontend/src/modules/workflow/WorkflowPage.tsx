import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作流页面
// 把复杂任务固化为可复用工作流：步骤顺序执行，前一步输出注入下一步上下文。
// 列表（名称/步骤数/最近运行状态徽标）+ 创建/编辑弹窗（步骤增删/上下移动）
// + 运行结果弹窗（stepResults 时间线）。运行后轮询 GET /workflow/:id/logs（2s 一次）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import './workflow.css';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { Icon } from '@/components/Icon';
import { formatTime } from '@/utils/format';

/** 工作流步骤 */
export interface WorkflowStep {
  id: string;
  name: string;
  prompt: string;
  model?: string;
  agentId?: string;
  dependsOn?: string[];
  reviewBefore?: boolean;
}

/** 工作流定义 */
export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastRunStatus?: WorkflowRunLog['status'] | null;
  budget?: { maxCalls: number; maxDurationMs: number };
  teamId?: string;
}

/** 单步执行结果 */
export interface WorkflowStepResult {
  stepId: string;
  ok: boolean;
  output: string;
  durationMs: number;
  error?: string;
  agentName?: string;
  model?: string;
  calls?: number;
  tokens?: number;
  workspace?: string;
}

/** 运行日志 */
export interface WorkflowRunLog {
  id: string;
  workflowId: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'success' | 'error' | 'paused' | 'interrupted' | 'cancelled';
  calls?: number;
  error?: string;
  activeStepId?: string;
  snapshot?: WorkflowDef;
  stepResults: WorkflowStepResult[];
}

/** 编辑态步骤（key 仅用于 React 渲染，提交时丢弃） */
interface StepForm {
  key: string;
  name: string;
  prompt: string;
  id?: string;
  agentId?: string;
  model?: string;
  reviewBefore?: boolean;
  dependsOn?: string[];
}

/** 编辑态步骤 key 生成器 */
let stepKeySeq = 0;
const genStepKey = () => 'form-step-' + Date.now() + '-' + stepKeySeq++;

/** 耗时格式化：1s 内显示 ms，否则显示秒 */
const formatDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export function WorkflowPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // ── 创建/编辑弹窗 ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = 新建
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formSteps, setFormSteps] = useState<StepForm[]>([]);
  const [saving, setSaving] = useState(false);
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; memberIds: string[] }>>([]);
  const [teamId, setTeamId] = useState('');
  const [maxCalls, setMaxCalls] = useState(100);
  const [maxMinutes, setMaxMinutes] = useState(30);

  // ── 运行结果弹窗 ──
  const [runTarget, setRunTarget] = useState<WorkflowDef | null>(null);
  const [runLogs, setRunLogs] = useState<WorkflowRunLog[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [logsError, setLogsError] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [controlling, setControlling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);
  const mutationLock = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const list = await apiClient.get<WorkflowDef[]>('/workflow');
      setWorkflows(list ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : wt('加载工作流失败'));
      toast.error(wt('加载工作流失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void apiClient
      .get<Array<{ id: string; name: string }>>('/agents')
      .then(setExperts)
      .catch(() => undefined);
    void apiClient
      .get<Array<{ id: string; name: string; memberIds: string[] }>>('/agents/teams')
      .then(setTeams)
      .catch(() => undefined);
  }, [load]);

  /** 停止运行日志轮询 */
  const stopPolling = useCallback(() => {
    pollGeneration.current++;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /** 启动运行日志轮询：2s 一次，直到最新一条 status != running */
  const startPolling = useCallback(
    (wfId: string) => {
      stopPolling();
      const generation = pollGeneration.current;
      setLogsLoading(true);
      setLogsError('');
      const tick = async () => {
        try {
          const logs = await apiClient.get<WorkflowRunLog[]>(`/workflow/${wfId}/logs`);
          if (generation !== pollGeneration.current) return;
          setRunLogs(logs ?? []);
          setLogsError('');
          setLogsLoading(false);
          const last = logs && logs.length > 0 ? logs[logs.length - 1] : undefined;
          if (last)
            setWorkflows((items) =>
              items.map((wf) =>
                wf.id === wfId
                  ? { ...wf, lastRunStatus: last.status, lastRunAt: last.startedAt }
                  : wf,
              ),
            );
          if (!last || last.status !== 'running') return;
        } catch (e) {
          if (generation !== pollGeneration.current) return;
          setLogsLoading(false);
          setLogsError(e instanceof Error ? e.message : wt('加载工作流失败'));
        }
        if (generation === pollGeneration.current)
          pollTimer.current = setTimeout(() => void tick(), 2000);
      };
      void tick();
    },
    [stopPolling],
  );

  // 卸载时清理轮询定时器
  useEffect(() => stopPolling, [stopPolling]);

  // Keep list status live after the result dialog is closed, without flashing a spinner.
  const hasRunningWorkflow = workflows.some((wf) => wf.lastRunStatus === 'running');
  useEffect(() => {
    if (runTarget || !hasRunningWorkflow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const list = await apiClient.get<WorkflowDef[]>('/workflow');
        if (!cancelled) setWorkflows(list ?? []);
      } catch {
        /* Explicit refresh remains available on a temporary connection failure. */
      }
      if (!cancelled) timer = setTimeout(() => void refresh(), 2000);
    };
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runTarget, hasRunningWorkflow]);

  /** 触发运行并打开结果弹窗轮询进度 */
  const run = useCallback(
    async (wf: WorkflowDef) => {
      if (mutationLock.current) return;
      mutationLock.current = true;
      setBusyId(wf.id);
      try {
        const started = await apiClient.post<WorkflowRunLog>(`/workflow/${wf.id}/run`, {});
        setWorkflows((items) =>
          items.map((item) =>
            item.id === wf.id ? { ...item, lastRunStatus: started.status } : item,
          ),
        );
        setRunTarget(wf);
        setSelectedRunId('');
        setRunLogs([started]);
        startPolling(wf.id);
      } catch (e) {
        toast.error(wt('运行失败'), e instanceof Error ? e.message : undefined);
      } finally {
        mutationLock.current = false;
        setBusyId(null);
      }
    },
    [startPolling],
  );

  // ── 编辑弹窗 ──

  const openCreate = useCallback(() => {
    setEditingId(null);
    setFormName('');
    setFormDesc('');
    setTeamId('');
    setMaxCalls(100);
    setMaxMinutes(30);
    setFormSteps([{ key: genStepKey(), name: '', prompt: '' }]);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((wf: WorkflowDef) => {
    setEditingId(wf.id);
    setFormName(wf.name);
    setFormDesc(wf.description ?? '');
    setTeamId(wf.teamId || '');
    setMaxCalls(wf.budget?.maxCalls || 100);
    setMaxMinutes((wf.budget?.maxDurationMs || 1800000) / 60000);
    setFormSteps(
      wf.steps.length > 0
        ? wf.steps.map((s) => ({ ...s, key: s.id }))
        : [{ key: genStepKey(), name: '', prompt: '' }],
    );
    setEditorOpen(true);
  }, []);

  const updateStep = useCallback((key: string, patch: Partial<StepForm>) => {
    setFormSteps((arr) => arr.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }, []);

  const addStep = useCallback(() => {
    setFormSteps((arr) => [...arr, { key: genStepKey(), name: '', prompt: '' }]);
  }, []);

  const removeStep = useCallback((key: string) => {
    setFormSteps((arr) => {
      if (arr.length <= 1) return arr;
      const id = arr.find((s) => s.key === key)?.id || key;
      return arr
        .filter((s) => s.key !== key)
        .map((s) =>
          s.dependsOn === undefined
            ? s
            : { ...s, dependsOn: s.dependsOn.filter((dep) => dep !== id) },
        );
    });
  }, []);

  /** 上下移动步骤（顺序即执行顺序） */
  const moveStep = useCallback((index: number, dir: -1 | 1) => {
    setFormSteps((arr) => {
      const j = index + dir;
      if (j < 0 || j >= arr.length) return arr;
      const next = [...arr];
      const tmp = next[index]!;
      next[index] = next[j]!;
      next[j] = tmp;
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!formName.trim()) {
      toast.error(wt('请填写工作流名称'));
      return;
    }
    if (formSteps.some((s) => !s.prompt.trim())) {
      toast.error(wt('请填写每个步骤的提示词'));
      return;
    }
    setSaving(true);
    try {
      // id 由后端生成；顺序即数组顺序
      const payload = {
        name: formName.trim(),
        description: formDesc.trim(),
        teamId,
        budget: { maxCalls, maxDurationMs: Math.round(maxMinutes * 60000) },
        steps: formSteps.map((s, i) => ({
          id: s.id || s.key,
          agentId: s.agentId || '',
          model: s.model || '',
          reviewBefore: !!s.reviewBefore,
          ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
          name: s.name.trim() || wt('步骤 {{v0}}', { v0: i + 1 }),
          prompt: s.prompt,
        })),
      };
      if (editingId) {
        await apiClient.put(`/workflow/${editingId}`, payload);
        toast.success(wt('已保存'));
      } else {
        await apiClient.post('/workflow', payload);
        toast.success(wt('已创建'));
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }, [editingId, formDesc, formName, formSteps, load, teamId, maxCalls, maxMinutes]);

  const remove = useCallback(
    async (id: string) => {
      if (!(await showConfirm(wt('确定删除该工作流？')))) return;
      setBusyId(id);
      try {
        await apiClient.delete(`/workflow/${id}`);
        toast.success(wt('已删除'));
        await load();
      } catch (e) {
        toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 最近运行状态徽标 */
  const statusBadge = (wf: WorkflowDef) => {
    if (wf.lastRunStatus === 'running') return <Badge variant="info">{wt('运行中')}</Badge>;
    if (wf.lastRunStatus === 'success') return <Badge variant="success">{wt('成功')}</Badge>;
    if (wf.lastRunStatus === 'error') return <Badge variant="danger">{wt('失败')}</Badge>;
    if (wf.lastRunStatus === 'paused') return <Badge>{wt('待审核')}</Badge>;
    if (wf.lastRunStatus === 'interrupted') return <Badge>{wt('可恢复')}</Badge>;
    if (wf.lastRunStatus === 'cancelled') return <Badge>{wt('已取消')}</Badge>;
    return <Badge>{wt('未运行')}</Badge>;
  };

  // 结果弹窗取最新一次运行日志
  const latestLog = runLogs.find((log) => log.id === selectedRunId) ?? runLogs[runLogs.length - 1];
  // stepId → 步骤名称（用于时间线展示）
  const stepNameOf = (stepId: string) =>
    (latestLog?.snapshot || runTarget)?.steps.find((s) => s.id === stepId)?.name ?? stepId;
  const controlRun = async (action: 'cancel' | 'resume' | 'approve') => {
    if (!runTarget || !latestLog || mutationLock.current) return;
    const confirmReplay = action === 'resume' && !!latestLog.activeStepId;
    if (
      confirmReplay &&
      !(await showConfirm(
        wt('未完成步骤可能已写文件或发送消息。确认检查过产物并重试该步骤？已完成步骤不会重跑。'),
      ))
    )
      return;
    mutationLock.current = true;
    setControlling(true);
    try {
      await apiClient.post(`/workflow/${runTarget.id}/runs/${latestLog.id}/${action}`, {
        confirmReplay,
      });
      startPolling(runTarget.id);
      void load();
    } catch (e) {
      toast.error(wt('操作失败'), e instanceof Error ? e.message : undefined);
    } finally {
      mutationLock.current = false;
      setControlling(false);
    }
  };

  return (
    <div className="workflow-page">
      <Link className="workflow-back" to="/agents">
        ← {wt('智能体')}
      </Link>
      <div className="workflow-header">
        <div>
          <h1>{wt('协作工作流')}</h1>
          <p>{wt('把任务拆成步骤，交给不同专家接力完成。')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={load}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={openCreate}>
            {wt('新建工作流')}
          </Button>
        </div>
      </div>

      <div className="workflow-overview">
        <span>{wt('共 {{v0}} 个工作流', { v0: workflows.length })}</span>
        <span>{wt('步骤衔接 · 专家执行 · 产物审核')}</span>
      </div>
      {loading ? (
        <SpinnerWrap label={wt('加载中…')} />
      ) : loadError ? (
        <div className="workflow-empty" role="alert">
          <h2>{wt('加载工作流失败')}</h2>
          <p>{loadError}</p>
          <Button onClick={load}>{t('common.refresh')}</Button>
        </div>
      ) : workflows.length === 0 ? (
        <div className="workflow-empty">
          <div className="workflow-flow" aria-hidden="true">
            <span>{wt('拆解任务')}</span>
            <b>→</b>
            <span>{wt('专家接力')}</span>
            <b>→</b>
            <span>{wt('审核产物')}</span>
          </div>
          <h2>{wt('让重复的工作，有一套可复用的流程')}</h2>
          <p>
            {wt('例如：整理资料 → 撰写初稿 → 审核定稿。每一步都能选择专家，后续步骤使用前序产物。')}
          </p>
          <Button variant="primary" onClick={openCreate}>
            {wt('创建第一个工作流')}
          </Button>
          <p className="workflow-hint">{wt('执行前可设置调用预算，也可在关键步骤暂停审核。')}</p>
        </div>
      ) : (
        <div className="workflow-list">
          {workflows.map((wf) => (
            <article key={wf.id} className="workflow-card">
              <div className="list-row-main">
                <div className="list-row-title">
                  {wf.name}
                  {statusBadge(wf)}
                </div>
                <ol className="workflow-steps" aria-label={wt('执行步骤')}>
                  {wf.steps.map((step, index) => (
                    <li key={step.id}>
                      <b>{index + 1}</b>
                      <span>{step.name}</span>
                      {step.reviewBefore && <Badge>{wt('审核点')}</Badge>}
                    </li>
                  ))}
                </ol>
                <div className="list-row-sub">
                  <span>
                    {wf.steps.length} {wt('个步骤')}
                  </span>
                  {wf.description ? <span style={{ marginLeft: 8 }}>{wf.description}</span> : null}
                  {wf.lastRunAt ? (
                    <span style={{ marginLeft: 8 }}>
                      {wt('上次运行')}
                      {formatTime(wf.lastRunAt)}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="list-row-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRunTarget(wf);
                    setSelectedRunId('');
                    setRunLogs([]);
                    startPolling(wf.id);
                  }}
                >
                  {wt('运行记录')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyId === wf.id}
                  disabled={
                    wf.enabled === false ||
                    ['running', 'paused', 'interrupted'].includes(wf.lastRunStatus || '')
                  }
                  onClick={() => void run(wf)}
                >
                  {wt('运行')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(wf)}>
                  {wt('编辑')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(wf.id)}>
                  {wt('删除')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 创建/编辑弹窗 */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        width={720}
        title={
          <span className="flex items-center gap-2">
            <Icon name="worktree" size={18} />
            {editingId ? wt('编辑工作流') : wt('新建工作流')}
          </span>
        }
        footer={
          <>
            <button className="btn-primary text-sm" onClick={() => void save()} disabled={saving}>
              {saving ? wt('保存中…') : wt('保存')}
            </button>
            <button className="btn-secondary text-sm" onClick={() => setEditorOpen(false)}>
              {wt('取消')}
            </button>
          </>
        }
      >
        <div className="workflow-editor space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('名称 *')}</label>
            <input
              className="input-field"
              placeholder={wt('例：周报生成流水线')}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">{wt('描述')}</label>
            <input
              className="input-field"
              placeholder={wt('工作流用途说明（可选）')}
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
            />
          </div>
          <div>
            <div className="workflow-options">
              <label>
                {wt('智能体团')}
                <select
                  className="input-field"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">{wt('不限团队')}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {wt('最多模型调用')}
                <input
                  aria-label={wt('最多模型调用')}
                  className="input-field"
                  type="number"
                  min={1}
                  max={1000}
                  value={maxCalls}
                  onChange={(e) => setMaxCalls(Number(e.target.value))}
                />
              </label>
              <label>
                {wt('最多分钟')}
                <input
                  aria-label={wt('最多分钟')}
                  className="input-field"
                  type="number"
                  min={1}
                  max={1440}
                  value={maxMinutes}
                  onChange={(e) => setMaxMinutes(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-gray-400">
                {wt('步骤（按顺序执行，上一步输出会传给下一步）*')}
              </label>
              <Button size="sm" variant="ghost" onClick={addStep}>
                {wt('+ 添加步骤')}
              </Button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {formSteps.map((s, i) => (
                <div key={s.key} className="workflow-step-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge>{i + 1}</Badge>
                    <input
                      className="input-field"
                      placeholder={wt('步骤 {{v0}} 名称', { v0: i + 1 })}
                      value={s.name}
                      onChange={(e) => updateStep(s.key, { name: e.target.value })}
                      style={{ flex: 1 }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={i === 0}
                      onClick={() => moveStep(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={i === formSteps.length - 1}
                      onClick={() => moveStep(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={formSteps.length <= 1}
                      onClick={() => removeStep(s.key)}
                    >
                      {wt('删除')}
                    </Button>
                  </div>
                  <textarea
                    className="input-field"
                    rows={3}
                    placeholder={wt('本步骤的提示词（发送给 AI 的任务指令）')}
                    value={s.prompt}
                    onChange={(e) => updateStep(s.key, { prompt: e.target.value })}
                    style={{ marginTop: 8, width: '100%' }}
                  />
                  <label>
                    {wt('执行专家')}
                    <select
                      aria-label={wt('步骤 {{v0}} 执行专家', { v0: i + 1 })}
                      className="input-field"
                      value={s.agentId || ''}
                      onChange={(e) => updateStep(s.key, { agentId: e.target.value })}
                    >
                      <option value="">{wt('文本生成（无工具）')}</option>
                      {experts
                        .filter(
                          (expert) =>
                            !teamId ||
                            teams.find((team) => team.id === teamId)?.memberIds.includes(expert.id),
                        )
                        .map((expert) => (
                          <option key={expert.id} value={expert.id}>
                            {expert.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!s.reviewBefore}
                      onChange={(e) => updateStep(s.key, { reviewBefore: e.target.checked })}
                    />{' '}
                    {wt('执行前暂停，让我审核前序产物')}
                  </label>
                  <details>
                    <summary>{wt('步骤依赖与模型')}</summary>
                    <input
                      className="input-field"
                      placeholder={wt('模型 ID，留空使用专家/全局模型')}
                      value={s.model || ''}
                      onChange={(e) => updateStep(s.key, { model: e.target.value })}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={s.dependsOn !== undefined}
                        onChange={(e) => {
                          const copy = { ...s };
                          if (e.target.checked) copy.dependsOn = [];
                          else delete copy.dependsOn;
                          setFormSteps((arr) =>
                            arr.map((item) => (item.key === s.key ? copy : item)),
                          );
                        }}
                      />{' '}
                      {wt('自选依赖（未勾选时使用上一步）')}
                    </label>
                    {s.dependsOn !== undefined &&
                      formSteps
                        .filter((other) => other.key !== s.key)
                        .map((other) => (
                          <label key={other.key} style={{ display: 'block' }}>
                            <input
                              type="checkbox"
                              checked={s.dependsOn?.includes(other.id || other.key)}
                              onChange={(e) =>
                                updateStep(s.key, {
                                  dependsOn: e.target.checked
                                    ? [...(s.dependsOn || []), other.id || other.key]
                                    : (s.dependsOn || []).filter(
                                        (id) => id !== (other.id || other.key),
                                      ),
                                })
                              }
                            />
                            {other.name || wt('未命名步骤')}
                          </label>
                        ))}
                  </details>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* 运行结果弹窗：stepResults 时间线 */}
      <Modal
        open={runTarget !== null}
        onClose={() => {
          stopPolling();
          setRunTarget(null);
        }}
        width={640}
        title={
          <span className="flex items-center gap-2">
            <Icon name="cron" size={18} /> {wt('运行结果 ·')}
            {runTarget?.name}
          </span>
        }
        footer={
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              stopPolling();
              setRunTarget(null);
            }}
          >
            {wt('关闭')}
          </button>
        }
      >
        {logsError && <p role="alert">{logsError}</p>}
        {runLogs.length > 1 && (
          <label>
            {wt('运行记录')}
            <select
              className="input-field"
              aria-label={wt('选择运行记录')}
              value={latestLog?.id || ''}
              onChange={(e) => setSelectedRunId(e.target.value)}
            >
              {[...runLogs].reverse().map((log) => (
                <option key={log.id} value={log.id}>
                  {formatTime(log.startedAt)} · {log.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        {logsLoading && !latestLog ? (
          <SpinnerWrap label={wt('加载中…')} />
        ) : latestLog ? (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              {latestLog.status === 'running' ? (
                <Badge variant="info">{wt('运行中…')}</Badge>
              ) : latestLog.status === 'success' ? (
                <Badge variant="success">{wt('成功')}</Badge>
              ) : (
                <Badge variant="danger">
                  {
                    {
                      error: wt('失败'),
                      paused: wt('待审核'),
                      interrupted: wt('可恢复'),
                      cancelled: wt('已取消'),
                    }[latestLog.status]
                  }
                </Badge>
              )}
              <span style={{ fontSize: uiFontSize(12), opacity: 0.7 }}>
                {wt('开始')}
                {formatTime(latestLog.startedAt)}
                {latestLog.finishedAt
                  ? wt(' · 耗时 {{v0}}', {
                      v0: formatDuration(latestLog.finishedAt - latestLog.startedAt),
                    })
                  : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {latestLog.status === 'paused' && (
                <Button disabled={controlling} onClick={() => void controlRun('approve')}>
                  {wt('审核通过，继续')}
                </Button>
              )}
              {['interrupted', 'error', 'cancelled'].includes(latestLog.status) && (
                <Button disabled={controlling} onClick={() => void controlRun('resume')}>
                  {wt('恢复未完成步骤')}
                </Button>
              )}
              {['running', 'paused', 'interrupted'].includes(latestLog.status) && (
                <Button
                  variant="danger"
                  disabled={controlling}
                  onClick={() => void controlRun('cancel')}
                >
                  {wt('取消运行')}
                </Button>
              )}
              <span>
                {wt('模型调用')}
                {latestLog.calls ?? 0} {wt('次')}
              </span>
            </div>
            {latestLog.error && <p role="alert">{latestLog.error}</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {latestLog.stepResults.length === 0 ? (
                <div style={{ fontSize: uiFontSize(13), opacity: 0.65 }}>{wt('等待第一个步骤完成…')}</div>
              ) : (
                latestLog.stepResults.map((r, i) => (
                  <div key={r.stepId + '-' + i} className="card" style={{ padding: 10 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ opacity: 0.6, fontSize: uiFontSize(12) }}>{i + 1}</span>
                      {r.ok ? (
                        <Badge variant="success">{wt('成功')}</Badge>
                      ) : (
                        <Badge variant="danger">{wt('失败')}</Badge>
                      )}
                      <span style={{ fontWeight: 600, fontSize: uiFontSize(13) }}>{stepNameOf(r.stepId)}</span>
                      <span>
                        {r.agentName || wt('文本步骤')} · {r.model} · {r.tokens ?? 0} tokens
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: uiFontSize(12), opacity: 0.7 }}>
                        {formatDuration(r.durationMs)}
                      </span>
                    </div>
                    {r.error ? (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: uiFontSize(12),
                          color: 'var(--error, #e5484d)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {r.error}
                      </div>
                    ) : r.output ? (
                      <pre
                        className="scrollbar-thin"
                        style={{
                          marginTop: 6,
                          fontSize: uiFontSize(12),
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 160,
                          overflowY: 'auto',
                          opacity: 0.9,
                          margin: '6px 0 0 0',
                        }}
                      >
                        {r.output}
                      </pre>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>{wt('暂无运行记录，点击“运行”开始。')}</div>
        )}
      </Modal>
    </div>
  );
}

export default WorkflowPage;
