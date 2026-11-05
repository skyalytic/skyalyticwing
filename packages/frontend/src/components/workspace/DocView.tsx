import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作区"文档"视图：递归列出工程目录下的文档类文件（md/html/pdf/office/txt…），
// 点击查看：html → 浏览器 tab 渲染（file:// 导航）；其余 → 编辑器 tab 预览。
// 未选择工程目录时给引导（与编辑器视图一致）。
import { useCallback, useEffect, useState } from 'react';
import { OfficeEditor } from '../project/OfficeEditor';
import { OfficeTemplatePicker } from '../project/OfficeTemplatePicker';
import { FileActions } from '../project/FileActions';
import './office-home.css';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { useBrowserPanel } from '@/stores/browser-store';

interface TreeNode {
  name: string;
  type: 'dir' | 'file';
  size: number;
  children?: TreeNode[];
  truncated?: boolean;
}

interface TreeResult {
  path: string;
  name: string;
  type: 'dir';
  children: TreeNode[];
  truncated: boolean;
}

/** 文档类扩展名 */
const DOC_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'html',
  'htm',
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'csv',
  'odt',
  'ods',
  'odp',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 递归收集文档文件（跳过 node_modules/.git/dist 等目录） */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '__pycache__',
  '.venv',
  'coverage',
]);
function collectDocs(
  node: TreeNode,
  base: string,
  out: Array<{ path: string; name: string; ext: string }>,
): void {
  const join = (child: string) =>
    base.endsWith('\\') || base.endsWith('/')
      ? base + child
      : base + (base.includes('\\') ? '\\' : '/') + child;
  for (const c of node.children ?? []) {
    if (c.type === 'dir') {
      if (!IGNORED.has(c.name)) collectDocs(c, join(c.name), out);
    } else {
      const ext = extOf(c.name);
      if (DOC_EXTS.has(ext)) out.push({ path: join(c.name), name: c.name, ext });
    }
  }
}

/** 文档图标着色 */
function docIcon(ext: string): string {
  if (ext === 'pdf') return 'doc';
  if (ext === 'html' || ext === 'htm') return 'globe';
  return 'doc';
}

