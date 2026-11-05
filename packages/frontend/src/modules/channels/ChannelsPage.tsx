import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 渠道管理页面：渠道管理 / 路由绑定双标签页（对齐旧版 channel.js）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { Icon } from '@/components/Icon';
import { ChannelConfigModal } from '@/components/modals/ChannelConfigModal';
import { formatRelativeTime } from '@/utils/format';
import type { ChannelConfig, ChannelMessage, ChannelStatusInfo } from '@/types';
import { BindingsPage } from '@/modules/bindings/BindingsPage';

type PageTab = 'manage' | 'bindings';

export function ChannelsPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [tab, setTab] = useState<PageTab>('manage');
  return (
    <div className="page">
      {/* 双标签页：渠道管理 / 路由绑定 */}
      <div className="flex gap-2 mb-4 border-b border-gray-700">
        <button
          className={`tab-btn ${tab === 'manage' ? 'active' : ''}`}
          onClick={() => setTab('manage')}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="channel" size={14} /> {t('views.channelsManage')}
          </span>
        </button>
        <button
          className={`tab-btn ${tab === 'bindings' ? 'active' : ''}`}
          onClick={() => setTab('bindings')}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="channel" size={14} /> {t('views.bindings')}
          </span>
        </button>
      </div>
      {tab === 'manage' ? <ChannelsManageTab /> : <BindingsPage />}
    </div>
  );
}

/* ────────────────────────────── 渠道管理标签页 ────────────────────────────── */

