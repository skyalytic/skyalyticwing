import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { registerPendingDraftCheck, prepareFileClose } from '../project/file-tab-lifecycle';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { OfficeEditor } from '../project/OfficeEditor';
export interface RemoteWorkspace {
  id: string;
  name: string;
  transport: 'ssh' | 'wsl' | 'docker';
  target: string;
  root: string;
  port?: number;
}
type BufferState = { content: string; original: string; revision: string | null };
const drafts = new Map<string, Record<string, BufferState>>();
registerPendingDraftCheck(() =>
  [...drafts.values()].some((files) => Object.values(files).some((b) => b.content !== b.original)),
);
window.addEventListener('beforeunload', (e) => {
  if (
    [...drafts.values()].some((files) => Object.values(files).some((b) => b.content !== b.original))
  ) {
    e.preventDefault();
    e.returnValue = '';
  }
});
export function RemoteWorkspacePicker({ close }: { close: () => void }) {
  useWorkbenchLanguage();
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  const [form, setForm] = useState({ name: '', transport: 'ssh', target: '', root: '', port: 22 });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiClient
      .get<{ workspaces: RemoteWorkspace[] }>('/remote-workspaces')
      .then((r) => setWorkspaces(r.workspaces))
      .catch((e) => setError(String(e.message || e)));
  }, []);
  const bind = async (id: string | null) => {
    let sessionId = useSessionStore.getState().currentSessionId;
    if (!sessionId) {
      const created = await useSessionStore.getState().createSession();
      if (!created) throw Error(wt('创建会话失败'));
      sessionId = created;
    }
    await apiClient.post('/remote-workspaces/bind', { sessionId, id });
    await useProjectPanel.getState().initProjectDir(true);
    useWorkspaceTabs.getState().openTab('editor');
    close();
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p-3 border-b space-y-2" aria-label={wt('SSH / WSL / Docker 工作区')}>
      <div className="flex justify-between">
        <strong>SSH / WSL / Docker</strong>
        <button onClick={close}>×</button>
      </div>
      {workspaces.map((w) => (
        <div key={w.id} className="flex gap-2 items-center">
          <button
            className="flex-1 text-left"
            disabled={busy}
            onClick={() => void action(() => bind(w.id))}
          >
            {w.name} · {w.transport} · {w.root}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await apiClient.delete('/remote-workspaces/' + w.id);
                setWorkspaces((v) => v.filter((i) => i.id !== w.id));
              })
            }
          >
            {wt('删除')}
          </button>
        </div>
      ))}
      <form
        className="grid grid-cols-2 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const workspace = await apiClient.post<RemoteWorkspace>('/remote-workspaces', {
              ...form,
              port: form.transport === 'ssh' ? form.port : undefined,
            });
            setWorkspaces((v) => [...v, workspace]);
            await bind(workspace.id);
          });
        }}
      >
        <input
          className="form-input"
          aria-label={wt('工作区名称')}
          placeholder={wt('名称')}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <select
          className="form-input"
          aria-label={wt('连接方式')}
          value={form.transport}
          onChange={(e) => setForm({ ...form, transport: e.target.value })}
        >
          <option value="ssh">SSH</option>
          <option value="wsl">WSL</option>
          <option value="docker">Docker</option>
        </select>
        <input
          className="form-input"
          aria-label={wt('远程目标')}
          placeholder={
            form.transport === 'ssh'
              ? wt('SSH 主机别名 / user@host')
              : form.transport === 'wsl'
                ? wt('WSL 发行版')
                : wt('Docker 容器名称 / ID')
          }
          required
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.target.value })}
        />
        <input
          className="form-input"
          aria-label={wt('远程项目路径')}
          placeholder="/home/user/project"
          required
          value={form.root}
          onChange={(e) => setForm({ ...form, root: e.target.value })}
        />
        {form.transport === 'ssh' && (
          <input
            className="form-input"
            aria-label={wt('SSH 端口')}
            type="number"
            min="1"
            max="65535"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
          />
        )}
        <button className="btn-primary" disabled={busy}>
          {busy ? wt('连接中…') : wt('连接')}
        </button>
        <button type="button" disabled={busy} onClick={() => void action(() => bind(null))}>
          {wt('解除绑定')}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
