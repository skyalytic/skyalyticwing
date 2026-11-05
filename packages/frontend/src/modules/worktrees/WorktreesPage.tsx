import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 工作树页面
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';

interface Worktree {
  id: string;
  path?: string;
  branch: string;
  status?: string;
  task?: string;
}

interface WorktreesData {
  systemWorktrees?: Worktree[];
  worktrees?: Worktree[];
  baseRepo?: string;
  warning?: string;
}

function statusBadgeClass(status?: string): string {
  if (!status) return 'badge badge-gray';
  if (status === 'active' || status === 'ready' || status === 'clean') return 'badge badge-green';
  if (status === 'dirty' || status === 'error') return 'badge badge-yellow';
  return 'badge badge-gray';
}

export function WorktreesPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [data, setData] = useState<WorktreesData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ path: '', branch: '' });

  const list = data.systemWorktrees || data.worktrees || [];
  const hasGit = !!data.baseRepo && data.baseRepo !== 'not-detected' && data.baseRepo !== '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/worktrees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // 后端响应为 {success, data} 包裹，解包取 data
      setData((json?.data ?? json) as WorktreesData);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('加载工作树失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const initGit = async () => {
    setSubmitting(true);
    try {
      const res = await authenticatedFetch('/api/worktrees/init-git', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('初始化失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setSubmitting(false);
    }
  };

  // 创建工作树走 POST /worktrees（body: {path, branch}，path 需在允许目录内）
  const submitCreate = async () => {
    if (!createForm.path.trim() || !createForm.branch.trim()) {
      alert(wt('请填写工作树路径和分支'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await authenticatedFetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: createForm.path, branch: createForm.branch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCreateOpen(false);
      setCreateForm({ path: '', branch: '' });
      load();
    } catch (e) {
      alert(wt('创建失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    if (!(await showConfirm(wt('确定删除此工作树吗？未提交的更改可能丢失！')))) return;
    setBusyId(id);
    try {
      // 后端移除走 POST /worktrees/remove（body: {worktreeId}）
      const res = await authenticatedFetch('/api/worktrees/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('删除失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setBusyId(null);
    }
  };

  const viewDiff = async (id: string) => {
    setBusyId(id);
    try {
      const res = await authenticatedFetch(`/api/worktrees/${encodeURIComponent(id)}/diff`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      alert(json?.data?.diff ?? json.diff ?? wt('无变更'));
    } catch (e) {
      alert(wt('获取 diff 失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="worktree" size={20} /> {wt('Git 工作树')}
        </h2>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm" onClick={load}>
            <span className="inline-flex items-center gap-1">
              <Icon name="refresh" size={14} /> {wt('刷新')}
            </span>
          </button>
          {hasGit ? (
            <button
              className="btn-primary text-sm"
              onClick={() => {
                setCreateForm({ path: '', branch: '' });
                setCreateOpen(true);
              }}
            >
              <span className="inline-flex items-center gap-1">
                <Icon name="plus" size={14} /> {wt('创建工作树')}
              </span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="bg-blue-900/20 border border-blue-700 rounded p-3 mb-4 text-xs text-blue-300">
        <strong>{wt('使用流程：')}</strong>
        {!hasGit ? wt('①初始化Git仓库 → ') : ''}
        {wt('②创建/查看Worktree列表 → ③在Worktree中执行命令 → ④查看Diff(变更) → ⑤删除Worktree')}
      </div>

      {data.warning ? (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded p-3 mb-3 text-sm text-yellow-300">
          {data.warning}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('活跃工作树数')}</div>
          <div className="text-2xl font-bold">{list.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('基础仓库路径')}</div>
          <div className="text-xs truncate font-mono" title={data.baseRepo || ''}>
            {data.baseRepo ? (
              data.baseRepo.replace(/\\/g, '/')
            ) : (
              <span className="text-red-400">{wt('未检测到')}</span>
            )}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-400">{wt('Git 状态')}</div>
          <div className="mt-1">
            <span className={hasGit ? 'badge badge-green' : 'badge badge-red'}>
              {hasGit ? wt('Git 就绪') : wt('非 Git 目录')}
            </span>
          </div>
        </div>
      </div>

      {!hasGit ? (
        <button className="btn-primary text-sm mb-4" onClick={initGit} disabled={submitting}>
          <span className="inline-flex items-center gap-1">
            <Icon name="zap" size={14} /> {submitting ? wt('初始化中…') : wt('初始化 Git 仓库')}
          </span>
        </button>
      ) : null}

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
      ) : list.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-3 opacity-30">
            <Icon name="worktree" size={48} />
          </div>
          <p className="text-gray-400">{wt('暂无活跃的工作树')}</p>
          <p className="text-xs text-gray-500 mt-1">
            {hasGit ? wt('点击"创建工作树"新增工作树') : wt('请先初始化 Git 仓库')}
          </p>
        </div>
      ) : (
        <div className="card p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-2">ID</th>
                <th className="text-left py-2">{wt('路径')}</th>
                <th className="text-left py-2">{wt('分支')}</th>
                <th className="text-left py-2">{wt('状态')}</th>
                <th className="text-right py-2">{wt('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="py-2 font-mono text-xs text-blue-400">{w.id}</td>
                  <td className="text-xs text-gray-400 truncate max-w-xs" title={w.path || ''}>
                    {w.path ? w.path.replace(/\\/g, '/') : '-'}
                  </td>
                  <td>
                    <code className="text-green-400">{w.branch}</code>
                  </td>
                  <td>
                    <span className={statusBadgeClass(w.status)}>{w.status || '-'}</span>
                  </td>
                  <td className="text-right">
                    <button
                      className="btn-secondary text-xs py-0.5 px-1.5 mr-1"
                      onClick={() => viewDiff(w.id)}
                      disabled={busyId === w.id}
                    >
                      Diff
                    </button>
                    <button
                      className="text-xs py-0.5 px-1.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                      onClick={() => remove(w.id)}
                      disabled={busyId === w.id}
                    >
                      {wt('删除')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <div className="modal-overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="worktree" size={18} /> {wt('创建工作树')}
              </h2>
              <button className="modal-close" onClick={() => setCreateOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="form-label">{wt('工作树路径')}</label>
                <input
                  className="form-input font-mono"
                  value={createForm.path}
                  onChange={(e) => setCreateForm({ ...createForm, path: e.target.value })}
                  placeholder={wt('例如: ./wt-feature-x（需位于允许的目录内）')}
                />
              </div>
              <div>
                <label className="form-label">{wt('分支名')}</label>
                <input
                  className="form-input font-mono"
                  value={createForm.branch}
                  onChange={(e) => setCreateForm({ ...createForm, branch: e.target.value })}
                  placeholder={wt('已存在的分支名')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setCreateOpen(false)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" onClick={submitCreate} disabled={submitting}>
                {submitting ? wt('创建中…') : wt('创建')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
