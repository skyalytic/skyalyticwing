import { shortcutText, primaryModifier, composingKey } from '@/utils/shortcuts';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 右侧工作区面板（IDE 工程模式）：可收缩/展开（Ctrl+Alt+B），
// 通用 tab 系统：左上 + 按钮弹出菜单打开 编辑器/文档/终端/浏览器/代码变更/Figma
// 六类视图（对齐参考形态），TabBar 负责菜单与 tab 条，内容按激活 tab 分派。
// 收起态不渲染把手——面板切换按钮固定在对话区右上角（ChatView 内 PanelToggleButton）。
import { useEffect } from 'react';
import { Icon } from '@/components/Icon';
import { FolderPickerModal } from '@/components/modals/FolderPickerModal';
import { TabBar } from '@/components/workspace/TabBar';
import { EditorView } from '@/components/workspace/EditorView';
import { DocView } from '@/components/workspace/DocView';
import { TerminalView } from '@/components/workspace/TerminalView';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { ChangesView } from '@/components/workspace/ChangesView';
import { DesignView } from '@/components/workspace/DesignView';
import { DatabaseView } from '@/components/workspace/DatabaseView';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { useWorkspaceResize } from './use-workspace-resize';

export function ProjectPanel() {
  useWorkbenchLanguage();
  const open = useProjectPanel((s) => s.open);
  const toggle = useProjectPanel((s) => s.toggle);
  const setOpen = useProjectPanel((s) => s.setOpen);
  const pickerOpen = useProjectPanel((s) => s.pickerOpen);
  const initProjectDir = useProjectPanel((s) => s.initProjectDir);

  // 工作区 tab
  const activeTab = useWorkspaceTabs((s) => s.activeTab);
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const resize = useWorkspaceResize(open, () => setOpen(false));
  useEffect(() => {
    if (!open) useWorkspaceTabs.getState().setMenuOpen(false);
  }, [open]);

  // 启动拉取工程目录配置 + Ctrl+Alt+B 收缩快捷键（对齐参考形态）
  useEffect(() => {
    void initProjectDir();
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && !composingKey(e) && primaryModifier(e) && e.altKey && (e.code === 'KeyB' || e.key.toLowerCase() === 'b')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [initProjectDir, toggle]);

  return (
    <>
      <>
        <div
          ref={resize.panel}
          className={`sky-project-panel shrink-0 h-full flex flex-col border-l overflow-hidden relative ${resize.full ? 'is-expanded' : ''}`}
          data-open={open}
          data-resizing={resize.dragging || undefined}
          data-collapsing={resize.collapsing || undefined}
          style={{
            display: open ? 'flex' : 'none',
            width: resize.width,
          }}
        >
          {/* 左缘拖宽把手（常显细条，hover 高亮，拖拽调宽） */}
          <div
            className="sky-workspace-resizer"
            role="separator"
            tabIndex={resize.compact ? -1 : 0}
            hidden={resize.compact}
            aria-label={wt('调整工作区宽度')}
            aria-orientation="vertical"
            aria-valuemin={resize.minWidth}
            aria-valuemax={resize.available || undefined}
            aria-valuenow={Math.round(resize.full ? resize.available : resize.width)}
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
            onDoubleClick={resize.toggleExpanded}
            title={wt('拖拽调整面板宽度')}
          />
          {/* 头部：+ 菜单 + 工作区 tab 条 + 收起 */}
          <div className="sky-workspace-tabbar flex items-center gap-1.5 px-2 py-1.5 border-b border-black/10 dark:border-white/10 shrink-0">
            <TabBar />
            <button
              className="sky-panel-expand sky-workspace-expand"
              hidden={resize.compact}
              aria-label={resize.full ? wt('还原面板宽度') : wt('展开工作区')}
              title={resize.full ? wt('还原面板宽度') : wt('展开工作区')}
              onClick={resize.toggleExpanded}
            >
              {resize.full ? '↙' : '↗'}
            </button>
            <button
              className="sky-panel-expand"
              aria-label={wt('返回对话')}
              title={shortcutText(wt('收起 (Ctrl+Alt+B)'))}
              onClick={toggle}
            >
              <Icon name="x" size={15} />
            </button>
          </div>

          {/* 内容分派：编辑器（文件树/预览）/ 文档 / 终端 / 浏览器 / 代码变更 / 画布 */}
          {tabs.some(t => t.kind === 'editor') && <div className="sky-workspace-pane" style={{ display: activeTab === 'editor' ? 'flex' : 'none' }}><EditorView /></div>}
          {activeTab === 'doc' ? <DocView /> : null}
          {tabs.some((t) => t.kind === 'terminal') ? (
            <div
              className="sky-workspace-pane"
              style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
            >
              <TerminalView />
            </div>
          ) : null}
          {activeTab === 'browser' ? <BrowserPanel /> : null}
          {activeTab === 'changes' ? <ChangesView /> : null}
          {tabs.some((t) => t.kind === 'canvas') ? (
            <div
              className="sky-workspace-pane"
              style={{ display: activeTab === 'canvas' ? 'flex' : 'none' }}
            >
              <DesignView />
            </div>
          ) : null}
          {tabs.some((t) => t.kind === 'database') ? (
            <div
              className="sky-workspace-pane"
              style={{ display: activeTab === 'database' ? 'flex' : 'none' }}
            >
              <DatabaseView />
            </div>
          ) : null}
        </div>
      </>

      {pickerOpen ? <FolderPickerModal /> : null}
    </>
  );
}
