import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 定时任务页面
// 长期任务（AI 7×24 自动执行）视图：列表行显示轮次/进度徽标，
// 点击行展开详情（总目标/进度/执行历史时间线/收尾按钮）
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { Icon } from '@/components/Icon';
import { formatTime, formatRelativeTime } from '@/utils/format';
import type { CronJob, CronLongRunningDetail } from '@/types';

export function CronPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // ── 长期任务详情展开 ──
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CronLongRunningDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiClient.get<CronJob[]>('/cron');
      setJobs(list ?? []);
    } catch (e) {
      toast.error(wt('加载任务失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 展开长期任务详情：拉取 GET /cron/:id（含 longRunning 历史） */
  const openDetail = useCallback(
    async (job: CronJob) => {
      if (expandedId === job.id) {
        setExpandedId(null);
        setDetail(null);
        return;
      }
      setExpandedId(job.id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const d = await apiClient.get<{ longRunning?: CronLongRunningDetail }>(`/cron/${job.id}`);
        setDetail(
          d?.longRunning ?? {
            round: job.longRunning?.round || 0,
            progress: job.longRunning?.progress,
          },
        );
      } catch {
        setDetail({ round: job.longRunning?.round || 0, progress: job.longRunning?.progress });
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId],
  );

  /** 收尾长期任务（禁用即收尾：进度与历史保留，可随时手动再启用） */
  const finishJob = useCallback(
    async (job: CronJob) => {
      if (!(await showConfirm(wt('确定收尾该长期任务？收尾后不再自动执行，进度与历史会保留。'))))
        return;
      setBusyId(job.id);
      try {
        await apiClient.put('/cron/toggle', { id: job.id, enabled: false });
        toast.success(wt('长期任务已收尾'));
        setExpandedId(null);
        setDetail(null);
        load();
      } catch (e) {
        toast.error(wt('收尾失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const start = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await apiClient.post(`/cron/${id}/start`, {});
        toast.success(wt('任务已启动'));
        load();
      } catch (e) {
        toast.error(wt('启动失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const execute = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await apiClient.post(`/cron/${id}/run`, {});
        toast.success(wt('已手动触发'));
        load();
      } catch (e) {
        toast.error(wt('触发失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const toggle = useCallback(
    async (job: CronJob) => {
      setBusyId(job.id);
      try {
        // 后端切换启用状态走 PUT /cron/toggle（body: {id, enabled}）
        await apiClient.put('/cron/toggle', { id: job.id, enabled: !job.enabled });
        toast.success(job.enabled ? wt('已禁用') : wt('已启用'));
        load();
      } catch (e) {
        toast.error(wt('操作失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!(await showConfirm(wt('确定删除该任务？')))) return;
      setBusyId(id);
      try {
        await apiClient.delete(`/cron/${id}`);
        toast.success(wt('已删除'));
        load();
      } catch (e) {
        toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 是否长期任务（AI 任务且带状态追踪） */
  const isLongRunning = (j: CronJob) => j.taskType === 'ai' && !!j.longRunning;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.cronJobs')}</div>
          <div className="page-subtitle">{t('views.jobsCount', { count: jobs.length })}</div>
        </div>
        <Button variant="secondary" onClick={load}>
          {t('common.refresh')}
        </Button>
      </div>

      {loading ? (
        <SpinnerWrap label={wt('加载中…')} />
      ) : jobs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="cron" size={48} />
          </div>
          <div>{wt('暂无定时任务')}</div>
        </div>
      ) : (
        <div className="list">
          {jobs.map((j) => (
            <div key={j.id}>
              <div
                className="list-row"
                style={isLongRunning(j) ? { cursor: 'pointer' } : undefined}
                onClick={isLongRunning(j) ? () => void openDetail(j) : undefined}
              >
                <div className="list-row-main">
                  <div className="list-row-title">
                    {j.taskType === 'builtin' ? wt(j.name) : j.name}
                    {j.enabled ? (
                      <Badge variant="success">{wt('启用')}</Badge>
                    ) : (
                      <Badge>{wt('禁用')}</Badge>
                    )}
                    {j.running ? <Badge variant="info">{wt('运行中')}</Badge> : null}
                    {isLongRunning(j) ? (
                      <Badge variant="info">
                        {wt('长期 · 第')}
                        {j.longRunning?.round ?? 0} {wt('轮')}
                        {j.longRunning && j.longRunning.round > 0 && j.enabled
                          ? ''
                          : j.enabled
                            ? ''
                            : wt('（已收尾）')}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="list-row-sub">
                    <span className="text-mono">{j.expression}</span>
                    {j.lastRun ? (
                      <span style={{ marginLeft: 8 }}>
                        {wt('上次')}
                        {formatRelativeTime(j.lastRun)}
                      </span>
                    ) : null}
                    {j.nextRun ? (
                      <span style={{ marginLeft: 8 }}>
                        {wt('下次')}
                        {formatTime(j.nextRun)}
                      </span>
                    ) : null}
                  </div>
                  {isLongRunning(j) && j.longRunning?.progress ? (
                    <div className="list-row-sub" style={{ marginTop: 4 }}>
                      {wt('进度：')}
                      {j.longRunning.progress}
                    </div>
                  ) : null}
                </div>
                <div className="list-row-actions" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => execute(j.id)}
                    loading={busyId === j.id}
                  >
                    {wt('执行')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => start(j.id)}>
                    {wt('启动')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(j)}>
                    {j.enabled ? wt('禁用') : wt('启用')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(j.id)}>
                    {wt('删除')}
                  </Button>
                </div>
              </div>

              {/* 长期任务展开详情：总目标 / 进度 / 执行历史时间线 / 收尾 */}
              {expandedId === j.id ? (
                <div
                  className="card"
                  style={{
                    margin: '4px 0 12px 0',
                    padding: 16,
                    background: 'var(--bg-secondary, #f7f8fa)',
                  }}
                >
                  {detailLoading ? (
                    <SpinnerWrap label={wt('加载详情…')} />
                  ) : (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>
                            {wt('长期任务 · 第')}
                            {detail?.round ?? 0} {wt('轮')}
                            {detail?.maxRounds
                              ? wt(' / 上限 {{v0}}', { v0: detail.maxRounds })
                              : ''}
                          </div>
                          {detail?.goal ? (
                            <div style={{ fontSize: uiFontSize(13), opacity: 0.85, marginTop: 4 }}>
                              {wt('总目标：')}
                              {detail.goal}
                            </div>
                          ) : null}
                          {detail?.progress ? (
                            <div style={{ fontSize: uiFontSize(13), marginTop: 4 }}>
                              {wt('当前进度：')}
                              {detail.progress}
                            </div>
                          ) : null}
                        </div>
                        {j.enabled ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyId === j.id}
                            onClick={() => finishJob(j)}
                          >
                            {wt('收尾任务')}
                          </Button>
                        ) : null}
                      </div>

                      {(detail?.history?.length ?? 0) > 0 ? (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: uiFontSize(12), opacity: 0.7, marginBottom: 6 }}>
                            {wt('执行历史（最近')}
                            {detail?.history?.length} {wt('轮）')}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {[...(detail?.history ?? [])].reverse().map((h, i) => (
                              <div
                                key={h.at + '-' + i}
                                style={{
                                  display: 'flex',
                                  gap: 8,
                                  alignItems: 'baseline',
                                  fontSize: uiFontSize(13),
                                }}
                              >
                                <span style={{ flexShrink: 0, opacity: 0.65 }}>
                                  {formatTime(h.at)}
                                </span>
                                {h.status === 'done' ? (
                                  <Badge variant="success">done</Badge>
                                ) : h.status === 'blocked' ? (
                                  <Badge variant="danger">blocked</Badge>
                                ) : h.outcome === 'error' ? (
                                  <Badge variant="danger">{wt('失败')}</Badge>
                                ) : (
                                  <Badge variant="info">running</Badge>
                                )}
                                <span style={{ opacity: 0.9 }}>
                                  {h.summary || wt('（无摘要）')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div style={{ marginTop: 12, fontSize: uiFontSize(13), opacity: 0.65 }}>
                          {wt('暂无执行历史（首轮执行后这里会显示每轮的进度记录）')}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
