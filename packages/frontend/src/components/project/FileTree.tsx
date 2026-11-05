import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工程文件树（懒加载）：根目录单层列出，目录点击展开时按需拉取子层；
// 文件点击 → onOpenFile 回调（右侧面板预览）。UI 遵循现有 SVG 图标系统。
import { useCallback, useEffect, useState } from 'react';
import { TreeEntryMenu, type TreeMenuTarget } from './TreeEntryMenu';
import { CreateEntryDialog } from './CreateEntryDialog';
import { Icon } from '@/components/Icon';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';

/** 目录条目（GET /files/list） */
interface DirEntry {
  name: string;
  type: 'dir' | 'file' | 'unknown';
  size: number;
}

/** 常见代码/文本扩展名（决定文件图标着色，仅视觉提示） */
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'bat',
  'ps1',
  'sql',
  'json',
  'yaml',
  'yml',
  'toml',
  'css',
  'scss',
  'html',
  'vue',
  'swift',
  'kt',
  'cs',
  'md',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Refresh in place so expanded folders and the visible files survive a reload. */
function useDirectoryEntries(path: string, enabled: boolean, refreshKey: string) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError('');
    apiClient.get<DirEntry[] | { entries?: DirEntry[] }>(`/files/list?path=${encodeURIComponent(path)}`)
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data) ? data : data?.entries;
        if (!Array.isArray(list)) throw new Error(wt('目录响应无效，请重试'));
        setEntries([...list].sort((a, b) =>
          Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name)));
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, enabled, refreshKey]);
  return { entries, loading, error };
}

