import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 远程节点页面
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';

interface RemoteNode {
  id: string;
  name: string;
  host?: string;
  address?: string;
  port?: number;
  status?: string;
  latency?: number;
  tasksCompleted?: number;
}

interface NodeForm {
  name: string;
  host: string;
  port: string;
}

function statusBadgeClass(status?: string): string {
  if (status === 'active' || status === 'online' || status === 'connected')
    return 'badge badge-green';
  if (status === 'offline' || status === 'disconnected') return 'badge badge-red';
  if (status === 'connecting') return 'badge badge-yellow';
  return 'badge badge-gray';
}

function nodeAddress(n: RemoteNode): string {
  if (n.address) return n.address;
  if (n.host) return n.port ? `${n.host}:${n.port}` : n.host;
  return '-';
}

export function RemoteNodesPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<RemoteNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<NodeForm>({ name: '', host: 'localhost', port: '3001' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/remote/nodes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: RemoteNode[] = Array.isArray(json) ? json : json.nodes || json.data || [];
      setNodes(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('加载节点失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    if (!form.name.trim()) {
      alert(wt('请填写节点名称'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await authenticatedFetch('/api/remote/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          host: form.host,
          port: parseInt(form.port) || 3001,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setModalOpen(false);
      setForm({ name: '', host: 'localhost', port: '3001' });
      load();
    } catch (e) {
      alert(wt('添加失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setSubmitting(false);
    }
  };

  // 连接/断开走 POST /remote/connect、POST /remote/disconnect（body: {nodeId}）
  const connect = async (id: string) => {
    setBusyId(id);
    try {
      const res = await authenticatedFetch('/api/remote/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('连接失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (id: string) => {
    setBusyId(id);
    try {
      const res = await authenticatedFetch('/api/remote/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('断开失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!(await showConfirm(wt('确定要移除该远程节点吗？')))) return;
    setBusyId(id);
    try {
      // 后端移除走 POST /remote/remove（body: {nodeId}）
      const res = await authenticatedFetch('/api/remote/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('移除失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = nodes.filter(
    (n) => n.status === 'active' || n.status === 'online' || n.status === 'connected',
  ).length;

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="remote" size={20} /> {wt('远程节点')}
        </h2>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm" onClick={load}>
            <span className="inline-flex items-center gap-1">
              <Icon name="refresh" size={14} /> {wt('刷新')}
            </span>
          </button>
          <button
            className="btn-primary text-sm"
            onClick={() => {
              setForm({ name: '', host: 'localhost', port: '3001' });
              setModalOpen(true);
            }}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {t('views.addNode')}
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('总节点数')}</div>
          <div className="text-2xl font-bold">{nodes.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('活跃节点')}</div>
          <div className="text-2xl font-bold text-green-400">{activeCount}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('最大容量')}</div>
          <div className="text-2xl font-bold">10</div>
        </div>
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
      ) : nodes.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-3 opacity-30">
            <Icon name="remote" size={48} />
          </div>
          <p className="text-gray-400">{wt('暂无远程节点')}</p>
          <p className="text-xs text-gray-500 mt-1">{wt('点击"添加节点"注册新的远程节点')}</p>
        </div>
      ) : (
        <div className="card p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th>{wt('节点名')}</th>
                <th>{wt('地址')}</th>
                <th>{wt('状态')}</th>
                <th>{wt('延迟')}</th>
                <th>{wt('任务完成')}</th>
                <th className="text-right">{wt('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const connected =
                  n.status === 'active' || n.status === 'online' || n.status === 'connected';
                return (
                  <tr key={n.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-2">
                      <div className="text-primary">{n.name}</div>
                      <div className="text-xs text-gray-500 font-mono">{n.id}</div>
                    </td>
                    <td className="font-mono text-xs">{nodeAddress(n)}</td>
                    <td>
                      <span className={statusBadgeClass(n.status)}>{n.status || 'unknown'}</span>
                    </td>
                    <td className="text-xs">{n.latency !== undefined ? `${n.latency} ms` : '-'}</td>
                    <td className="text-xs">{n.tasksCompleted || 0}</td>
                    <td className="text-right">
                      {connected ? (
                        <button
                          className="btn-secondary text-xs py-0.5 px-1.5 mr-1"
                          onClick={() => disconnect(n.id)}
                          disabled={busyId === n.id}
                        >
                          {wt('断开')}
                        </button>
                      ) : (
                        <button
                          className="btn-secondary text-xs py-0.5 px-1.5 mr-1"
                          onClick={() => connect(n.id)}
                          disabled={busyId === n.id}
                        >
                          {wt('连接')}
                        </button>
                      )}
                      <button
                        className="text-xs py-0.5 px-2 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                        onClick={() => remove(n.id)}
                        disabled={busyId === n.id}
                      >
                        {wt('移除')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen ? (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="remote" size={18} /> {wt('添加远程节点')}
              </h2>
              <button className="modal-close" onClick={() => setModalOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="form-label">{wt('节点名称')}</label>
                <input
                  className="form-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={wt('例如: RemoteAgent-1')}
                />
              </div>
              <div>
                <label className="form-label">{wt('主机地址')}</label>
                <input
                  className="form-input font-mono"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder={wt('localhost 或 IP')}
                />
              </div>
              <div>
                <label className="form-label">{wt('端口')}</label>
                <input
                  className="form-input font-mono"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder={wt('端口号')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setModalOpen(false)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? wt('添加中…') : wt('添加')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
