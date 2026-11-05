import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作区 TabBar：左上 + 按钮（点击弹出菜单：编辑器/文档/终端/浏览器/文档变更/Figma）
// + 已打开 tab 条（激活高亮、可关闭）。菜单 portal 到 body + fixed 定位，
// 规避祖先 overflow 裁剪（与 ChatInput FileRefButton 同一模式）。
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';
import {
  WORKSPACE_MENU,
  useWorkspaceTabs,
  type WorkspaceTabKind,
} from '@/stores/workspace-tab-store';

export function TabBar() {
  useWorkbenchLanguage();
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const activeTab = useWorkspaceTabs((s) => s.activeTab);
  const menuOpen = useWorkspaceTabs((s) => s.menuOpen);
  const setMenuOpen = useWorkspaceTabs((s) => s.setMenuOpen);
  const openTab = useWorkspaceTabs((s) => s.openTab);
  const closeTab = useWorkspaceTabs((s) => s.closeTab);
  const setActiveTab = useWorkspaceTabs((s) => s.setActiveTab);
  const plusRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击菜单外部关闭（mousedown 与 FileRefButton 模式一致）
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || plusRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    const dismiss = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
        plusRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', dismiss);
    };
  }, [menuOpen, setMenuOpen]);

  // 面板收起导致 TabBar 卸载时关闭菜单（zustand 状态不随卸载重置，避免重开面板菜单残留）
  useEffect(() => {
    return () => {
      setMenuOpen(false);
    };
  }, [setMenuOpen]);

  // 菜单定位：+ 按钮下方（fixed，视口内钳制）
  const rect = plusRef.current?.getBoundingClientRect();
  const menuLeft = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 240)) : 8;
  const menuTop = rect ? Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 340)) : 8;

  return (
    <>
      <button
        ref={plusRef}
        aria-expanded={menuOpen}
        aria-label={wt('打开工作区工具')}
        className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-black/5 dark:bg-white/10 hover:bg-blue-500/20 text-base leading-none opacity-80 hover:opacity-100"
        onClick={() => setMenuOpen(!menuOpen)}
        title={wt('打开工作区工具（编辑器/文档/终端/浏览器/文档变更/Figma）')}
      >
        +
      </button>
      {menuOpen
        ? createPortal(
            <div
              ref={menuRef}
              className="sky-workspace-menu"
              style={{ left: menuLeft, top: menuTop }}
            >
              {WORKSPACE_MENU.map((m) => (
                <button
                  key={m.kind}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => openTab(m.kind as WorkspaceTabKind)}
                >
                  <Icon name={m.icon} size={15} />
                  <span className="text-sm flex-1">{wt(m.title)}</span>
                  <span className="text-[10px] opacity-60 truncate max-w-[110px]">
                    {wt(m.desc)}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`shrink-0 h-7 px-2 rounded-md text-xs flex items-center gap-1 ${
              activeTab === t.kind
                ? 'bg-white dark:bg-gray-700 shadow-sm font-medium'
                : 'opacity-60 hover:opacity-100'
            }`}
            onClick={() => setActiveTab(t.kind)}
            title={wt(t.title)}
          >
            <Icon name={WORKSPACE_MENU.find((m) => m.kind === t.kind)?.icon ?? 'file'} size={12} />
            <span className="max-w-[90px] truncate">{wt(t.title)}</span>
            {tabs.length > 1 ? (
              <Icon
                name="x"
                size={10}
                className="opacity-50 hover:opacity-100"
                onClick={() => closeTab(t.kind)}
              />
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}