export function RemoteWorkspaceView({
  workspace,
  changes = false,
}: {
  workspace: RemoteWorkspace;
  changes?: boolean;
}) {
  useWorkbenchLanguage();
  const [directory, setDirectory] = useState(workspace.root),
    [entries, setEntries] = useState<any[]>([]),
    [offset, setOffset] = useState<number | null>(null);
  const [active, setActive] = useState(''),
    [buffers, setBuffers] = useState<Record<string, BufferState>>(
      () => drafts.get(workspace.id) || {},
    );
  const [newFile, setNewFile] = useState(''),
    [diff, setDiff] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ revision: string | null; head: string } | null>(null);
  useEffect(() => {
    if (!changes) drafts.set(workspace.id, buffers);
  }, [workspace.id, buffers, changes]);
  const generation = useRef(0),
    alive = useRef(true);
  const op = <T = any,>(name: string, args: Record<string, unknown> = {}) =>
    apiClient.post<T>('/remote-workspaces/' + workspace.id + '/operation', { op: name, args });
  const list = async (path = directory, from = 0) => {
    const request = ++generation.current;
    const result = await op(changes ? 'git-status' : 'list', changes ? {} : { path, offset: from });
    if (!alive.current || request !== generation.current) return;
    setEntries((old) => (from ? [...old, ...result.entries] : result.entries));
    setOffset(result.nextOffset ?? null);
    setDirectory(path);
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void action(() => list());
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [workspace.id, changes]);
  const read = async (path: string) => {
    if (!changes && path !== active && /\.(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/i.test(active))
      await prepareFileClose(JSON.stringify(['remote', workspace.id, active]));
    if (changes) {
      const r = await op('git-diff', { path });
      setDiff(r.stdout);
      setActive(path);
      setReview({ revision: r.revision, head: r.head });
      if (r.truncated) setError(wt('变更内容超出显示上限'));
      return;
    }
    if (/\.(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp|pdf)$/i.test(path)) {
      setActive(path);
      return;
    }
    if (!buffers[path] || buffers[path]!.content === buffers[path]!.original) {
      const r = await op('read', { path });
      setBuffers((v) => ({
        ...v,
        [path]: { content: r.content, original: r.content, revision: r.revision },
      }));
    }
    setActive(path);
  };
  const buffer = buffers[active];
  return (
    <section className="flex flex-col flex-1 min-h-0 p-2 gap-2" aria-label={wt('远程项目')}>
      <div className="flex gap-2 items-center flex-wrap">
        <span className="flex-1 truncate" title={workspace.target + ':' + workspace.root}>
          {workspace.name} · {workspace.transport}
        </span>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await apiClient.post('/remote-workspaces/' + workspace.id + '/connect', {});
              await list();
            })
          }
        >
          {wt('重新连接')}
        </button>
        <button disabled={busy} onClick={() => void action(() => list())}>
          {wt('刷新')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {!changes && (
        <div className="flex gap-2">
          <button
            disabled={busy || directory === workspace.root}
            onClick={() =>
              void action(() => list(directory.slice(0, directory.lastIndexOf('/')) || '/'))
            }
          >
            {wt('上级')}
          </button>
          <input
            className="form-input flex-1"
            aria-label={wt('新文件路径')}
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
            placeholder={wt('新文件路径')}
          />
          <button
            disabled={busy || !newFile.trim()}
            onClick={() => {
              const path = newFile.startsWith('/') ? newFile : directory + '/' + newFile;
              setBuffers((v) => ({
                ...v,
                [path]: v[path] || { content: '', original: '', revision: null },
              }));
              setActive(path);
              setNewFile('');
            }}
          >
            {wt('新建')}
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0 gap-2">
        <div className="w-1/3 overflow-auto border-r pr-2">
          {entries.map((e) => (
            <button
              disabled={busy}
              className="block text-left w-full truncate py-1"
              title={e.path}
              key={e.path}
              onClick={() => void action(() => (e.directory ? list(e.path) : read(e.path)))}
            >
              {e.directory ? '📁 ' : ''}
              {e.status ? e.status + ' ' : ''}
              {e.name || e.path}
            </button>
          ))}
          {offset !== null && (
            <button disabled={busy} onClick={() => void action(() => list(directory, offset))}>
              {wt('加载更多')}
            </button>
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="truncate" title={active}>
            {active}
          </div>
          {changes ? (
            <>
              <pre className="overflow-auto flex-1 whitespace-pre-wrap">{diff}</pre>
              {active && review && (
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await op('git-stage', { path: active, revision: review.revision });
                        await list();
                      })
                    }
                  >
                    {wt('暂存')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await op('git-revert', { path: active, ...review });
                        setActive('');
                        setDiff('');
                        setReview(null);
                        await list();
                      })
                    }
                  >
                    {wt('还原到 HEAD')}
                  </button>
                </div>
              )}
            </>
          ) : /\.(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/i.test(active) ? (
            <OfficeEditor
              key={workspace.id + ':' + active}
              filePath={active}
              remoteWorkspaceId={workspace.id}
              onOpenFile={(path) => void action(() => read(path))}
            />
          ) : active.toLowerCase().endsWith('.pdf') ? (
            <iframe
              title={active}
              className="flex-1 min-h-0 w-full border-0"
              src={
                '/api/remote-workspaces/' +
                encodeURIComponent(workspace.id) +
                '/document?inline=1&path=' +
                encodeURIComponent(active)
              }
            />
          ) : buffer ? (
            <>
              <textarea
                aria-label={wt('远程文件内容')}
                disabled={busy}
                spellCheck={false}
                className="form-input flex-1 resize-none font-mono"
                value={buffer.content}
                onChange={(e) =>
                  setBuffers((v) => ({
                    ...v,
                    [active]: { ...v[active]!, content: e.target.value },
                  }))
                }
              />
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await op('write', {
                        path: active,
                        content: buffer.content,
                        revision: buffer.revision,
                      });
                      setBuffers((v) => ({
                        ...v,
                        [active]: {
                          content: buffer.content,
                          original: buffer.content,
                          revision: r.revision,
                        },
                      }));
                      await list();
                    })
                  }
                >
                  {wt('保存')}
                </button>
                <button
                  disabled={busy || buffer.content === buffer.original}
                  onClick={() =>
                    void action(async () => {
                      const r =
                        buffer.revision === null
                          ? { content: buffer.original, revision: null }
                          : await op('read', { path: active });
                      setBuffers((v) => ({
                        ...v,
                        [active]: { content: r.content, original: r.content, revision: r.revision },
                      }));
                    })
                  }
                >
                  {wt('撤销未保存修改')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
