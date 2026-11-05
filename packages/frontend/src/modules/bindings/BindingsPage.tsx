import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 路由绑定管理页面
// 对齐旧版 modules/bindings.js：列表展示、8 层优先级说明、添加/删除绑定
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
import type { AgentInfo, ChannelConfig } from '@/types';

/** 对端标识 */
export interface BindingPeer {
  kind?: string;
  id?: string;
}

/** 绑定匹配条件 */
export interface BindingMatch {
  channel?: string;
  peer?: BindingPeer;
  guildId?: string;
  teamId?: string;
  accountId?: string;
  role?: string;
}

/** 路由绑定 */
export interface RouteBinding {
  id: string;
  agentId: string;
  match: BindingMatch;
}

/** 8 层优先级说明（从高到低） */
const PRIORITY_LEVELS: { label: string; desc: string }[] = [
  {
    get label() {
      return wt('精确对端');
    },
    get desc() {
      return wt('peer.kind + peer.id 完全匹配');
    },
  },
  {
    get label() {
      return wt('父级继承');
    },
    get desc() {
      return wt('父级节点路由继承');
    },
  },
  {
    get label() {
      return wt('通配对端');
    },
    get desc() {
      return wt('通配 peer 匹配');
    },
  },
  {
    get label() {
      return wt('Guild + 角色');
    },
    get desc() {
      return wt('guildId + role 命中');
    },
  },
  {
    label: 'Guild',
    get desc() {
      return wt('仅 guildId 命中');
    },
  },
  {
    label: 'Team',
    get desc() {
      return wt('teamId 命中');
    },
  },
  {
    label: 'Account',
    get desc() {
      return wt('accountId 命中');
    },
  },
  {
    label: 'Channel',
    get desc() {
      return wt('仅 channel 命中（最低）');
    },
  },
];

const EMPTY_FORM: BindingForm = {
  agentId: '',
  channel: '',
  peerKind: '',
  peerId: '',
  guildId: '',
  teamId: '',
  accountId: '',
};

interface BindingForm {
  agentId: string;
  channel: string;
  peerKind: string;
  peerId: string;
  guildId: string;
  teamId: string;
  accountId: string;
}

