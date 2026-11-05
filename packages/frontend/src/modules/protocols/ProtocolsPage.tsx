import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { Icon } from '@/components/Icon';
import { toast } from '@/components/ui/Toast';
import { apiClient } from '@/services/api-client';

/** Outbound client connections live in Plugins; these settings expose Wing to external clients. */
export function ProtocolsPage() {
  useWorkbenchLanguage();
  const [tab, setTab] = useState<'loopback' | 'acp'>('loopback');
  return (
    <section className="sky-protocol-settings">
      <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
        {wt('配置外部应用调用 Wing 的协议服务。连接和安装第三方 MCP 请前往插件。')}{' '}
        <Link to="/plugins?tab=connections" className="text-blue-400">
          {wt('打开插件')}
        </Link>
      </p>
      <div className="sky-resource-tabs mb-4" style={{ padding: 0 }}>
        <button aria-pressed={tab === 'loopback'} onClick={() => setTab('loopback')}>
          MCP Loopback
        </button>
        <button aria-pressed={tab === 'acp'} onClick={() => setTab('acp')}>
          {wt('ACP 协议')}
        </button>
      </div>
      {tab === 'loopback' ? <LoopbackTab /> : <AcpTab />}
    </section>
  );
}

/** GET /mcp/loopback/status 返回（裸对象，非 ApiResponse 包装） */
interface LoopbackStatus {
  running?: boolean;
  port?: number;
  token?: string;
  url?: string;
  config?: Record<string, unknown> | null;
}

/** Loopback 暴露的频道桥接工具（旧版静态说明清单） */
const LOOPBACK_TOOLS: Array<[string, string]> = [
  ['conversations_list', '列出所有频道对话和会话'],
  ['conversation_get', '获取指定对话详情'],
  ['messages_read', '读取对话消息'],
  ['messages_send', '发送消息到对话'],
  ['events_poll', '轮询事件'],
  ['events_wait', '等待事件'],
  ['permissions_list_open', '列出待审批项'],
  ['permissions_respond', '响应审批请求'],
];

