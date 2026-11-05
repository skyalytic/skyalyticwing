import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { apiClient } from '@/services/api-client';
interface McpServer {
  id: string;
  name: string;
  url?: string;
  address?: string;
  transport?: string;
  status?: string;
  tools?: Array<{ name: string; description?: string }> | string[];
}

interface ServerForm {
  name: string;
  url: string;
  transport: string;
}

function statusBadgeClass(status?: string): string {
  if (status === 'running' || status === 'connected' || status === 'online')
    return 'badge badge-green';
  if (status === 'error') return 'badge badge-red';
  if (status === 'connecting') return 'badge badge-yellow';
  return 'badge badge-gray';
}

function serverAddress(s: McpServer): string {
  if (s.address) return s.address;
  return s.url || '-';
}

function toolCount(s: McpServer): number {
  return s.tools ? s.tools.length : 0;
}

export function McpConnections() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toolsServer, setToolsServer] = useState<McpServer | null>(null);
  const [form, setForm] = useState<ServerForm>({ name: '', url: '', transport: 'stdio' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // 后端 GET /mcp/servers 为 ApiResponse 包装，apiClient 自动解包出 data（McpServerInfo[]）
      const res = await apiClient.get<McpServer[] | { servers?: McpServer[] }>('/mcp/servers');
      const list: McpServer[] = Array.isArray(res) ? res : res?.servers || [];
      setServers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    if (!form.name.trim()) {
      toast.warn(t('views.mcpNameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      // 后端失败时 HTTP 仍 2xx + success:false，apiClient 解包时抛 ApiError（含 error 信息）
      await apiClient.post('/mcp/servers', {
        name: form.name,
        url: form.url,
        transport: form.transport,
      });
      setModalOpen(false);
      setForm({ name: '', url: '', transport: 'stdio' });
      load();
    } catch (e) {
      toast.error(t('common.addFailed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (s: McpServer) => {
    const connected = s.status === 'running' || s.status === 'connected' || s.status === 'online';
    setBusyId(s.id);
    try {
      // 失败时后端返回 success:false + 2xx，apiClient 抛错走 toast
      await apiClient.post(
        connected
          ? `/mcp/servers/${encodeURIComponent(s.id)}/stop`
          : `/mcp/servers/${encodeURIComponent(s.id)}/start`,
      );
      load();
    } catch (e) {
      toast.error(t('common.operationFailed'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!(await showConfirm(t('views.confirmRemoveMcpServer')))) return;
    setBusyId(id);
    try {
      await apiClient.delete(`/mcp/servers/${encodeURIComponent(id)}`);
      load();
    } catch (e) {
      toast.error(t('common.removeFailed'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const runningCount = servers.filter(
    (s) => s.status === 'running' || s.status === 'connected' || s.status === 'online',
  ).length;
  const totalTools = servers.reduce((sum, s) => sum + toolCount(s), 0);

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="zap" size={20} /> {wt('MCP 连接')}
        </h2>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm" onClick={load}>
            <span className="inline-flex items-center gap-1">
              <Icon name="refresh" size={14} /> {t('common.refresh')}
            </span>
          </button>
          <button
            className="btn-primary text-sm"
            onClick={() => {
              setForm({ name: '', url: '', transport: 'stdio' });
              setModalOpen(true);
            }}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {t('views.addServer')}
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{t('views.serverCount')}</div>
          <div className="text-lg font-bold text-yellow-400">{servers.length}</div>
        </div>
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{t('views.runningCount')}</div>
          <div className="text-lg font-bold text-green-400">{runningCount}</div>
        </div>
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{t('views.totalToolsCount')}</div>
          <div className="text-lg font-bold text-blue-400">{totalTools}</div>
        </div>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-gray-400">
          <span className="spinner inline-block" />
          <p className="mt-2 text-sm">{t('common.loading')}</p>
        </div>
      ) : error ? (
        <div className="card p-8 text-center text-red-400">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Icon name="alert" size={20} />
            <span>{t('common.loadFailed')}</span>
          </div>
          <p className="text-sm text-gray-500">{error}</p>
          <button className="btn-secondary text-sm mt-3" onClick={load}>
            {t('common.retry')}
          </button>
        </div>
      ) : servers.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-3 opacity-30">
            <Icon name="mcp" size={48} />
          </div>
          <p className="text-gray-400">{t('views.noServers')}</p>
          <p className="text-xs text-gray-500 mt-1">{t('views.noServersHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => {
            const connected =
              s.status === 'running' || s.status === 'connected' || s.status === 'online';
            return (
              <div className="card p-3" key={s.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon name="mcp" size={16} />
                      <span className="text-sm font-medium text-yellow-400 truncate">{s.name}</span>
                      <span className={statusBadgeClass(s.status)}>{s.status || 'unknown'}</span>
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-3">
                      <span className="truncate">{serverAddress(s)}</span>
                      {s.transport ? (
                        <span>
                          {t('views.transportLabel')}: {s.transport}
                        </span>
                      ) : null}
                      <span>{t('views.toolCountLabel', { count: toolCount(s) })}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      className="text-xs text-blue-400 hover:underline"
                      onClick={() => setToolsServer(s)}
                    >
                      {t('views.viewTools')}
                    </button>
                    <button
                      className={
                        connected
                          ? 'text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60'
                          : 'text-xs px-2 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/60'
                      }
                      onClick={() => toggle(s)}
                      disabled={busyId === s.id}
                    >
                      {connected ? t('common.disconnect') : t('common.connect')}
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                      onClick={() => remove(s.id)}
                      disabled={busyId === s.id}
                    >
                      {t('common.remove')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen ? (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="mcp" size={18} /> {t('views.addMcpServer')}
              </h2>
              <button className="modal-close" onClick={() => setModalOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="form-label">{t('views.serverNameLabel')}</label>
                <input
                  className="form-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('views.serverNamePlaceholder')}
                />
              </div>
              <div>
                <label className="form-label">{t('views.serverAddressLabel')}</label>
                <input
                  className="form-input font-mono"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder={t('views.serverAddressPlaceholder')}
                />
              </div>
              <div>
                <label className="form-label">{t('views.transportModeLabel')}</label>
                <select
                  className="form-input"
                  value={form.transport}
                  onChange={(e) => setForm({ ...form, transport: e.target.value })}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setModalOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? t('common.adding') : t('common.add')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toolsServer ? (
        <div className="modal-overlay" onClick={() => setToolsServer(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="tool" size={18} />{' '}
                {t('views.toolListTitle', { name: toolsServer.name })}
              </h2>
              <button className="modal-close" onClick={() => setToolsServer(null)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            {toolCount(toolsServer) === 0 ? (
              <div className="text-center text-gray-500 py-6">{t('views.noToolsAvailable')}</div>
            ) : (
              <div className="space-y-1">
                {(toolsServer.tools || []).map((tool, i) => {
                  const name = typeof tool === 'string' ? tool : tool.name;
                  const desc = typeof tool === 'string' ? '' : tool.description;
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 bg-gray-800/50 rounded px-2 py-1"
                    >
                      <Icon name="tool" size={12} />
                      <span className="text-xs text-yellow-400 font-mono">{name}</span>
                      {desc ? (
                        <span className="text-xs text-gray-500 truncate">- {desc}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex justify-end mt-4">
              <button className="btn-secondary" onClick={() => setToolsServer(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