export function BindingsPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<RouteBinding[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<BindingForm>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<RouteBinding | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 后端返回 ApiResponse<{ bindings: Binding[] }>，apiClient 解包 data 后为 { bindings: [...] }
      const res = await apiClient.get<RouteBinding[] | { bindings?: RouteBinding[] }>('/bindings');
      const list: RouteBinding[] = Array.isArray(res) ? res : (res?.bindings ?? []);
      setBindings(list);
    } catch (e) {
      toast.error(wt('加载路由绑定失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  // 并发拉取 agents / channels 供表单下拉使用（容错）
  useEffect(() => {
    let active = true;
    Promise.all([
      apiClient.get<AgentInfo[]>('/agents').catch(() => [] as AgentInfo[]),
      apiClient.get<ChannelConfig[]>('/channels').catch(() => [] as ChannelConfig[]),
    ]).then(([a, c]) => {
      if (!active) return;
      setAgents(a ?? []);
      setChannels(c ?? []);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = useCallback(() => {
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  }, []);

  const submitCreate = useCallback(async () => {
    if (!form.agentId) {
      toast.warn(wt('请选择 Agent'));
      return;
    }
    const match: BindingMatch = {};
    if (form.channel) match.channel = form.channel;
    if (form.peerId) match.peer = { kind: form.peerKind || undefined, id: form.peerId };
    if (form.guildId) match.guildId = form.guildId;
    if (form.teamId) match.teamId = form.teamId;
    if (form.accountId) match.accountId = form.accountId;

    setSaving(true);
    try {
      const created = await apiClient.post<RouteBinding>('/bindings', {
        agentId: form.agentId,
        match,
      });
      if (created) {
        setBindings((prev) => [...prev, created]);
      } else {
        await load();
      }
      toast.success(wt('绑定已添加'));
      setCreateOpen(false);
    } catch (e) {
      toast.error(wt('添加绑定失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }, [form, load]);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiClient.delete(`/bindings/${target.id}`);
      setBindings((prev) => prev.filter((b) => b.id !== target.id));
      toast.success(wt('绑定已删除'));
    } catch (e) {
      toast.error(wt('删除绑定失败'), e instanceof Error ? e.message : undefined);
    }
  }, [deleting]);

  /** 渲染单条绑定的匹配条件摘要 */
  const renderMatchSummary = useCallback((m: BindingMatch) => {
    const parts: string[] = [];
    parts.push(`channel: ${m.channel || '*'}`);
    if (m.peer && (m.peer.kind || m.peer.id)) {
      parts.push(`peer: ${[m.peer.kind, m.peer.id].filter(Boolean).join('/')}`);
    }
    if (m.guildId) parts.push(`guild: ${m.guildId}`);
    if (m.teamId) parts.push(`team: ${m.teamId}`);
    if (m.accountId) parts.push(`acct: ${m.accountId}`);
    return parts.join(' / ');
  }, []);

  const agentName = useMemo(() => {
    const map = new Map(agents.map((a) => [a.id, a.name || a.id]));
    return (id: string) => map.get(id) ?? id ?? '?';
  }, [agents]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">
            <Icon name="channel" size={20} /> {t('views.bindings')}
          </div>
          <div className="page-subtitle">
            {t('views.bindingsCount', { count: bindings.length })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={load}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={openCreate}>
            {t('views.addBinding')}
          </Button>
        </div>
      </div>

      {/* 8 层优先级说明 */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: uiFontSize(14), color: 'var(--text-muted)', marginBottom: 8 }}>
          {wt(
            '路由绑定决定不同渠道/群组的消息由哪个 Agent 处理。支持 8 层优先级匹配（从高到低）：',
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PRIORITY_LEVELS.map((lv, i) => (
            <Badge key={lv.label} variant="info">
              {i + 1}. {lv.label}
              <span style={{ marginLeft: 6, color: 'var(--text-secondary)' }}>{lv.desc}</span>
            </Badge>
          ))}
        </div>
      </div>

      {loading ? (
        <SpinnerWrap label={wt('加载中…')} />
      ) : bindings.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icon name="channel" size={48} />
          </div>
          <div>{wt('暂无路由绑定，所有消息使用默认 Agent')}</div>
        </div>
      ) : (
        <div className="list">
          {bindings.map((b) => (
            <div className="list-row" key={b.id}>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span style={{ color: 'var(--accent)' }}>{agentName(b.agentId)}</span>
                </div>
                <div className="list-row-sub">{renderMatchSummary(b.match || {})}</div>
              </div>
              <div className="list-row-actions">
                <Button size="sm" variant="danger" onClick={() => setDeleting(b)}>
                  {wt('删除')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 添加绑定表单 */}
      <Modal
        open={createOpen}
        title={wt('添加路由绑定')}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {wt('取消')}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form.agentId}
              onClick={submitCreate}
            >
              {wt('保存')}
            </Button>
          </>
        }
      >
        <div className="form-row">
          <div className="input-group">
            <label className="input-label" htmlFor="binding-agent">
              Agent
            </label>
            <select
              id="binding-agent"
              className="select"
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
            >
              <option value="">{wt('请选择 Agent')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="input-group">
            <label className="input-label" htmlFor="binding-channel">
              {wt('渠道')}
            </label>
            <select
              id="binding-channel"
              className="select"
              value={form.channel}
              onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
            >
              <option value="">{wt('*（所有渠道）')}</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row" style={{ display: 'flex', gap: 12 }}>
          <div className="input-group" style={{ flex: '0 0 140px' }}>
            <label className="input-label" htmlFor="binding-peer-kind">
              {wt('对端类型')}
            </label>
            <Input
              id="binding-peer-kind"
              value={form.peerKind}
              onChange={(e) => setForm((f) => ({ ...f, peerKind: e.target.value }))}
              placeholder={wt('如 user/group')}
            />
          </div>
          <div className="input-group" style={{ flex: 1 }}>
            <label className="input-label" htmlFor="binding-peer-id">
              {wt('对端 ID')}
            </label>
            <Input
              id="binding-peer-id"
              value={form.peerId}
              onChange={(e) => setForm((f) => ({ ...f, peerId: e.target.value }))}
              placeholder={wt('精确对端标识（留空表示通配）')}
            />
          </div>
        </div>

        <div className="form-row">
          <Input
            label="Guild ID"
            value={form.guildId}
            onChange={(e) => setForm((f) => ({ ...f, guildId: e.target.value }))}
            placeholder={wt('可选')}
          />
        </div>

        <div className="form-row" style={{ display: 'flex', gap: 12 }}>
          <div className="input-group" style={{ flex: 1 }}>
            <Input
              label="Team ID"
              value={form.teamId}
              onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
              placeholder={wt('可选')}
            />
          </div>
          <div className="input-group" style={{ flex: 1 }}>
            <Input
              label="Account ID"
              value={form.accountId}
              onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}
              placeholder={wt('可选')}
            />
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={!!deleting}
        title={wt('删除确认')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {wt('取消')}
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              {wt('确认删除')}
            </Button>
          </>
        }
      >
        <div style={{ fontSize: uiFontSize(14) }}>
          {wt('确定要删除绑定')}
          <span style={{ color: 'var(--accent)', margin: '0 4px' }}>
            {deleting ? agentName(deleting.agentId) : ''}
          </span>
          {wt('吗？此操作不可撤销。')}
        </div>
      </Modal>
    </div>
  );
}

export default BindingsPage;