export function DocView() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const openFile = useProjectPanel((s) => s.openFile);
  const openTab = useWorkspaceTabs((s) => s.openTab);
  const navigate = useBrowserPanel((s) => s.navigate);
  const [docs, setDocs] = useState<Array<{ path: string; name: string; ext: string }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<string>();
  const [home, setHome] = useState(true);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newFormat, setNewFormat] = useState('');
  const [newName, setNewName] = useState('');
  const [template, setTemplate] = useState('blank');
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError('');
    try {
      const d = await apiClient.get<TreeResult>(
        `/files/tree?path=${encodeURIComponent(projectDir)}&depth=4`,
      );
      const out: Array<{ path: string; name: string; ext: string }> = [];
      collectDocs({ ...d, type: 'dir', size: 0 }, projectDir, out);
      out.sort((a, b) => a.name.localeCompare(b.name));
      setDocs(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    setDocs(null);
    setOpened(undefined);
    setHome(true);
    void load();
  }, [load]);

  const openDoc = (path: string, ext: string) => {
    if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(ext)) {
      setOpened(path);
      setHome(false);
    } else if (ext === 'html' || ext === 'htm') {
      // HTML 文档 → 内置浏览器渲染真实效果
      openTab('browser');
      void navigate('file:///' + path.replace(/\\/g, '/'));
    } else {
      // 其余文档 → 编辑器 tab 预览（FilePreview）
      openTab('editor');
      openFile(path);
    }
  };

  const createDocument = async () => {
    if (!newName.trim() || !newFormat || creating) return;
    setCreating(true);
    setError('');
    try {
      const created = await apiClient.post<{ path: string }>('/files/office/create', {
        directory: projectDir,
        name: newName.trim(),
        format: newFormat,
        template,
      });
      setNewFormat('');
      await load();
      setOpened(created.path);
      setHome(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (!projectDir) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="doc" size={40} style={{ opacity: 0.35 }} />
        <div className="text-sm font-medium">{wt('Office 办公')}</div>
        <div className="text-xs opacity-60">
          {wt('新建或打开文档、表格和演示文稿，直接编辑并保存到项目文件夹。')}
        </div>
        <Button onClick={() => setPickerOpen(true)}>{wt('选择项目文件夹')}</Button>
      </div>
    );
  }

  if (loading && !docs) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <SpinnerWrap label={wt('扫描文档')} />
      </div>
    );
  }

  return (
    <div className="wing-office-home">
      {opened && (
        <div className="wing-office-document" style={home ? { display: 'none' } : undefined}>
          <header>
            <button onClick={() => setHome(true)}>{wt('文档列表')}</button>
            <strong title={opened}>{opened.split(/[\\/]/).pop()}</strong>
            <FileActions filePath={opened} />
          </header>
          <OfficeEditor key={opened} filePath={opened} onOpenFile={setOpened} />
        </div>
      )}
      <div className="wing-office-library" style={!home ? { display: 'none' } : undefined}>
        <h2>{wt('Office 办公')}</h2>
        <div className="wing-office-new">
          {(
            [
              ['docx', '新建文档'],
              ['xlsx', '新建表格'],
              ['pptx', '新建演示文稿'],
            ] as const
          ).map(([format, label]) => (
            <button
              key={format}
              data-format={format}
              onClick={() => {
                setNewFormat(format);
                setTemplate('blank');
                setNewName(
                  format === 'docx'
                    ? '未命名文档'
                    : format === 'xlsx'
                      ? '未命名表格'
                      : '未命名演示文稿',
                );
              }}
            >
              <span>{format === 'docx' ? 'W' : format === 'xlsx' ? 'S' : 'P'}</span>
              {wt(label)}
            </button>
          ))}
        </div>
        {newFormat && (
          <form
            className="wing-office-create"
            onSubmit={(e) => {
              e.preventDefault();
              void createDocument();
            }}
          >
            <OfficeTemplatePicker format={newFormat} value={template} onChange={setTemplate} disabled={creating} />
            <label>
              {wt('文件名称')}
              <input
                autoFocus
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <span>.{newFormat}</span>
            <button disabled={creating || !newName.trim()} type="submit">
              {wt(creating ? '正在创建…' : '创建并编辑')}
            </button>
            <button type="button" onClick={() => setNewFormat('')}>
              {wt('取消')}
            </button>
          </form>
        )}
        <input
          className="wing-office-search"
          aria-label={wt('搜索文档')}
          placeholder={wt('搜索项目中的文档')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {opened && (
          <button className="wing-office-resume" onClick={() => setHome(false)}>
            {wt('继续编辑')} · {opened.split(/[\\/]/).pop()}
          </button>
        )}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/10 dark:border-white/10 shrink-0">
          <Icon name="doc" size={13} />
          <span className="text-xs font-medium flex-1">
            {docs?.length ?? 0} {wt('个文档')}
          </span>
          <Icon
            name="refresh"
            size={13}
            className="cursor-pointer opacity-60 hover:opacity-100"
            onClick={() => void load()}
            title={wt('重新扫描')}
          />
        </div>
        {error ? <div className="px-3 py-2 text-xs text-red-500 break-all">{error}</div> : null}
        <div className="flex-1 overflow-auto min-h-0 p-1.5">
          {(docs ?? []).length === 0 ? (
            <div className="empty-state text-xs opacity-60 py-8 text-center">
              {wt('未发现文档文件（md/html/pdf/office/txt）。')}
            </div>
          ) : (
            (docs ?? [])
              .filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()))
              .map((f) => (
                <button
                  key={f.path}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => openDoc(f.path, f.ext)}
                  title={f.path}
                >
                  <Icon name={docIcon(f.ext)} size={14} className="shrink-0 opacity-70" />
                  <span className="text-xs truncate flex-1">{f.name}</span>
                  <span className="text-[10px] opacity-40 shrink-0 uppercase">{f.ext}</span>
                  {f.ext === 'html' || f.ext === 'htm' ? (
                    <span className="text-[10px] text-blue-500 shrink-0">{wt('浏览器打开')}</span>
                  ) : (
                    <span className="text-[10px] opacity-40 shrink-0">
                      {wt(
                        ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(f.ext)
                          ? '编辑'
                          : '打开',
                      )}
                    </span>
                  )}
                </button>
              ))
          )}
        </div>
      </div>
    </div>
  );
}