function ChannelsManageTab() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ChannelStatusInfo>>({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<ChannelConfig | null>(null);
  const [target, setTarget] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  /** 配置弹窗目标渠道 */
  const [configuring, setConfiguring] = useState<ChannelConfig | null>(null);
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([]);
  const [pendingChannels, setPendingChannels] = useState<Set<string>>(new Set());
  /** 消息日志：渠道 id → 消息列表 */
  const [messageLogs, setMessageLogs] = useState<Record<string, ChannelMessage[]>>({});
  /** 展开消息日志的渠道 id */
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  /** 刷新渠道状态快照：GET /channels/status */
  const refreshStatus = useCallback(async () => {
    try {
      const all = await apiClient.get<Record<string, ChannelStatusInfo>>('/channels/status');
      if (all && typeof all === 'object') {
        setStatuses(all as Record<string, ChannelStatusInfo>);
      }
    } catch {
      /* 状态快照失败时静默，保留旧状态 */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiClient.get<ChannelConfig[]>('/channels');
      setChannels((list ?? []).filter(c=>['weixin','wechat-work','dingtalk','feishu','email','sms','cli','webchat'].includes(c.type)));
      await refreshStatus();
    } catch (e) {
      toast.error(wt('加载渠道失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { void refreshStatus(); }, 5000);
    return () => clearInterval(timer);
  }, [load, refreshStatus]);

  const connect = useCallback(
    async (id: string) => {
      try {
        await apiClient.post(`/channels/${id}/connect`, {}, {timeoutMs:120000});
        toast.success(wt('连接请求已发送'));
        load();
      } catch (e) {
        toast.error(wt('连接失败'), e instanceof Error ? e.message : undefined);
      }
    },
    [load],
  );

  /** 断开连接：POST /channels/:id/disconnect */
  const disconnect = useCallback(
    async (id: string) => {
      try {
        await apiClient.post(`/channels/${id}/disconnect`, {});
        toast.success(wt('已断开连接'));
        load();
      } catch (e) {
        toast.error(wt('断开失败'), e instanceof Error ? e.message : undefined);
      }
    },
    [load],
  );

  /** 启用/禁用：PUT /channels/:id 切换 enabled */
  const toggleChannel = useCallback(
    async (c: ChannelConfig) => {
      setPendingChannels(s => new Set(s).add(c.id));
      try {
        const result = await apiClient.put<{channel?:ChannelStatusInfo}>(`/channels/${c.id}`, { enabled: !c.enabled }, {timeoutMs:120000});
        if (result.channel?.lastError) toast.error(wt('配置已保存，但连接失败'), result.channel.lastError);
        else toast.success(c.enabled ? wt('渠道已禁用') : wt('渠道已启用'));
        await load();
      } catch (e) {
        toast.error(wt('切换失败'), e instanceof Error ? e.message : undefined);
      } finally { setPendingChannels(s => {const next=new Set(s);next.delete(c.id);return next;}); }
    },
    [load],
  );

  /** 保存渠道配置：PUT /channels/:id */
  const saveChannelConfig = useCallback(
    async (channelId: string, values: Record<string, unknown>, enabled: boolean) => {
      try {
        const result = await apiClient.put<{channel?:ChannelStatusInfo}>(`/channels/${channelId}?background=true`, {
          name: configuring?.name,
          enabled,
          credentials: values,
        }, {timeoutMs:120000});
        if(result.channel?.lastError) toast.error(wt('配置已保存，但连接失败'), result.channel.lastError);
        else toast.success(result.channel?.status === 'connecting' ? wt('配置已保存，正在连接') : wt('配置已保存'));
        setConfiguring(null);
        load();
      } catch (e) {
        toast.error(wt('保存配置失败'), e instanceof Error ? e.message : undefined);
        throw e;
      }
    },
    [configuring, load],
  );

  /** 加载渠道消息日志：GET /channels/:id/messages */
  const toggleMessageLog = useCallback(
    async (id: string) => {
      if (expandedLog === id) {
        setExpandedLog(null);
        return;
      }
      setExpandedLog(id);
      try {
        const msgs = await apiClient.get<ChannelMessage[]>(`/channels/${id}/messages`);
        setMessageLogs((prev) => ({ ...prev, [id]: msgs ?? [] }));
      } catch {
        setMessageLogs((prev) => ({ ...prev, [id]: [] }));
      }
    },
    [expandedLog],
  );

  const openSend = useCallback((c: ChannelConfig) => {
    setSending(c);
    setTarget('');
    setContent('');
  }, []);

  /** 已保存凭据：引用稳定（仅随 configuring 变化），避免每次渲染触发弹窗内 effect */
  const savedConfig = useMemo(
    () => (configuring?.credentials ?? {}) as Record<string, any>,
    [configuring],
  );

  const openConfiguration = async (channel: ChannelConfig) => {
    try {
      const result = await apiClient.get<{credentials:Record<string,unknown>;configuredSecrets:string[]}>(`/channels/${channel.id}/config`);
      setConfiguredSecrets(result.configuredSecrets ?? []);
      setConfiguring({...channel,credentials:result.credentials as ChannelConfig['credentials']});
    } catch(e) { toast.error(wt('加载渠道配置失败'),e instanceof Error?e.message:undefined); }
  };

  const send = useCallback(async () => {
    if (!sending) return;
    setBusy(true);
    try {
      await apiClient.post(`/channels/${sending.id}/send`, { target, content }, {timeoutMs:120000});
      toast.success(wt('消息已发送'));
      setSending(null);
    } catch (e) {
      toast.error(wt('发送失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }, [sending, target, content]);

  const statusBadge = (c: ChannelConfig) => {
    const s = statuses[c.id];
    if (!s)
      return c.enabled ? (
        <Badge variant="info">{t('common.unknown')}</Badge>
      ) : (
        <Badge>{t('common.disabled')}</Badge>
      );
    if (s.status === 'connected') return <Badge variant="success">{t('topbar.connected')}</Badge>;
    if (s.status === 'connecting') return <Badge variant="warning">{t('common.connect')}</Badge>;
    if (s.status === 'error') return <Badge variant="danger">{t('common.error')}</Badge>;
    return <Badge>{t('topbar.disconnected')}</Badge>;
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.channelsManage')}</div>
          <div className="page-subtitle">{t('common.totalCount', { count: channels.length })}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={refreshStatus}>
            <span className="inline-flex items-center gap-1">
              <Icon name="refresh" size={12} /> {t('common.refreshStatus')}
            </span>
          </Button>
          <Button variant="secondary" onClick={load}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {loading ? (
        <SpinnerWrap label={t('common.loading')} />
      ) : channels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="channel" size={48} />
          </div>
          <div>{t('common.noData')}</div>
        </div>
      ) : (
        /* 旧版 renderChannelsView：渠道卡片（名称+id+状态/启用徽标+分类+按钮组） */
        <div className="grid grid-cols-1 gap-3">
          {channels.map((c) => {
            const s = statuses[c.id];
            // 列表项自带 status（后端 listChannels 已合并 provider 实际状态），优先使用
            const liveStatus = s?.status ?? (c as { status?: string }).status;
            const cat = (c as { category?: string }).category;
            const isLocal = cat === 'local';
            const isConn = liveStatus === 'connected';
            const lastError = s?.lastError ?? (c as unknown as ChannelStatusInfo).lastError;
            const hasError = !!lastError;
            const statusBadgeCls = isConn
              ? 'badge badge-green'
              : hasError
                ? 'badge badge-red'
                : 'badge badge-gray';
            const statusText = isLocal && isConn
              ? wt('始终在线')
              : isConn
                ? t('topbar.connected')
                : hasError
                  ? t('common.error')
                  : liveStatus === 'connecting' ? wt('正在连接…') : wt('未连接');
            const connectable = [
              'dingtalk',
              'feishu',
              'wechat-work',
              'weixin',
            ].includes(c.type);
            return (
              <div className="card p-4" key={c.id} id={`channel-card-${c.id}`}>
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{wt(c.name)}</span>
                    <code className="text-xs text-gray-500">{c.id}</code>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={statusBadgeCls}>{statusText}</span>
                    {c.enabled ? (
                      <span className="badge badge-green text-xs">{t('common.enabled')}</span>
                    ) : (
                      <span className="badge badge-gray text-xs">{t('common.disabled')}</span>
                    )}
                  </div>
                </div>

                {cat ? (
                  <p className="text-xs text-gray-400 mb-2">
                    {(
                      {
                        local: wt('本地'),
                        im: wt('即时通讯'),
                        enterprise: wt('企业应用'),
                        other: wt('其他'),
                      } as Record<string, string>
                    )[cat] ?? cat}
                  </p>
                ) : null}

                {connectable && <p className="text-xs mb-2" style={{color:'var(--text-muted)'}}>
                  {wt('收到消息后自动处理并回复')}
                </p>}
                {lastError ? (
                  <p className="text-xs text-red-400 bg-red-900/20 rounded p-1 mb-2">
                    {wt('错误:')}
                    {lastError}
                  </p>
                ) : null}
                {!connectable && !isLocal ? <p className="text-xs text-gray-500 mb-2">{wt('该渠道尚未接入，暂不能启用或连接')}</p> : null}

                <div className="flex gap-1 flex-wrap">
                  {connectable ? (
                    isConn ? (
                      <button
                        className="bg-red-700 hover:bg-red-600 text-xs py-1 px-2"
                        onClick={() => disconnect(c.id)}
                        disabled={pendingChannels.has(c.id)}
                      >
                        {wt('断开')}
                      </button>
                    ) : (
                      <button
                        className="btn-primary text-xs py-1 px-2"
                        onClick={() => connect(c.id)}
                        disabled={!c.enabled || pendingChannels.has(c.id) || liveStatus==='connecting'}
                      >
                        {wt('连接')}
                      </button>
                    )
                  ) : isLocal ? (
                    <span className="text-xs text-gray-500 bg-gray-800 rounded px-2 py-1">
                      {wt('内置渠道')}
                    </span>
                  ) : (
                    <button
                      className="btn-secondary text-xs py-1 px-1 opacity-50 cursor-not-allowed"
                      disabled
                    >
                      {wt('连接')}
                    </button>
                  )}
                  <Button size="sm" variant="secondary" disabled={pendingChannels.has(c.id) || (!connectable && !isLocal && !c.enabled)} onClick={() => toggleChannel(c)}>
                    {c.enabled ? wt('禁用') : wt('启用')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={pendingChannels.has(c.id) || (!connectable && !isLocal)} onClick={() => openConfiguration(c)}>
                    {wt('配置')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleMessageLog(c.id)}>
                    {expandedLog === c.id ? wt('收起日志') : wt('消息日志')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!connectable || !isConn} onClick={() => openSend(c)}>
                    {wt('发送')}
                  </Button>
                </div>

                {/* 消息日志 */}
                {expandedLog === c.id ? (
                  <div style={{ marginTop: 8, maxHeight: 160, overflowY: 'auto' }}>
                    {(messageLogs[c.id] ?? []).length === 0 ? (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {wt('暂无消息记录')}
                      </div>
                    ) : (
                      (messageLogs[c.id] ?? []).map((m) => (
                        <div
                          key={m.id}
                          className="text-xs"
                          style={{ display: 'flex', gap: 8, padding: '2px 0' }}
                        >
                          <Badge variant={m.direction === 'inbound' ? 'info' : 'success'}>
                            {m.direction === 'inbound' ? wt('收到') : wt('发出')}
                          </Badge>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {m.sender || m.target || '-'}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {m.content}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {formatRelativeTime(m.timestamp)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* 发送消息弹窗 */}
      <Modal
        open={!!sending}
        title={sending ? wt('发送消息 - {{v0}}', { v0: wt(sending.name) }) : ''}
        onClose={() => setSending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSending(null)}>
              {wt('取消')}
            </Button>
            <Button variant="primary" onClick={send} loading={busy} disabled={!content}>
              {wt('发送')}
            </Button>
          </>
        }
      >
        <div className="form-row">
          <Input
            label={wt('目标')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={wt('用户/群组标识')}
          />
        </div>
        <Input
          label={wt('消息内容')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={wt('输入消息')}
        />
      </Modal>

      {/* 渠道配置弹窗 */}
      <ChannelConfigModal
        open={!!configuring}
        channelId={configuring?.id ?? ''}
        channelName={configuring?.name ? wt(configuring.name) : undefined}
        channelEnabled={configuring?.enabled ?? true}
        savedConfig={savedConfig}
        configuredSecrets={configuredSecrets}
        onClose={() => setConfiguring(null)}
        onSave={saveChannelConfig}
      />
    </>
  );
}
