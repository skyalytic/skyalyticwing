import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 监控面板：健康状态、日志、统计
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { formatUptime, formatNumber, formatRelativeTime } from '@/utils/format';
import type { HealthInfo, LogEntry, MonitorStats } from '@/types';

const HEALTH_LABEL: Record<string, string> = {
  get ok() {
    return wt('正常');
  },
  get degraded() {
    return wt('降级');
  },
  get down() {
    return wt('不可用');
  },
};

export function MonitorPage({ embedded = false }: { embedded?: boolean }) {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      const [h, s, l] = await Promise.allSettled([
        apiClient.get<HealthInfo>('/monitor/health'),
        apiClient.get<MonitorStats>('/monitor/stats'),
        apiClient.get<LogEntry[]>('/monitor/logs'),
      ]);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (s.status === 'fulfilled') setStats(s.value);
      if (l.status === 'fulfilled') setLogs(l.value ?? []);
    } catch (e) {
      toast.error(wt('加载监控数据失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const healthVariant =
    health?.status === 'ok' ? 'success' : health?.status === 'degraded' ? 'warning' : 'danger';

  return (
    <div className={embedded ? 'min-w-0' : 'page'}>
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.monitorPanel')}</div>
          <div className="page-subtitle">
            {t('views.realtimeStatus')} ·{' '}
            {autoRefresh ? t('views.autoRefresh') : t('common.paused')}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={autoRefresh ? 'secondary' : 'ghost'}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? t('common.pause') : t('common.resume')}
          </Button>
          <Button size="sm" variant="secondary" onClick={load}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {loading ? (
        <SpinnerWrap label={wt('加载中…')} />
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">{wt('系统状态')}</div>
              <div className="stat-value">
                <Badge variant={healthVariant}>
                  {HEALTH_LABEL[health?.status ?? 'down'] ?? wt('未知')}
                </Badge>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('运行时长')}</div>
              <div className="stat-value text-sm">
                {health ? formatUptime(health.uptime) : '--'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('会话数')}</div>
              <div className="stat-value">{stats ? formatNumber(stats.sessions) : '--'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('消息数')}</div>
              <div className="stat-value">{stats?.messages != null ? formatNumber(stats.messages) : '--'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('工具调用')}</div>
              <div className="stat-value">{stats?.toolCalls != null ? formatNumber(stats.toolCalls) : '--'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('Token 用量')}</div>
              <div className="stat-value">{stats?.tokensUsed != null ? formatNumber(stats.tokensUsed) : '--'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{wt('活跃连接')}</div>
              <div className="stat-value">
                {stats ? formatNumber(stats.activeConnections ?? stats.connections) : '--'}
              </div>
            </div>
            {health?.version ? (
              <div className="stat-card">
                <div className="stat-label">{wt('版本')}</div>
                <div className="stat-value text-sm">{health.version}</div>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">{wt('最近日志')}</div>
              <span className="text-sm text-muted">
                {logs.length} {wt('条')}
              </span>
            </div>
            {logs.length === 0 ? (
              <div className="empty-state">{wt('暂无日志')}</div>
            ) : (
              <div className="log-list">
                {logs.slice(-200).map((log) => (
                  <div className="log-line" key={log.id}>
                    <span className="text-dim">{formatRelativeTime(log.timestamp)}</span>
                    <span className={`log-level ${log.level}`}>{log.level}</span>
                    <span>{log.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
