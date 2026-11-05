import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 后台任务状态卡片：超长任务转后台执行后的实时进度展示
// （background_task WS 事件驱动；结果回流走 chat_message，此卡只负责过程状态）
import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { useChatStore, type BackgroundTaskState } from '@/stores/chat-store';

/** 运行时长展示（每秒刷新） */
function useElapsedLabel(startedAt: number | undefined, endedAt: number | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (endedAt !== undefined) return;
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [endedAt]);
  const from = startedAt ?? 0;
  if (!from) return '';
  const end = endedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - from) / 1000));
  if (sec < 60) return wt('{{v0}}秒', { v0: sec });
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? wt('{{v0}}分{{v1}}秒', { v0: min, v1: rem }) : wt('{{v0}}分钟', { v0: min });
}

const STATUS_BADGE: Record<BackgroundTaskState['status'], { label: string; cls: string }> = {
  pending: {
    get label() {
      return wt('排队中');
    },
    cls: 'badge badge-info',
  },
  running: {
    get label() {
      return wt('运行中');
    },
    cls: 'badge badge-info',
  },
  completed: {
    get label() {
      return wt('已完成');
    },
    cls: 'badge badge-success',
  },
  failed: {
    get label() {
      return wt('失败');
    },
    cls: 'badge badge-danger',
  },
  cancelled: {
    get label() {
      return wt('已取消');
    },
    cls: 'badge badge-danger',
  },
  interrupted: {
    get label() {
      return wt('已中断');
    },
    cls: 'badge badge-danger',
  },
};

function TaskCard({ task }: { task: BackgroundTaskState }) {
  useWorkbenchLanguage();
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const elapsed = useElapsedLabel(task.createdAt, task.endedAt);
  const busy = task.status === 'pending' || task.status === 'running';
  const badge = STATUS_BADGE[task.status];

  const cancel = (): void => {
    void apiClient.post(`/background-tasks/${task.taskId}/cancel`).catch(() => undefined);
  };

  const resume = (): void => {
    setActionError('');
    setSubmitting(true);
    void apiClient
      .post(`/background-tasks/${task.taskId}/resume`)
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : wt('任务续接失败，请稍后重试')),
      )
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="tool-call">
      <div className="tool-call-head">
        <span className="tool-call-name">
          {busy ? (
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                border: '2px solid currentColor',
                borderBottomColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
          ) : null}
          {wt('后台任务 ·')}
          {task.title}
        </span>
        <span className={badge.cls}>{badge.label}</span>
      </div>
      {busy && task.step ? (
        <div className="tool-call-result" style={{ opacity: 0.85 }}>
          {task.step}
          {elapsed ? wt('（已运行 {{v0}}）', { v0: elapsed }) : ''}
        </div>
      ) : null}
      {!busy && task.error ? <div className="tool-call-result error">{task.error}</div> : null}
      {actionError ? (
        <div role="alert" className="tool-call-result error">
          {actionError}
        </div>
      ) : null}
      {busy ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            className="btn btn-sm"
            onClick={cancel}
            style={{ padding: '2px 10px', fontSize: uiFontSize(12) }}
          >
            {wt('取消任务')}
          </button>
        </div>
      ) : null}
      {!busy && task.status !== 'completed' ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            className="btn btn-sm"
            onClick={resume}
            disabled={submitting}
            style={{ padding: '2px 10px', fontSize: uiFontSize(12) }}
          >
            {submitting ? wt('正在续接…') : wt('继续任务')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 渲染当前会话的后台任务卡：运行中任务常驻展示（含实时进度与取消按钮），
 * 已完结任务保留展示（结果详情由回流的 chat_message 呈现，此处为过程留痕）。
 */
export function BackgroundTaskBar(): React.ReactNode {
  useWorkbenchLanguage();
  const backgroundTasks = useChatStore((s) => s.backgroundTasks);
  const tasks = Object.values(backgroundTasks);
  if (tasks.length === 0) return null;
  // 创建时间倒序：最新任务在最上
  const sorted = tasks.sort((a, b) => b.createdAt - a.createdAt);
  return (
    <>
      {sorted.map((t) => (
        <TaskCard key={t.taskId} task={t} />
      ))}
    </>
  );
}
