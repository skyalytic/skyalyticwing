import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../Icon';
import { apiClient } from '@/services/api-client';
import { useSessionStore } from '@/stores/session-store';
import { showConfirm } from '../modals/ConfirmDialog';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import type { SessionInfo } from '@/types';

type Project = { path: string; name: string };
type SearchHit = { sessionId: string; title: string; snippet?: string };
const title = (s: { title: string }) => (s.title === 'New chat' ? wt('新会话') : s.title);

export function ProjectChatSidebar({ onClose }: { onClose: () => void }) {
  useWorkbenchLanguage();
  const store = useSessionStore();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('wing-projects-collapsed') || '[]');
      return Array.isArray(saved) ? saved.filter((path): path is string => typeof path === 'string') : [];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false),
    [error, setError] = useState('');
  const [archived, setArchived] = useState(false),
    [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    kind: 'add' | 'chat' | 'project';
    id?: string;
    value: string;
  } | null>(null);
  const [recovery, setRecovery] = useState<{ archiveDirectory: string } | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const loadProjects = useCallback(async () => {
    try {
      const next = await apiClient.get<unknown>('/files/projects');
      if (!Array.isArray(next) || !next.every(p => p && typeof p.path === 'string' && typeof p.name === 'string')) {
        throw new Error(wt('项目列表格式异常，请重试'));
      }
      setProjects(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadProjects();
    apiClient
      .get<{ archiveDirectory: string } | null>('/sessions/recovery')
      .then(setRecovery)
      .catch(() => undefined);
    window.addEventListener('wing-projects-changed', loadProjects);
    return () => window.removeEventListener('wing-projects-changed', loadProjects);
  }, [loadProjects]);
  useEffect(() => {
    localStorage.setItem('wing-projects-collapsed', JSON.stringify(collapsed));
  }, [collapsed]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  useEffect(() => {
    let live = true;
    if (!query.trim()) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      apiClient
        .get<SearchHit[]>('/sessions/search?q=' + encodeURIComponent(query.trim()))
        .then((d) => {
          if (live) {
            setHits(d);
            setSearching(false);
          }
        })
        .catch((e) => {
          if (live) {
            setError(e.message);
            setSearching(false);
          }
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const open = (id: string) => {
    store.selectSession(id);
    navigate('/');
  };
  const create = async (path?: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    store.clearError();
    const id = await store.createSession(undefined, path);
    if (id) {
      setQuery('');
      if (path) setCollapsed((v) => v.filter((p) => p !== path));
      navigate('/');
    }
    setBusy(false);
  };
  const submit = async () => {
    if (!dialog?.value.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (dialog.kind === 'chat') {
        await store.renameSession(dialog.id!, dialog.value.trim());
        if (useSessionStore.getState().error) throw new Error(useSessionStore.getState().error!);
      } else {
        await apiClient.post('/files/projects', {
          path: dialog.kind === 'add' ? dialog.value.trim() : dialog.id,
          ...(dialog.kind === 'project' ? { name: dialog.value.trim() } : {}),
        });
        await loadProjects();
      }
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addProject = async () => {
    setError('');
    const native = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    if (native?.invoke) {
      try {
        const path = await native.invoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: wt('添加项目') },
        });
        if (typeof path === 'string') {
          await apiClient.post('/files/projects', { path });
          await loadProjects();
        }
      } catch (e) {
        setError((e as Error).message);
      }
    } else setDialog({ kind: 'add', value: '' });
  };
  const act = async (fn: () => Promise<void>) => {
    setMenu(null);
    store.clearError();
    await fn();
  };
  const deleteProject = async (project: Project) => {
    setMenu(null);
    if (busy || !(await showConfirm(wt('删除项目“{{name}}”？仅从项目列表移除，历史会话、磁盘文件夹和文件都会保留。', { name: project.name }), {
      title: wt('删除项目'), confirmText: wt('删除项目'),
    }))) return;
    setBusy(true);
    setError('');
    try {
      await apiClient.delete('/files/projects?path=' + encodeURIComponent(project.path));
      setCollapsed(v => v.filter(path => path !== project.path));
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const row = (s: SessionInfo, nested = false) => {
    const menuId = (nested ? 'project:' : 'recent:') + s.id;
    return (
      <div
        className={`sky-chat-row ${nested ? 'is-nested' : ''} ${s.id === store.currentSessionId ? 'is-current' : ''}`}
        key={s.id}
        onContextMenu={(e) => { e.preventDefault(); setMenu(menuId); }}
      >
        <button
          className="sky-chat-open"
          title={title(s)}
          onClick={() => open(s.id)}
          aria-current={s.id === store.currentSessionId ? 'page' : undefined}
        >
          {s.pinned && <Icon name="pin" size={12} />}
          <span>{title(s)}</span>
        </button>
        <div className="sky-chat-actions" ref={menu === menuId ? menuRoot : undefined}>
          <button
            className="sky-icon-button sky-row-more"
            aria-label={wt('会话操作') + ': ' + title(s)}
            aria-expanded={menu === menuId}
            onClick={() => setMenu(menu === menuId ? null : menuId)}
          >
            ···
          </button>
          {menu === menuId && (
            <div className="sky-row-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  store.clearError();
                  setMenu(null);
                  setDialog({ kind: 'chat', id: s.id, value: title(s) });
                }}
              >
                {wt('重命名')}
              </button>
              <button
                role="menuitem"
                onClick={() => void act(() => store.pinSession(s.id, !s.pinned))}
              >
                {s.pinned ? wt('取消置顶') : wt('置顶')}
              </button>
              <button
                role="menuitem"
                onClick={() => void act(() => store.archiveSession(s.id, !s.archived))}
              >
                {s.archived ? wt('取消归档') : wt('归档')}
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  void act(async () => {
                    if (await showConfirm(wt('删除此会话？项目文件不会被删除。')))
                      await store.deleteSession(s.id);
                  })
                }
              >
                {wt('删除会话')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };
  const active = store.sessions.filter((s) => !s.archived);
  const old = store.sessions.filter((s) => s.archived);
  return (
    <aside className="sky-project-sidebar" aria-label={wt('项目与聊天')}>
      <header>
        <strong>Wing</strong>
        <button
          className="sky-icon-button"
          title={wt('收起聊天栏')}
          aria-label={wt('收起聊天栏')}
          onClick={onClose}
        >
          <Icon name="arrow-left" size={17} />
        </button>
      </header>
      <button className="sky-new-chat" disabled={busy} onClick={() => void create()}>
        <Icon name="edit" size={17} />
        {wt('新会话')}
        <span>＋</span>
      </button>
      <div className="sky-project-search">
        <Icon name="search" size={15} />
        <input
          aria-label={wt('搜索会话')}
          placeholder={wt('搜索项目与聊天')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label={wt('清除')}>
            ×
          </button>
        )}
      </div>
      {(error || store.error) && (
        <p role="alert" className="sky-sidebar-error">
          {error || store.error}
          <button
            onClick={() => {
              setError('');
              store.clearError();
              void loadProjects();
              void store.loadSessions();
            }}
          >
            {wt('重试')}
          </button>
        </p>
      )}
      {recovery && (
        <details className="sky-sidebar-recovery">
          <summary>{wt('历史会话文件需要恢复')}</summary>
          <p>{wt('原始文件已完整保留，新会话可以正常使用。备份位置：')}</p>
          <code>{recovery.archiveDirectory}</code>
        </details>
      )}
      <div className="sky-project-scroll">
        <div className="sky-section-heading">
          <span>{wt('项目')}</span>
          <button
            className="sky-icon-button"
            onClick={() => void addProject()}
            aria-label={wt('添加项目')}
            title={wt('添加项目')}
          >
            ＋
          </button>
        </div>
        {projects
          .filter((p) => !query || (p.name + p.path).toLowerCase().includes(query.toLowerCase()))
          .map((p) => {
            const children = active.filter((s) => s.projectDir === p.path);
            const projectMenuId = 'folder:' + p.path;
            return (
              <section className="sky-project-group" key={p.path}>
                <div className="sky-project-row" onContextMenu={(e) => { e.preventDefault(); setMenu(projectMenuId); }}>
                  <button
                    className="sky-project-name"
                    aria-expanded={!collapsed.includes(p.path)}
                    title={p.path}
                    onClick={() =>
                      setCollapsed((v) =>
                        v.includes(p.path) ? v.filter((x) => x !== p.path) : [...v, p.path],
                      )
                    }
                  >
                    <Icon name="folder" size={17} />
                    <span>{p.name}</span>
                    <small>{children.length}</small>
                  </button>
                  <button
                    className="sky-icon-button"
                    disabled={busy}
                    aria-label={wt('在项目中新建会话') + ': ' + p.name}
                    title={wt('在项目中新建会话')}
                    onClick={() => void create(p.path)}
                  >
                    ＋
                  </button>
                  <div className="sky-chat-actions" ref={menu === projectMenuId ? menuRoot : undefined}>
                    <button
                      className="sky-icon-button sky-row-more"
                      disabled={busy}
                      aria-label={wt('项目操作') + ': ' + p.name}
                      title={wt('项目操作')}
                      aria-haspopup="menu"
                      aria-expanded={menu === projectMenuId}
                      onClick={() => setMenu(menu === projectMenuId ? null : projectMenuId)}
                    >···</button>
                    {menu === projectMenuId && <div className="sky-row-menu" role="menu" aria-label={wt('项目操作')}>
                      <button role="menuitem" onClick={() => { setMenu(null); setError(''); setDialog({ kind: 'project', id: p.path, value: p.name }); }}>{wt('重命名项目')}</button>
                      <button role="menuitem" className="is-danger" onClick={() => void deleteProject(p)}>{wt('删除项目')}</button>
                    </div>}
                  </div>
                </div>
                {!collapsed.includes(p.path) &&
                  (children.length ? (
                    children.map((s) => row(s, true))
                  ) : (
                    <button
                      className="sky-empty-project"
                      disabled={busy}
                      onClick={() => void create(p.path)}
                    >
                      {wt('暂无聊天，开始新会话')}
                    </button>
                  ))}
              </section>
            );
          })}
        {!projects.length && (
          <button className="sky-add-project" onClick={() => void addProject()}>
            <Icon name="folder" size={18} />
            <span>
              {wt('添加一个项目文件夹')}
              <small>{wt('围绕同一个项目，保留每次对话')}</small>
            </span>
          </button>
        )}
        <div className="sky-section-heading">
          <span>{query ? wt('搜索结果') : wt('最近')}</span>
          <small>{query ? '' : active.length}</small>
        </div>
        {query ? (
          searching ? (
            <p className="sky-empty-list">{wt('搜索中…')}</p>
          ) : hits?.length ? (
            hits.map((h) => (
              <button
                className="sky-search-hit"
                key={h.sessionId}
                onClick={() => {
                  setQuery('');
                  open(h.sessionId);
                }}
              >
                <span>{title(h)}</span>
                <small>{h.snippet}</small>
              </button>
            ))
          ) : (
            <p className="sky-empty-list">{wt('无匹配会话')}</p>
          )
        ) : active.length ? (
          [...active]
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
            .map((s) => row(s))
        ) : (
          <p className="sky-empty-list">{wt('你的聊天会显示在这里')}</p>
        )}
        {!!old.length && (
          <>
            <button
              className="sky-section-heading"
              aria-expanded={archived}
              onClick={() => setArchived((v) => !v)}
            >
              <span>{wt('已归档')}</span>
              <small>{old.length}</small>
            </button>
            {archived && old.map((s) => row(s))}
          </>
        )}
      </div>
      <footer>{wt('项目按文件夹分组 · 聊天可重命名')}</footer>
      {dialog && (
        <div className="sky-sidebar-dialog-backdrop" onClick={() => !busy && setDialog(null)}>
          <form
            className="sky-sidebar-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.kind === 'add' ? wt('添加项目') : dialog.kind === 'project' ? wt('重命名项目') : wt('重命名会话')}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) setDialog(null);
            }}
          >
            <h2>
              {dialog.kind === 'add'
                ? wt('添加项目')
                : dialog.kind === 'project'
                  ? wt('重命名项目')
                  : wt('重命名会话')}
            </h2>
            <p>
              {dialog.kind === 'add'
                ? wt('选择本机项目文件夹。添加项目不会移动文件，也不会更改当前会话。')
                : dialog.kind === 'project'
                  ? wt('仅修改侧栏显示名称，磁盘文件夹名称保持不变。')
                  : wt('手动命名后，不再自动覆盖聊天标题。')}
            </p>
            <label>
              {dialog.kind === 'add' ? wt('项目文件夹路径') : wt('名称')}
              <input
                autoFocus
                value={dialog.value}
                maxLength={dialog.kind === 'add' ? 1000 : dialog.kind === 'project' ? 80 : 120}
                onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                placeholder={dialog.kind === 'add' ? 'E:\\projects\\my-app' : ''}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="sky-dialog-buttons">
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" disabled={busy || !dialog.value.trim()}>
                {busy ? wt('保存中…') : wt('保存')}
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );
}
