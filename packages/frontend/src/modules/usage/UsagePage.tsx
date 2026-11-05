import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 用量统计页面
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';

interface UsageBucket {
  date?: string;
  model?: string;
  requests?: number;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

interface UsageData {
  today?: UsageBucket;
  thisMonth?: UsageBucket;
  total?: UsageBucket;
  byProvider?: Array<{ provider: string; percentage?: number; tokens?: number }>;
  byDay?: UsageBucket[];
  byModel?: UsageBucket[];
  activeSessions?: number;
}

function fmtTokens(n?: number): string {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n?: number): string {
  if (!n) return '$0.00';
  return '$' + n.toFixed(2);
}

export function UsagePage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [data, setData] = useState<UsageData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState('all');
  const [range, setRange] = useState<'today' | 'month' | 'all'>('month');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/usage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: UsageData = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('加载用量失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const models = useMemo(() => {
    const set = new Set<string>();
    (data.byModel || []).forEach((m) => m.model && set.add(m.model));
    return Array.from(set);
  }, [data]);

  const buckets = useMemo(() => {
    const all = data.byDay || data.byModel || [];
    if (model === 'all') return all;
    return all.filter((b) => b.model === model);
  }, [data, model]);

  const rangeData: UsageBucket = useMemo(() => {
    if (range === 'today') return data.today || {};
    if (range === 'month') return data.thisMonth || {};
    return data.total || {};
  }, [data, range]);

  const maxTokens = useMemo(() => {
    return Math.max(1, ...buckets.map((b) => b.tokens || 0));
  }, [buckets]);

  const stats = [
    {
      label: wt('总请求数'),
      value: String(rangeData.requests || 0),
      icon: 'usage',
      color: 'text-blue-400',
    },
    {
      label: wt('总 Token 数'),
      value: fmtTokens(rangeData.tokens),
      icon: 'data',
      color: 'text-purple-400',
    },
    {
      label: wt('总费用'),
      value: fmtCost(rangeData.cost),
      icon: 'zap',
      color: 'text-green-400',
    },
    {
      label: wt('活跃会话数'),
      value: String(data.activeSessions || 0),
      icon: 'session',
      color: 'text-yellow-400',
    },
  ];

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="usage" size={20} /> {t('views.usage')}
        </h2>
        <button className="btn-secondary text-sm" onClick={load}>
          <span className="inline-flex items-center gap-1">
            <Icon name="refresh" size={14} /> {t('common.refresh')}
          </span>
        </button>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        <select
          className="input-field text-sm"
          value={range}
          onChange={(e) => setRange(e.target.value as 'today' | 'month' | 'all')}
        >
          <option value="today">{wt('今日')}</option>
          <option value="month">{wt('本月')}</option>
          <option value="all">{wt('全部')}</option>
        </select>
        <select
          className="input-field text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="all">{wt('全部模型')}</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-gray-400">
          <span className="spinner inline-block" />
          <p className="mt-2 text-sm">{wt('加载中…')}</p>
        </div>
      ) : error ? (
        <div className="card p-8 text-center text-red-400">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Icon name="alert" size={20} />
            <span>{wt('加载失败')}</span>
          </div>
          <p className="text-sm text-gray-500">{error}</p>
          <button className="btn-secondary text-sm mt-3" onClick={load}>
            {wt('重试')}
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {stats.map((s) => (
              <div className="bg-gray-800/50 rounded p-3" key={s.label}>
                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                  <Icon name={s.icon} size={12} /> {s.label}
                </div>
                <div className={'text-lg font-bold ' + s.color}>{s.value}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="card p-4">
              <p className="text-gray-400 text-sm">{wt('输入 / 输出 Token')}</p>
              <p className="text-xl font-bold text-blue-400 mt-1">
                {fmtTokens(rangeData.promptTokens)} / {fmtTokens(rangeData.completionTokens)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-gray-400 text-sm">{wt('请求次数')}</p>
              <p className="text-xl font-bold text-purple-400 mt-1">{rangeData.requests || 0}</p>
            </div>
          </div>

          {buckets.length > 0 ? (
            <div className="card p-4 mb-4">
              <h3 className="text-sm font-medium mb-3 flex items-center gap-1">
                <Icon name="data" size={16} /> {wt('用量分布（柱状图）')}
              </h3>
              <div className="flex items-end gap-2" style={{ height: 180 }}>
                {buckets.slice(-20).map((b, i) => {
                  const heightPct = Math.max(2, ((b.tokens || 0) / maxTokens) * 100);
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col items-center justify-end"
                      style={{ height: '100%' }}
                      title={`${b.date || b.model || ''}: ${fmtTokens(b.tokens)} tokens`}
                    >
                      <span className="text-xs text-gray-500 mb-1">{fmtTokens(b.tokens)}</span>
                      <div
                        className="w-full rounded-t bg-blue-500"
                        style={{ height: `${heightPct}%`, minHeight: 4 }}
                      />
                      <span className="text-xs text-gray-500 mt-1 truncate w-full text-center">
                        {b.date ? b.date.slice(5) : b.model || ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {data.byProvider && data.byProvider.length > 0 ? (
            <div className="card p-4">
              <h3 className="font-semibold mb-3">{wt('按提供商分布')}</h3>
              <div className="space-y-2">
                {data.byProvider.map((p) => (
                  <div className="flex items-center gap-2" key={p.provider}>
                    <span className="w-24 text-sm">{p.provider}</span>
                    <div className="flex-1 bg-gray-700 rounded h-4 overflow-hidden">
                      <div
                        className="bg-blue-500 h-4 rounded"
                        style={{ width: `${Math.min(p.percentage || 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm">{p.percentage || 0}%</span>
                    <span className="text-xs text-gray-500 ml-1">{fmtTokens(p.tokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {!loading && buckets.length === 0 && !(data.byProvider && data.byProvider.length) ? (
            <div className="card p-8 text-center">
              <div className="mb-3 opacity-30">
                <Icon name="usage" size={48} />
              </div>
              <p className="text-gray-400">{wt('暂无使用记录')}</p>
              <p className="text-xs text-gray-500 mt-1">{wt('开始对话后将自动统计用量')}</p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