function LoopbackTab() {
  useWorkbenchLanguage();
  const [st, setSt] = useState<LoopbackStatus>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // 裸对象响应（无 success 包装），raw 跳过解包
      const res = await apiClient.get<LoopbackStatus>('/mcp/loopback/status', { raw: true });
      setSt(res ?? {});
    } catch {
      setSt({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await apiClient.post('/mcp/loopback/start', { port: 0 }, { raw: true });
      await load();
    } catch (e) {
      toast.error(wt('启动失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await apiClient.post('/mcp/loopback/stop', undefined, { raw: true });
      await load();
    } catch (e) {
      toast.error(wt('停止失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(st.config ?? {}, null, 2));
      toast.success(wt('配置已复制到剪贴板'));
    } catch {
      toast.error(wt('复制失败'));
    }
  };

  if (loading) {
    return (
      <div className="card p-8 text-center text-gray-400">
        <span className="spinner inline-block" />
        <p className="mt-2 text-sm">{wt('加载中…')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="card p-4 mb-4">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="mcp" size={16} /> {wt('MCP Loopback 服务器')}
        </h3>
        <p className="text-xs text-gray-400 mb-3">
          {wt(
            'MCP Loopback 允许外部 MCP 客户端（如 Claude Desktop、Cursor 等）通过 HTTP 连接到 SkyalyticWing，访问频道对话、工具和资源。',
          )}
        </p>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('状态')}</div>
            <div className={`text-lg font-bold ${st.running ? 'text-green-400' : 'text-gray-400'}`}>
              {st.running ? wt('运行中') : wt('已停止')}
            </div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('端口')}</div>
            <div className="text-lg font-bold text-blue-400">{st.port || '-'}</div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">Token</div>
            <div className="text-sm font-mono text-purple-400 truncate">{st.token || '-'}</div>
          </div>
        </div>
        <div className="flex gap-2 mb-4">
          {st.running ? (
            <button
              className="text-sm px-3 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
              onClick={stop}
              disabled={busy}
            >
              {wt('停止 Loopback')}
            </button>
          ) : (
            <button className="btn-primary text-sm" onClick={start} disabled={busy}>
              {wt('启动 Loopback')}
            </button>
          )}
          <button
            className="text-sm px-3 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
            onClick={load}
          >
            {wt('刷新状态')}
          </button>
        </div>
        {st.running ? (
          <>
            <div className="bg-gray-800/50 rounded p-3 mb-4">
              <div className="text-xs text-gray-500 mb-1">Loopback URL</div>
              <div className="font-mono text-sm text-cyan-400 select-all">{st.url || ''}</div>
            </div>
            <div className="bg-gray-800/50 rounded p-3 mb-4">
              <div className="text-xs text-gray-500 mb-2">{wt('Claude Desktop 配置')}</div>
              <pre className="text-xs text-green-400 bg-gray-900 rounded p-2 overflow-x-auto select-all">
                {JSON.stringify(st.config ?? {}, null, 2)}
              </pre>
              <button
                className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 mt-2"
                onClick={() => void copyConfig()}
              >
                {wt('复制配置')}
              </button>
            </div>
          </>
        ) : null}
      </div>
      <div className="card p-4">
        <h3 className="text-sm font-medium mb-2">{wt('频道桥接工具')}</h3>
        <p className="text-xs text-gray-400 mb-3">
          {wt('Loopback 服务器暴露以下工具供外部 MCP 客户端使用：')}
        </p>
        <div className="space-y-1">
          {LOOPBACK_TOOLS.map(([name, desc]) => (
            <div key={name} className="text-xs bg-gray-800/50 rounded px-2 py-1">
              <span className="text-yellow-400">{name}</span>
              <span className="text-gray-500"> - {wt(desc)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── ACP 协议 ───────────────────────── */

/** GET /acp/status 返回（裸对象） */
interface AcpStatus {
  enabled?: boolean;
  activeSessions?: number;
  totalSessions?: number;
  sseClients?: number;
  config?: {
    autoApproveReadonly?: boolean;
    allowedAgents?: string[];
    [k: string]: unknown;
  };
}

/** GET /acp/sessions 条目（兼容旧版字段） */
interface AcpSessionItem {
  sessionId?: string;
  id?: string;
  agentId?: string;
  status?: string;
}

function AcpTab() {
  useWorkbenchLanguage();
  const [st, setSt] = useState<AcpStatus>({});
  const [sessions, setSessions] = useState<AcpSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowedAgents, setAllowedAgents] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // /acp/status 与 /acp/sessions 均为裸对象响应（非 ApiResponse 包装）
      const [statusRes, sessionsRes] = await Promise.allSettled([
        apiClient.get<AcpStatus>('/acp/status', { raw: true }),
        apiClient.get<{ sessions?: AcpSessionItem[] }>('/acp/sessions', { raw: true }),
      ]);
      if (statusRes.status === 'fulfilled') {
        setSt(statusRes.value ?? {});
        setAllowedAgents(((statusRes.value?.config?.allowedAgents ?? []) as string[]).join(','));
      }
      if (sessionsRes.status === 'fulfilled') {
        setSessions(sessionsRes.value?.sessions ?? []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /** 更新 ACP 配置：PUT /acp（部分字段） */
  const updateConfig = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await apiClient.put('/acp', patch, { raw: true });
      await load();
    } catch (e) {
      toast.error(wt('配置更新失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const saveAllowedAgents = () => {
    const list = allowedAgents
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void updateConfig({ allowedAgents: list });
  };

  const closeSession = async (sessionId: string) => {
    if (!(await showConfirm(wt('确定关闭 ACP 会话 {{v0}}？', { v0: sessionId })))) return;
    try {
      // DELETE /acp/sessions 需 body 传 sessionId，apiClient.delete 不支持 body，
      // 走旧版统一入口 POST /acp/request（method=closeSession）
      await apiClient.post(
        '/acp/request',
        { method: 'closeSession', params: { sessionId } },
        { raw: true },
      );
      await load();
    } catch (e) {
      toast.error(wt('关闭会话失败'), e instanceof Error ? e.message : undefined);
    }
  };

  if (loading) {
    return (
      <div className="card p-8 text-center text-gray-400">
        <span className="spinner inline-block" />
        <p className="mt-2 text-sm">{wt('加载中…')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="card p-4 mb-4">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="zap" size={16} /> ACP (Agent Communication Protocol)
        </h3>
        <p className="text-xs text-gray-400 mb-3">
          {wt(
            'ACP 协议允许 IDE 和其他工具通过标准协议与 Agent 通信，支持会话管理、流式响应和审批分类。',
          )}
        </p>
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('启用状态')}</div>
            <div className={`text-lg font-bold ${st.enabled ? 'text-green-400' : 'text-gray-400'}`}>
              {st.enabled ? wt('已启用') : wt('已禁用')}
            </div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('活跃会话')}</div>
            <div className="text-lg font-bold text-yellow-400">{st.activeSessions ?? 0}</div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('总会话数')}</div>
            <div className="text-lg font-bold text-blue-400">{st.totalSessions ?? 0}</div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('SSE客户端')}</div>
            <div className="text-lg font-bold text-purple-400">{st.sseClients ?? 0}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm">{wt('启用ACP:')}</span>
          <button
            className={`text-xs px-3 py-1 rounded ${st.enabled ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            onClick={() => void updateConfig({ enabled: !st.enabled })}
            disabled={busy}
          >
            {st.enabled ? wt('已启用') : wt('已禁用')}
          </button>
          <span className="text-sm ml-4">{wt('自动批准只读:')}</span>
          <button
            className={`text-xs px-3 py-1 rounded ${st.config?.autoApproveReadonly ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            onClick={() =>
              void updateConfig({ autoApproveReadonly: !st.config?.autoApproveReadonly })
            }
            disabled={busy}
          >
            {st.config?.autoApproveReadonly ? wt('已启用') : wt('已禁用')}
          </button>
        </div>
        <div className="mb-3">
          <label className="text-xs text-gray-500">{wt('允许的Agent (逗号分隔)')}</label>
          <input
            type="text"
            className="input-field w-full text-sm mt-1"
            value={allowedAgents}
            onChange={(e) => setAllowedAgents(e.target.value)}
            placeholder={wt('如 main,code_expert（留空表示全部允许）')}
          />
        </div>
        <button className="btn-primary text-sm" onClick={saveAllowedAgents} disabled={busy}>
          {wt('保存配置')}
        </button>
      </div>
      {sessions.length > 0 ? (
        <div className="card p-4">
          <h3 className="text-sm font-medium mb-2">{wt('ACP会话列表')}</h3>
          <div className="space-y-1">
            {sessions.slice(0, 20).map((s, i) => {
              const sid = s.sessionId || s.id || '?';
              return (
                <div
                  key={sid + i}
                  className="flex items-center justify-between bg-gray-800/50 rounded px-2 py-1"
                >
                  <div className="text-xs">
                    <span className="text-yellow-400">{sid}</span>
                    <span className="text-gray-500 ml-2">{s.agentId || ''}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs ${s.status === 'active' ? 'text-green-400' : 'text-gray-400'}`}
                    >
                      {s.status || ''}
                    </span>
                    <button className="text-xs text-red-400" onClick={() => void closeSession(sid)}>
                      {wt('关闭')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
