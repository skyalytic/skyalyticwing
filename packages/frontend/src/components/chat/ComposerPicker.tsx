import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { contextAttachment, type ContextReference } from '@/services/context-reference';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { Icon } from '@/components/Icon';
import type { Attachment, ChatMessage, SessionInfo, PluginInfo } from '@/types';
import './composer-picker.css';

type Entry = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  icon?: string;
  run: () => void | Promise<void>;
};
type FileNode = {
  name: string;
  type: string;
  path?: string;
  children?: FileNode[];
  truncated?: boolean;
};
const leaf = (p: string) => p.split(/[\\/]/).pop() || p;
const join = (p: string, n: string) => p.replace(/[\\/]+$/, '') + '/' + n;
export interface ComposerPickerProps {
  mode: '@' | '/';
  query: string;
  anchor: RefObject<HTMLTextAreaElement>;
  agents: Array<{ id: string; name: string; description?: string }>;
  onAttach: (attachment: Attachment) => void;
  onClose: () => void;
  onComplete: () => void;
  onCommand: (command: string) => void;
}
export function ComposerPicker({
  mode,
  query,
  anchor,
  agents,
  onAttach,
  onClose,
  onComplete,
  onCommand,
}: ComposerPickerProps) {
  useWorkbenchLanguage();
  const navigate = useNavigate(),
    project = useProjectPanel((s) => s.projectDir);
  const [category, setCategory] = useState(''),
    [directory, setDirectory] = useState(project);
  const [entries, setEntries] = useState<Entry[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [active, setActive] = useState(0),
    [retry, setRetry] = useState(0),
    [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [pos, setPos] = useState({ left: 8, bottom: 80, width: 340, maxHeight: 360 });
  const panel = useRef<HTMLDivElement>(null),
    alive = useRef(true);
  const callbacks = useRef({ onAttach, onClose, onComplete, onCommand });
  callbacks.current = { onAttach, onClose, onComplete, onCommand };
  const pending = useRef(false);
  const searchTree = useRef<{ project: string; nodes: FileNode[]; partial: boolean } | null>(null);
  const session = useSessionStore((s) => s.currentSessionId);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const attach = (ref: Omit<ContextReference, 'version'>) => {
    if (alive.current) callbacks.current.onAttach(contextAttachment(ref));
  };
  const file = (p: string, kind: 'file' | 'folder' | 'rule' = 'file'): Entry => ({
    id: kind + ':' + p,
    label: leaf(p),
    description: p,
    icon: kind === 'folder' ? 'folder' : 'file',
    run: () =>
      attach({
        kind,
        label: leaf(p),
        path: p,
        instruction:
          kind === 'folder'
            ? '引用该目录。请先列出目录，再按任务需要读取相关文件。'
            : '引用该文件。请先读取当前文件内容，再按用户要求处理。',
      }),
  });
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPartial(false);
    setEntries([]);
    setActive(0);
    const load = async () => {
      let list: Entry[] = [];
      if (mode === '@') {
        if (!category) {
          list = useProjectPanel
            .getState()
            .openFiles.slice(-5)
            .reverse()
            .map((p) => ({ ...file(p), group: wt('已打开文件') }));
          if (query.trim() && project) {
            if (searchTree.current?.project !== project) {
              const tree = await apiClient.get<{ children?: FileNode[]; truncated?: boolean }>(
                `/files/tree?path=${encodeURIComponent(project)}&depth=6`,
              );
              const truncated = (nodes: FileNode[]): boolean =>
                nodes.some((n) => n.truncated || (n.children && truncated(n.children)));
              searchTree.current = {
                project,
                nodes: tree.children || [],
                partial: !!tree.truncated || truncated(tree.children || []),
              };
            }
            if (!cancelled) setPartial(searchTree.current.partial);
            const walk = (nodes: FileNode[], base: string) => {
              for (const n of nodes) {
                const p = join(base, n.name);
                if (
                  n.type === 'file' &&
                  !list.some(
                    (e) => e.id.replaceAll('\\', '/') === 'file:' + p.replaceAll('\\', '/'),
                  )
                )
                  list.push({ ...file(p), group: wt('项目文件') });
                if (n.children) walk(n.children, p);
              }
            };
            walk(searchTree.current.nodes, project);
          }
          for (const [id, label, icon] of [
            ['file', '文件', 'file'],
            ['folder', '文件夹', 'folder'],
            ['chat', '历史对话', 'chat'],
            ['rule', '项目规则', 'doc'],
            ['agent', '智能体', 'agent'],
            ['problem', '当前问题', 'warning'],
          ])
            list.push({
              id,
              label: wt(label),
              icon,
              group: wt('引用来源'),
              description: '›',
              run: () => {
                setDirectory(project);
                setCategory(id);
              },
            });
        } else if (category === 'file' || category === 'folder') {
          if (!directory) throw Error(wt('请先选择项目文件夹'));
          const response = await apiClient.get<
            FileNode[] | { entries?: FileNode[]; files?: FileNode[] }
          >(`/files/list?path=${encodeURIComponent(directory)}`);
          const nodes = Array.isArray(response)
            ? response
            : response.entries || response.files || [];
          if (category === 'folder')
            list.push({
              ...file(directory, 'folder'),
              id: 'this-folder',
              label: wt('引用此文件夹'),
            });
          list.push(
            ...nodes
              .filter(
                (n) =>
                  category === 'file' ||
                  n.type === 'directory' ||
                  n.type === 'dir' ||
                  n.type === 'folder',
              )
              .map((n) => {
                const p = n.path || join(directory, n.name),
                  isDir = ['directory', 'dir', 'folder'].includes(n.type);
                return isDir
                  ? {
                      id: p,
                      label: n.name,
                      icon: 'folder',
                      description: wt('打开文件夹'),
                      run: () => setDirectory(p),
                    }
                  : file(p);
              }),
          );
        } else if (category === 'chat') {
          const response = await apiClient.get<SessionInfo[] | { sessions: SessionInfo[] }>(
            '/sessions',
          );
          list = (Array.isArray(response) ? response : response.sessions || [])
            .filter((s) => s.id !== session)
            .map((s) => ({
              id: s.id,
              label: s.title || s.id,
              icon: 'chat',
              description: s.projectDir,
              run: async () => {
                const messages = await apiClient.get<ChatMessage[]>(
                  `/sessions/${encodeURIComponent(s.id)}/messages`,
                );
                attach({
                  kind: 'chat',
                  label: s.title || s.id,
                  content: messages
                    .filter((m) => m.role === 'user' || m.role === 'assistant')
                    .map((m) => `${m.role}: ${m.content}`)
                    .join('\n\n'),
                  instruction: '引用历史对话内容，仅作为当前任务的参考上下文。',
                });
              },
            }));
        } else if (category === 'agent')
          list = agents.map((a) => ({
            id: a.id,
            label: a.name,
            description: a.description,
            icon: 'agent',
            run: () => {
              useSessionStore.getState().selectAgent(a.id);
              callbacks.current.onComplete();
            },
          }));
        else if (category === 'rule') {
          if (!project) throw Error(wt('请先选择项目文件夹'));
          const tree = await apiClient.get<{ children?: FileNode[] }>(
            `/files/tree?path=${encodeURIComponent(project)}&depth=6`,
          );
          const walk = (nodes: FileNode[], base: string) => {
            for (const n of nodes) {
              const p = join(base, n.name);
              if (
                n.type === 'file' &&
                (/^(AGENTS\.md|CLAUDE\.md|\.cursorrules)$/i.test(n.name) ||
                  /[\\/](\.rules|rules|\.cursor[\\/]rules|\.trae[\\/]rules)[\\/].*\.(md|mdc)$/i.test(
                    p,
                  ))
              )
                list.push(file(p, 'rule'));
              if (n.children) walk(n.children, p);
            }
          };
          walk(tree.children || [], project);
        } else if (category === 'problem') {
          const state = useChatStore.getState();
          list =
            state.messagesSessionId === session
              ? state.messages
                  .filter((m) => m.role === 'tool')
                  .flatMap((m) => {
                    try {
                      const r = JSON.parse(m.content);
                      return r.success === false
                        ? [
                            {
                              id: m.id,
                              label: m.toolName || wt('工具执行失败'),
                              icon: 'warning',
                              description: r.error || '',
                              run: () =>
                                attach({
                                  kind: 'problem',
                                  label: m.toolName || wt('工具执行失败'),
                                  content: JSON.stringify(r, null, 2),
                                }),
                            },
                          ]
                        : [];
                    } catch {
                      return [];
                    }
                  })
              : [];
        }
      } else {
        list = [
          ['terminal', '终端', '打开内置终端'],
          ['browser', '浏览器', '打开内置浏览器'],
          ['changes', '文档变更', '查看修改并撤销或重做'],
          ['compact', '压缩对话', '整理当前对话上下文'],
          ['clear', '清空对话', '确认后清空当前对话'],
        ].map(([id, label, description]) => ({
          id,
          label: wt(label),
          description: wt(description),
          group: wt('命令'),
          icon:
            id === 'terminal'
              ? 'terminal'
              : id === 'browser'
                ? 'globe'
                : id === 'changes'
                  ? 'git'
                  : 'command',
          run: () => callbacks.current.onCommand(id),
        }));
        const sources = await Promise.allSettled([
          apiClient.get<{
            skills?: Array<{ name: string; description?: string; location?: string }>;
          }>('/skills'),
          apiClient.get<Array<PluginInfo & { tools?: string[] }>>('/plugins'),
        ]);
        if (sources[0].status === 'fulfilled')
          for (const s of sources[0].value.skills || [])
            list.push({
              id: 'skill:' + s.name,
              label: s.name,
              description: s.description,
              group: wt('技能'),
              icon: 'skill',
              run: async () => {
                const guide = await apiClient.get<{ content: string; path: string }>(
                  `/skill-content?id=${encodeURIComponent(s.name)}`,
                );
                attach({
                  kind: 'skill',
                  label: s.name,
                  path: guide.path,
                  content: guide.content,
                  instruction:
                    '用户选用了此技能。请读取完整技能指南，结合当前请求执行，遵守现有权限。',
                });
              },
            });
        if (sources[1].status === 'fulfilled')
          for (const p of sources[1].value || [])
            if (p.enabled && p.loaded)
              list.push({
                id: 'plugin:' + p.id,
                label: p.name,
                description: p.description,
                group: wt('插件'),
                icon: 'plugin',
                run: () =>
                  attach({
                    kind: 'plugin',
                    label: p.name,
                    content: (p.description || '') + '\n' + (p.tools || []).join('\n'),
                    instruction:
                      '用户选用了此插件。按任务需要调用此插件提供的工具，仍遵守当前权限。',
                  }),
              });
        if (sources.some((s) => s.status === 'rejected') && !cancelled)
          setError(wt('部分来源加载失败，请重试'));
      }
      if (!cancelled) setEntries(list);
    };
    void load()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, category, directory, project, retry, session, agents, query]);
  const filtered = entries.filter((e) =>
    (e.id + ' ' + e.label + ' ' + (e.description || ''))
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  useEffect(() => setActive(0), [query, category, directory]);
  const choose = async (entry: Entry) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await entry.run();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        anchor.current?.focus();
      }
    }
  };
  const latest = useRef({ filtered, active, choose });
  latest.current = { filtered, active, choose };
  useEffect(() => {
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPos({
          left: Math.max(8, Math.min(rect.left, innerWidth - 350)),
          bottom: Math.max(8, innerHeight - rect.top + 6),
          width: Math.min(360, innerWidth - 16),
          maxHeight: Math.max(120, Math.min(390, rect.top - 16)),
        });
    };
    update();
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (
        e.key !== 'Escape' &&
        e.target !== anchor.current &&
        !(e.target instanceof HTMLElement && e.target.closest('[role=option]'))
      )
        return;
      const current = latest.current;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') callbacks.current.onClose();
        else if (e.key === 'Enter') {
          const item = current.filtered[current.active];
          if (item) void current.choose(item);
        } else
          setActive((i) =>
            Math.max(
              0,
              Math.min(current.filtered.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)),
            ),
          );
      }
    };
    const outside = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && e.target !== anchor.current)
        callbacks.current.onClose();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor]);
  useEffect(() => {
    panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return createPortal(
    <div
      ref={panel}
      className="wing-composer-picker"
      role="dialog"
      aria-label={wt(mode === '@' ? '选择引用' : '选择命令或技能')}
      style={pos}
    >
      <div className="wing-picker-heading">
        {category ? (
          <button
            onClick={() => {
              setCategory('');
              setDirectory(project);
              anchor.current?.focus();
            }}
          >
            {wt('返回')}
          </button>
        ) : (
          <strong>{wt(mode === '@' ? '引用' : '命令、技能与插件')}</strong>
        )}
        <span>{directory && ['file', 'folder'].includes(category) ? directory : ''}</span>
        <button onClick={onClose} aria-label={wt('关闭')}>
          ×
        </button>
      </div>
      {category &&
        ['file', 'folder'].includes(category) &&
        directory.replaceAll('\\', '/') !== project.replaceAll('\\', '/') && (
          <button
            className="wing-picker-up"
            onClick={() => {
              setDirectory(directory.replace(/[\\/][^\\/]+[\\/]?$/, ''));
              anchor.current?.focus();
            }}
          >
            {wt('上一级')}
          </button>
        )}
      {loading && <p role="status">{wt('加载中…')}</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>{wt('重试')}</button>
        </p>
      )}
      {partial && <p>{wt('结果未包含全部目录，可从“文件”分类继续查找。')}</p>}
      <div role="listbox" aria-label={wt('可选项目')} aria-busy={busy}>
        {!loading && !filtered.length && (
          <p>{wt(category === 'problem' ? '当前对话没有失败记录' : '无匹配项目')}</p>
        )}
        {filtered.map((e, i) => (
          <div key={e.id}>
            {e.group && e.group !== filtered[i - 1]?.group && (
              <div className="wing-picker-group">{e.group}</div>
            )}
            <button
              role="option"
              aria-selected={i === active}
              className="wing-picker-item"
              disabled={busy}
              title={e.description}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void choose(e)}
            >
              <Icon name={e.icon || 'file'} size={15} />
              <strong>{e.label}</strong>
              <span className="wing-picker-description">{e.description}</span>
            </button>
          </div>
        ))}
      </div>
      {mode === '/' && (
        <footer>
          <button
            onClick={() => {
              onComplete();
              navigate('/skills');
            }}
          >
            {wt('管理技能')}
          </button>
          <button
            onClick={() => {
              onComplete();
              navigate('/plugins?tab=local');
            }}
          >
            {wt('管理插件')}
          </button>
        </footer>
      )}
    </div>,
    document.body,
  );
}
