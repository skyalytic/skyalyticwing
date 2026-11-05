import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作区"编辑器"视图（原工程文件视图）：未选项目文件夹 → 引导；否则文件树/预览。
// 点击文件进入预览（FilePreview，文本可编辑自动保存）；目录来源标记（本会话/全局）。
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { FileTree } from '@/components/project/FileTree';
import { FilePreview } from '@/components/project/FilePreview';
import { FileTabs } from '@/components/project/FileTabs';
import { useProjectPanel } from '@/stores/project-panel-store';

export function EditorView() {
  useWorkbenchLanguage();
  const currentFile = useProjectPanel((s) => s.currentFile);
  const openFiles = useProjectPanel((s) => s.openFiles);
  const projectDir = useProjectPanel((s) => s.projectDir);
  const dirSource = useProjectPanel((s) => s.dirSource);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const showTree = useProjectPanel((s) => s.showTree);

  const dirName = projectDir
    ? projectDir
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || projectDir
    : '';

  return (
    <>
      {/* 目录信息行：当前目录 + 来源标记 + 返回文件树 */}
      {projectDir ? (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-black/10 dark:border-white/10 text-xs shrink-0">
          <Icon name="folder" size={12} className="opacity-60 shrink-0" />
          {dirName ? (
            <>
              <span className="opacity-60 truncate flex-1" title={projectDir}>
                {dirName}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                  dirSource === 'session'
                    ? 'bg-blue-500/15 text-blue-400'
                    : 'bg-black/10 dark:bg-white/10 text-gray-500'
                }`}
                title={
                  dirSource === 'session'
                    ? wt('该目录已绑定到当前会话')
                    : wt('全局默认工程目录（当前会话未单独绑定）')
                }
              >
                {dirSource === 'session' ? wt('本会话') : wt('全局')}
              </span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          {currentFile ? (
            <Button size="sm" variant="ghost" onClick={showTree} title={wt('返回文件树')}>
              <Icon name="file" size={12} /> {wt('文件树')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <FileTabs />

      {/* 内容：未选目录 → 引导；否则文件树/预览。
          预览区用 absolute inset-0 物理锁定高度——任何内部内容都无法把面板撑高，
          滚轮只作用于文件内容自身（overflow-auto 生效的确定前提） */}
      {!projectDir && !openFiles.length ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="folder" size={44} style={{ opacity: 0.35 }} />
          <div className="text-sm font-medium">{wt('未打开项目文件夹')}</div>
          <div className="text-xs opacity-60 leading-relaxed">
            {wt('选择一个项目文件夹后，AI 产物将保存到该目录，')}
            <br />
            {wt('这里可以浏览和编辑工程文件；未选择时产物保存到智能体工作目录。')}
          </div>
          <Button variant="primary" size="sm" onClick={() => setPickerOpen(true)}>
            {wt('选择项目文件夹')}
          </Button>
        </div>
      ) : (
        <div className="flex-1 relative min-h-0">
          <div className={`sky-editor-layout absolute inset-0 ${currentFile ? 'has-file' : ''}`}>
            {projectDir && (
              <aside className="sky-editor-tree">
                <div className="sky-editor-heading">{wt('工程文件')}</div>
                <FileTree root={projectDir} />
              </aside>
            )}
            {openFiles.map(path => (
              <div key={path} className="sky-editor-content" role="tabpanel" aria-label={path.split(/[\\/]/).pop()}
                style={{ display: path === currentFile ? 'flex' : 'none' }}>
                <FilePreview filePath={path} />
              </div>
            ))}
            {!currentFile && (
              <div className="sky-editor-placeholder">
                <Icon name="code" size={36} />
                <h3>{wt('选择文件开始工作')}</h3>
                <p>{wt('浏览项目文件、预览内容，或直接编辑并保存。')}</p>
                <span>HTML · Markdown · TypeScript · Python · Office</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
