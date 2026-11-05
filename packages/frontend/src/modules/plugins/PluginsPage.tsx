import { ExtensionCatalog } from '../tools/ExtensionCatalog';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 插件市场（市场形态：搜索 + 状态分类 + 卡片网格 + 加载/启停，功能与原插件管理页一致）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { Icon } from '@/components/Icon';
import type { PluginInfo } from '@/types';

import { EcosystemPage } from '../account/EcosystemPage';
import { McpConnections } from './McpConnections';
import { PluginConfiguration } from './PluginConfiguration';

/** 状态分类（真实数据过滤，不造假分类） */
type StatusCategory = 'all' | 'loaded' | 'unloaded' | 'disabled';

const STATUS_CATEGORIES: StatusCategory[] = ['all', 'loaded', 'unloaded', 'disabled'];
const categoryLabel = (value: StatusCategory) =>
  ({ all: wt('全部'), loaded: wt('已加载'), unloaded: wt('未加载'), disabled: wt('已禁用') })[
    value
  ];

export function PluginsPage() {
  useWorkbenchLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'connections';
  const setTab = (next: string) => setSearchParams({ tab: next }, { replace: true });
  return (
    <div className="overflow-y-auto h-full">
      <header className="px-6 pt-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Icon name="plugin" size={20} />
          {wt('插件')}
        </h1>
        <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
          {wt('连接第三方工具、安装资源，并管理本地扩展。')}
        </p>
      </header>
      <div className="sky-resource-tabs flex-wrap">
        <button aria-pressed={tab === 'connections'} onClick={() => setTab('connections')}>
          {wt('MCP 连接')}
        </button>
        <button aria-pressed={tab === 'official'} onClick={() => setTab('official')}>
          {wt('MCP 插件资源')}
        </button>
        <button aria-pressed={tab === 'local'} onClick={() => setTab('local')}>
          {wt('本地插件')}
        </button>
      </div>
      {tab === 'official' ? (
        <EcosystemPage resourceKind="mcp" />
      ) : tab === 'local' ? (
        <InstalledPluginsPage />
      ) : (
        <div className="p-6">
          <McpConnections />
        </div>
      )}
    </div>
  );
}

function InstalledPluginsPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StatusCategory>('all');
  const [configuring,setConfiguring]=useState<PluginInfo|null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiClient.get<PluginInfo[]>('/plugins');
      setPlugins(list ?? []);
    } catch (e) {
      toast.error(wt('加载插件失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadPlugin = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await apiClient.post(`/plugins/${id}/load`, {});
        toast.success(wt('插件已加载'));
        load();
      } catch (e) {
        toast.error(wt('加载失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const toggle = useCallback(
    async (p: PluginInfo) => {
      setBusyId(p.id);
      try {
        // 后端启用/禁用走 PUT /plugins/toggle（body: {id, enabled}）
        await apiClient.put('/plugins/toggle', { id: p.id, enabled: !p.enabled });
        toast.success(p.enabled ? wt('已禁用') : wt('已启用'));
        load();
      } catch (e) {
        toast.error(wt('操作失败'), e instanceof Error ? e.message : undefined);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (category === 'loaded' && !p.loaded) return false;
      if (category === 'disabled' && p.enabled) return false;
      if (category === 'unloaded' && (p.loaded || !p.enabled)) return false;
      if (!q) return true;
      return [p.name, p.description, p.author].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [plugins, query, category]);

  const statusBadge = (p: PluginInfo) => {
    if (!p.enabled) return <Badge>{wt('已禁用')}</Badge>;
    return p.loaded ? (
      <Badge variant="success">{wt('已加载')}</Badge>
    ) : (
      <Badge>{wt('未加载')}</Badge>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.pluginManager')}</div>
          <div className="page-subtitle">{t('views.pluginsCount', { count: plugins.length })}</div>
        </div>
        <Button variant="secondary" onClick={load}>
          {t('common.refresh')}
        </Button>
      </div>

      {/* 搜索 + 状态分类（市场形态） */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <span
            className="absolute"
            style={{ left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}
          >
            <Icon name="search" size={16} />
          </span>
          <input
            className="input-field text-sm w-full"
            style={{ paddingLeft: 32 }}
            placeholder={wt('搜索插件（名称 / 描述 / 作者）')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_CATEGORIES.map((c) => (
            <button
              key={c}
              className={
                'text-xs px-2.5 py-1 rounded-full ' +
                (category === c
                  ? 'bg-cyan-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600')
              }
              onClick={() => setCategory(c)}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>
      </div>

      <ExtensionCatalog kind="plugins" onChange={load} />
      {loading ? (
        <SpinnerWrap label={wt('加载中…')} />
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="plugin" size={48} />
          </div>
          <div>{plugins.length === 0 ? wt('暂无插件') : wt('没有匹配的插件')}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((p) => (
            <div className="card p-3 flex items-start gap-3" key={p.id}>
              <span
                className="flex items-center justify-center shrink-0 rounded bg-cyan-900/30 text-cyan-400"
                style={{ width: 36, height: 36 }}
              >
                <Icon name="plugin" size={20} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-primary truncate">{p.name}</span>
                  <Badge variant="info">v{p.version}</Badge>
                  {statusBadge(p)}
                </div>
                <p
                  className="text-xs text-gray-400 mt-0.5"
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {p.description}
                </p>
                <div className="text-[11px] text-gray-600 mt-1">
                  {p.author ? (
                    <span>
                      {wt('作者')}
                      {p.author}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0 self-center">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => loadPlugin(p.id)}
                  loading={busyId === p.id}
                  disabled={!p.enabled || p.loaded}
                >
                  {p.loaded ? wt('已加载') : wt('加载')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggle(p)}>
                  {p.enabled ? wt('禁用') : wt('启用')}
                </Button>
                <Button size="sm" variant="ghost" onClick={()=>setConfiguring(p)}>{wt('配置')}</Button>
                <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={async()=>{setBusyId(p.id);try{await apiClient.delete(`/plugins/${encodeURIComponent(p.id)}`);await load();}catch(e){toast.error(wt('操作失败'),e instanceof Error?e.message:undefined);}finally{setBusyId(null);}}}>{wt('卸载')}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {configuring&&<PluginConfiguration id={configuring.id} name={configuring.name} onClose={()=>setConfiguring(null)}/>}
    </div>
  );
}
