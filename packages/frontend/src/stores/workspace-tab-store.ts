import { wt } from '@/i18n/workbench-text';
// 工作区 tab 状态：右侧工作区面板的通用 tab 系统（对齐参考形态：左上 + 按钮
// 弹出菜单，可打开 编辑器/文档/终端/浏览器/代码变更/Figma 六类视图）。
// 每个 kind 单例 tab（重复打开即激活），默认展示编辑器（文件树/预览）。
import { create } from 'zustand';
import { useProjectPanel } from './project-panel-store';

/** 工作区 tab 类型（+ 菜单前 6 项） */
export type WorkspaceTabKind =
  'editor' | 'doc' | 'terminal' | 'browser' | 'changes' | 'canvas' | 'database';

/** tab 项 */
export interface WorkspaceTab {
  id: WorkspaceTabKind;
  kind: WorkspaceTabKind;
  title: string;
}

/** + 菜单定义（与参考图一致的顺序与前 6 项） */
export const WORKSPACE_MENU: Array<{
  kind: WorkspaceTabKind;
  title: string;
  icon: string;
  desc: string;
}> = [
  {
    kind: 'database',
    get title() {
      return wt('数据库');
    },
    icon: 'table',
    get desc() {
      return wt('SQLite 表结构、查询与编辑');
    },
  },
  {
    kind: 'editor',
    get title() {
      return wt('编辑器');
    },
    icon: 'code',
    get desc() {
      return wt('浏览与编辑项目文件');
    },
  },
  {
    kind: 'doc',
    get title() {
      return wt('Office');
    },
    icon: 'doc',
    get desc() {
      return wt('新建和编辑文档、表格、演示文稿');
    },
  },
  {
    kind: 'terminal',
    get title() {
      return wt('终端');
    },
    icon: 'terminal',
    get desc() {
      return wt('项目终端（PowerShell）');
    },
  },
  {
    kind: 'browser',
    get title() {
      return wt('浏览器');
    },
    icon: 'globe',
    get desc() {
      return wt('内置浏览器（可选中元素交给 AI）');
    },
  },
  {
    kind: 'changes',
    get title() {
      return wt('文档变更');
    },
    icon: 'git-compare',
    get desc() {
      return wt('查看修改、撤销和恢复历史版本');
    },
  },
  {
    kind: 'canvas',
    get title() {
      return wt('画布');
    },
    icon: 'frame',
    get desc() {
      return wt('文字、形状、图片与图层，自由编辑设计');
    },
  },
];

interface WorkspaceTabState {
  /** 已打开的 tab（按打开顺序） */
  tabs: WorkspaceTab[];
  /** 当前激活 tab id */
  activeTab: WorkspaceTabKind;
  /** + 菜单开合 */
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  /** 打开（或激活）某类 tab；面板未展开时自动展开（联动 project-panel-store） */
  openTab: (kind: WorkspaceTabKind) => void;
  closeTab: (kind: WorkspaceTabKind) => void;
  setActiveTab: (kind: WorkspaceTabKind) => void;
}

export const useWorkspaceTabs = create<WorkspaceTabState>((set, get) => ({
  tabs: [{ id: 'editor', kind: 'editor', title: wt('编辑器') }],
  activeTab: 'editor',
  menuOpen: false,

  setMenuOpen: (v) => set({ menuOpen: v }),

  openTab: (kind) => {
    const { tabs } = get();
    const exists = tabs.some((t) => t.kind === kind);
    const meta = WORKSPACE_MENU.find((m) => m.kind === kind);
    const next = exists ? tabs : [...tabs, { id: kind, kind, title: meta?.title ?? kind }];
    set({ tabs: next, activeTab: kind, menuOpen: false });
    // 面板未展开时自动展开（面板开合仍归 project-panel-store 管）
    if (!useProjectPanel.getState().open) useProjectPanel.getState().setOpen(true);
  },

  closeTab: (kind) => {
    const { tabs, activeTab } = get();
    // 重入防护：tab 已被移除（Icon 点击冒泡到 tab 按钮时二次触发）直接忽略
    if (!tabs.some((t) => t.kind === kind)) return;
    if (tabs.length <= 1) {
      // 至少保留一个 tab（不可全关）
      set({ tabs, activeTab });
      return;
    }
    const idx = tabs.findIndex((t) => t.kind === kind);
    const next = tabs.filter((t) => t.kind !== kind);
    const fallback = next[Math.min(idx, next.length - 1)]?.kind ?? 'editor';
    set({ tabs: next, activeTab: activeTab === kind ? fallback : activeTab });
  },

  // 只允许激活已打开的 tab（关闭按钮冒泡场景防护）
  setActiveTab: (kind) =>
    set((s) => (s.tabs.some((t) => t.kind === kind) ? { activeTab: kind } : s)),
}));