/** 单个树节点：目录可展开（懒加载），文件可点击预览 */
function TreeNode({
  name,
  absPath,
  depth,
  onOpenFile,
  activeFile,
  refreshKey,
  onMenu,
  expandPath,
}: {
  name: string;
  absPath: string;
  depth: number;
  onOpenFile: (path: string) => void;
  activeFile: string;
  refreshKey: string;
  onMenu: (target: TreeMenuTarget) => void;
  expandPath: string;
}) {
  useWorkbenchLanguage();
  // 目录展开态与子条目（懒加载）
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (expandPath === absPath || expandPath.startsWith(absPath + (absPath.includes('\\') ? '\\' : '/'))) setExpanded(true); }, [expandPath, absPath]);
  const { entries: children, loading, error: loadError } = useDirectoryEntries(absPath, expanded, refreshKey);

  const join = (child: string) => joinPath(absPath, child);

  return (
    <div>
      <div
        className="flex items-center gap-1 rounded cursor-pointer select-none hover:bg-black/5 dark:hover:bg-white/10"
        style={{ paddingLeft: depth * 14 + 4, paddingTop: 2, paddingBottom: 2 }}
        onClick={() => setExpanded((value) => !value)}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onMenu({ path: absPath, directory: true, x: e.clientX, y: e.clientY }); }}
        title={absPath}
      >
        <Icon
          name="chevron-right"
          size={13}
          style={{
            flexShrink: 0,
            transition: 'transform 0.15s',
            transform: expanded ? 'rotate(90deg)' : 'none',
            opacity: 0.7,
          }}
        />
        <Icon name="folder" size={15} style={{ flexShrink: 0, opacity: 0.85 }} />
        <span className="text-sm truncate flex-1">{name}</span>
        {loading ? <span className="text-xs opacity-50 ml-1">…</span> : null}
        <button className="px-1" aria-label={wt('文件夹操作') + ' ' + name} onClick={e => {
          e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); onMenu({ path: absPath, directory: true, x: rect.left, y: rect.bottom });
        }}>⋯</button>
      </div>
      {expanded ? (
        <div>
          {loadError ? (
            <div className="text-xs text-red-500" style={{ paddingLeft: (depth + 1) * 14 + 22 }}>
              {wt('加载失败:')}
              {loadError}
            </div>
          ) : null}
          {(children || []).map((c) =>
            c.type === 'dir' ? (
              <TreeNode
                key={c.name}
                name={c.name}
                absPath={join(c.name)}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                activeFile={activeFile}
                refreshKey={refreshKey}
                onMenu={onMenu}
                expandPath={expandPath}
              />
            ) : (
              <FileRow
                key={c.name}
                name={c.name}
                absPath={join(c.name)}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                activeFile={activeFile}
                onMenu={onMenu}
              />
            ),
          )}
          {children && children.length === 0 && !loading && !loadError ? (
            <div className="text-xs opacity-50" style={{ paddingLeft: (depth + 1) * 14 + 22 }}>
              {wt('（空目录）')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 文件行：点击预览 */
function FileRow({
  name,
  absPath,
  depth,
  onOpenFile,
  activeFile,
  onMenu,
}: {
  name: string;
  absPath: string;
  depth: number;
  onOpenFile: (path: string) => void;
  activeFile: string;
  onMenu: (target: TreeMenuTarget) => void;
}) {
  useWorkbenchLanguage();
  const ext = extOf(name);
  const isActive = activeFile === absPath;
  return (
    <div
      className="flex items-center gap-1 rounded cursor-pointer select-none hover:bg-black/5 dark:hover:bg-white/10"
      style={{
        paddingLeft: depth * 14 + 18,
        paddingTop: 2,
        paddingBottom: 2,
        background: isActive ? 'rgba(59,130,246,0.12)' : undefined,
      }}
      onClick={() => onOpenFile(absPath)}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onMenu({ path: absPath, directory: false, x: event.clientX, y: event.clientY }); }}
      title={absPath}
    >
      <Icon
        name="file"
        size={14}
        style={{ flexShrink: 0, opacity: CODE_EXTS.has(ext) ? 0.95 : 0.55 }}
      />
      <span className="text-sm truncate flex-1">{name}</span>
      <button className="px-1" aria-label={wt('文件操作') + ' ' + name} onClick={event => {
        event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onMenu({ path: absPath, directory: false, x: rect.left, y: rect.bottom });
      }}>⋯</button>
    </div>
  );
}

export function FileTree({ root }: { root: string }) {
  return <ProjectFileTree key={root} root={root} />;
}

function ProjectFileTree({ root }: { root: string }) {
  useWorkbenchLanguage();
  const currentFile = useProjectPanel((s) => s.currentFile);
  const openFile = useProjectPanel((s) => s.openFile);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const treeVersion = useProjectPanel((s) => s.treeVersion);
  const [reloadKey, setReloadKey] = useState(0);
  const [menu, setMenu] = useState<TreeMenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [creating, setCreating] = useState<{ directory: string; type: 'file' | 'dir' } | null>(null);
  const [expandPath, setExpandPath] = useState('');
  const refreshKey = `${treeVersion}:${reloadKey}`;
  const { entries, loading, error } = useDirectoryEntries(root, true, refreshKey);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const rootName =
    root
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || root;

  return (
    <div className="overflow-y-auto flex-1 py-1" onContextMenu={e => { e.preventDefault(); setMenu({ path: root, directory: true, x: e.clientX, y: e.clientY }); }}>
      <div
        className="flex items-center gap-1 rounded select-none"
        style={{ paddingLeft: 6, paddingTop: 2, paddingBottom: 2 }}
        title={root}
      >
        <Icon name="folder" size={15} style={{ flexShrink: 0, opacity: 0.9 }} />
        <span className="text-sm font-medium truncate flex-1">{rootName}</span>
        <button className="p-1" aria-label={wt('新建文件')} title={wt('新建文件')} onClick={() => setCreating({ directory: root, type: 'file' })}><Icon name="file" size={14} />+</button>
        <button className="p-1" aria-label={wt('新建文件夹')} title={wt('新建文件夹')} onClick={() => setCreating({ directory: root, type: 'dir' })}><Icon name="folder" size={14} />+</button>
        <button type="button" className="p-1 opacity-60 hover:opacity-100"
          aria-label={wt('刷新目录')} title={wt('刷新目录')} onClick={refresh}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {loading && entries === null ? <SpinnerWrap label={wt('加载目录…')} /> : null}
      {error ? <div className="p-3 text-sm" role="alert">
        <div className="text-red-500 mb-2">{wt('无法读取目录:')}{error}</div>
        <Button size="sm" variant="secondary" onClick={refresh}>{wt('重试')}</Button>
      </div> : null}
      {(entries || []).map((e) =>
        e.type === 'dir' ? (
          <TreeNode
            key={e.name}
            name={e.name}
            absPath={joinPath(root, e.name)}
            depth={1}
            onOpenFile={openFile}
            activeFile={currentFile}
            refreshKey={refreshKey}
            onMenu={setMenu}
            expandPath={expandPath}
          />
        ) : (
          <FileRow
            key={e.name}
            name={e.name}
            absPath={joinPath(root, e.name)}
            depth={1}
            onOpenFile={openFile}
            activeFile={currentFile}
            onMenu={setMenu}
          />
        ),
      )}
      {entries && entries.length === 0 && !loading && !error ? (
        <div className="text-sm opacity-60 p-3">{wt('（空目录）')}</div>
      ) : null}
      <div className="px-3 pt-3 pb-2">
        <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)}>
          {wt('更换项目文件夹')}
        </Button>
      </div>
      {menu && <TreeEntryMenu target={menu} onClose={closeMenu} onCreate={type => { setCreating({ directory: menu.path, type }); setMenu(null); }} />}
      {creating && <CreateEntryDialog {...creating} onClose={() => setCreating(null)} onCreated={path => {
        setExpandPath(creating.type === 'dir' ? path : creating.directory);
        if (creating.type === 'file') openFile(path);
        setCreating(null); useProjectPanel.getState().bumpTreeVersion();
      }} />}
    </div>
  );
}

function joinPath(root: string, name: string) {
  return /[\\/]$/.test(root) ? root + name : root + (root.includes('\\') ? '\\' : '/') + name;
}
