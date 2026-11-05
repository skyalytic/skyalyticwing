import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 记忆系统页面
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';

interface MemoryEntry {
  id: string;
  title: string;
  content?: string;
  summary?: string;
  timestamp?: number | string;
  tags?: string[];
  type?: string;
}

function formatTime(ts?: number | string): string {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(workbenchLocale());
  } catch {
    return String(ts);
  }
}

function summaryOf(entry: MemoryEntry): string {
  if (entry.summary) return entry.summary;
  if (entry.content)
    return entry.content.length > 120 ? entry.content.slice(0, 120) + '…' : entry.content;
  return wt('暂无内容');
}

export function MemoryPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', tags: '' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // 后端无 GET /memory 根路由，知识库列表走 GET /memory/knowledge
      const res = await authenticatedFetch('/api/memory/knowledge');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw: MemoryEntry[] = Array.isArray(json)
        ? json
        : json.data?.knowledge || json.knowledge || json.entries || json.memories || [];
      const list: MemoryEntry[] = raw.map((k) => ({
        ...k,
        timestamp: k.timestamp ?? (k as { createdAt?: number }).createdAt,
      }));
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('加载记忆失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const hay = [e.title, e.content, e.summary, (e.tags || []).join(' '), e.type]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [entries, query]);

  const submit = async () => {
    if (!form.title.trim()) {
      alert(wt('请填写记忆标题'));
      return;
    }
    setSubmitting(true);
    try {
      const tags = form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      // 后端写入知识走 POST /memory/knowledge（body: {title, content, tags}）
      const res = await authenticatedFetch('/api/memory/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title, content: form.content, tags }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setModalOpen(false);
      setForm({ title: '', content: '', tags: '' });
      load();
    } catch (e) {
      alert(wt('添加失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    } finally {
      setSubmitting(false);
    }
  };

  // 删除走 DELETE /memory/knowledge/:id
  const remove = async (id: string) => {
    if (!(await showConfirm(wt('确定删除这条记忆吗？删除后不可恢复。')))) return;
    try {
      const res = await authenticatedFetch(`/api/memory/knowledge/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      alert(wt('删除失败: ') + (e instanceof Error ? e.message : wt('未知错误')));
    }
  };

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="moon" size={20} /> {t('views.memorySystem')}
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
              setForm({ title: '', content: '', tags: '' });
              setModalOpen(true);
            }}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={14} /> {wt('添加记忆')}
            </span>
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <div className="flex-1 relative">
          <span
            className="absolute"
            style={{ left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}
          >
            <Icon name="search" size={16} />
          </span>
          <input
            className="input-field text-sm w-full"
            style={{ paddingLeft: 32 }}
            placeholder={wt('搜索记忆标题、内容或标签…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-3 opacity-30">
            <Icon name="moon" size={48} />
          </div>
          <p className="text-gray-400">
            {entries.length === 0 ? wt('暂无记忆条目') : wt('未匹配到任何记忆')}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {entries.length === 0 ? wt('点击"添加记忆"创建第一条记忆') : wt('尝试更换搜索关键词')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <div className="card p-3" key={e.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-medium text-primary truncate">{e.title}</h3>
                    {e.type ? <span className="badge badge-blue text-xs">{e.type}</span> : null}
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">{summaryOf(e)}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {(e.tags || []).map((t) => (
                      <span key={t} className="badge badge-gray text-xs">
                        {t}
                      </span>
                    ))}
                    {e.timestamp ? (
                      <span className="text-xs text-gray-500">{formatTime(e.timestamp)}</span>
                    ) : null}
                  </div>
                </div>
                <button
                  className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60 shrink-0"
                  onClick={() => remove(e.id)}
                  title={wt('删除该条记忆')}
                >
                  {wt('删除')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen ? (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="moon" size={18} /> {wt('添加记忆')}
              </h2>
              <button className="modal-close" onClick={() => setModalOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="form-label">{wt('标题')}</label>
                <input
                  className="form-input"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={wt('记忆标题')}
                />
              </div>
              <div>
                <label className="form-label">{wt('内容')}</label>
                <textarea
                  className="form-input resize-none"
                  rows={5}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder={wt('详细内容')}
                />
              </div>
              <div>
                <label className="form-label">{wt('标签（逗号分隔）')}</label>
                <input
                  className="form-input"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder={wt('例如: 重要,偏好,项目')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setModalOpen(false)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? wt('保存中…') : wt('保存')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
