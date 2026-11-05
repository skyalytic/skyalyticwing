import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useState } from 'react';
import { apiClient } from '@/services/api-client';
import { showConfirm } from '@/components/modals/ConfirmDialog';
type Run = {
  id: string;
  task: string;
  parentId: string;
  status: string;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  model: string;
  calls?: number;
  tokens?: number;
  recovery?: string;
};
export function ExpertRunHistory() {
  useWorkbenchLanguage();
  const [runs, setRuns] = useState<Run[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setRuns(await apiClient.get<Run[]>('/subagents/history'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('读取失败'));
    } finally {
      setBusy(false);
    }
  }
  async function retry(run: Run) {
    if (
      !(await showConfirm(
        wt('此任务在上次关闭时中断。请检查已有文件或消息，确认重新执行未完成任务？'),
      ))
    )
      return;
    try {
      await apiClient.post(`/subagents/${run.id}/retry`, { confirmReplay: true });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('恢复失败'));
    }
  }
  return (
    <details
      className="card p-4 mb-4"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>{wt('智能体执行记录与中断恢复')}</summary>
      <button className="btn-secondary text-sm mt-3" disabled={busy} onClick={() => void load()}>
        {wt('刷新记录')}
      </button>
      {error && <p role="alert">{error}</p>}
      <div className="max-h-80 overflow-y-auto">
        {runs.map((run) => (
          <details key={run.id} className="p-3">
            <summary>
              {run.task || run.id} · {run.recovery ? wt('已中断') : run.status} · {run.calls ?? 0}{' '}
              {wt('次调用 ·')}
              {run.tokens ?? 0} tokens
            </summary>
            <p>
              {run.model} · {new Date(run.createdAt).toLocaleString(workbenchLocale())}{' '}
              {wt('· 父任务')}
              {run.parentId}
            </p>
            <pre style={{ whiteSpace: 'pre-wrap' }}>
              {run.result || run.error || wt('暂无结果')}
            </pre>
            {run.recovery && (
              <button className="btn-primary" onClick={() => void retry(run)}>
                {wt('确认并重试')}
              </button>
            )}
          </details>
        ))}
        {!busy && !runs.length && <p>{wt('暂无智能体执行记录')}</p>}
      </div>
    </details>
  );
}
