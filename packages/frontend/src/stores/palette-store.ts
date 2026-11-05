import { wt } from '@/i18n/workbench-text';
// 命令面板状态 store
import { create } from 'zustand';

/** 命令定义 */
export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  icon: string;
  /** 快捷键提示文本（仅展示用） */
  shortcut?: string;
  /** 跳转路径（与 action 二选一） */
  path?: string;
  /** 特殊动作标识 */
  action?: 'new-session';
}

export interface PaletteState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  commands: PaletteCommand[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (q: string) => void;
  setSelectedIndex: (updater: number | ((prev: number) => number)) => void;
  reset: () => void;
}

/** 命令清单（对齐旧版 palette.js，并扩展新版路由） */
const COMMANDS: PaletteCommand[] = [
  {
    id: 'new-session',
    get label() {
      return wt('新建会话');
    },
    get description() {
      return wt('创建一个新的聊天会话');
    },
    icon: 'plus',
    shortcut: 'Ctrl+N',
    action: 'new-session',
  },
  {
    id: 'go-chat',
    get label() {
      return wt('切换到聊天');
    },
    get description() {
      return wt('前往对话页面');
    },
    icon: 'chat',
    path: '/',
  },
  {
    id: 'go-agents',
    get label() {
      return wt('智能体中心');
    },
    get description() {
      return wt('前往智能体中心');
    },
    icon: 'agent',
    path: '/agents',
  },
  {
    id: 'go-agents',
    get label() {
      return wt('智能体');
    },
    get description() {
      return wt('前往智能体');
    },
    icon: 'agent',
    path: '/agents',
  },
  {
    id: 'go-channels',
    get label() {
      return wt('渠道中心');
    },
    get description() {
      return wt('前往渠道中心');
    },
    icon: 'channel',
    path: '/channels',
  },
  {
    id: 'go-bindings',
    get label() {
      return wt('渠道绑定');
    },
    get description() {
      return wt('前往渠道绑定管理');
    },
    icon: 'channel',
    path: '/bindings',
  },
  {
    id: 'go-protocols',
    get label() {
      return wt('外部应用接入 Wing');
    },
    get description() {
      return wt('配置外部应用调用 Wing');
    },
    icon: 'zap',
    path: '/settings?tab=protocols',
  },
  {
    id: 'go-memory',
    get label() {
      return wt('记忆中心');
    },
    get description() {
      return wt('前往记忆中心');
    },
    icon: 'moon',
    path: '/memory',
  },
  {
    id: 'go-skills',
    get label() {
      return wt('技能中心');
    },
    get description() {
      return wt('前往技能中心');
    },
    icon: 'skill',
    path: '/skills',
  },
  {
    id: 'go-daemon',
    get label() {
      return wt('系统服务');
    },
    get description() {
      return wt('前往设置中的高级选项');
    },
    icon: 'daemon',
    path: '/settings?tab=advanced',
  },
  {
    id: 'go-remote',
    get label() {
      return wt('远程节点');
    },
    get description() {
      return wt('前往远程节点管理');
    },
    icon: 'remote',
    path: '/remote',
  },
  {
    id: 'go-worktrees',
    get label() {
      return wt('工作树');
    },
    get description() {
      return wt('前往工作树管理');
    },
    icon: 'worktree',
    path: '/worktrees',
  },
  {
    id: 'go-usage',
    get label() {
      return wt('用量统计');
    },
    get description() {
      return wt('前往用量统计');
    },
    icon: 'usage',
    path: '/usage',
  },
  {
    id: 'go-cron',
    get label() {
      return wt('定时任务');
    },
    get description() {
      return wt('前往定时任务管理');
    },
    icon: 'cron',
    path: '/cron',
  },
  {
    id: 'go-workflow',
    get label() {
      return wt('工作流');
    },
    get description() {
      return wt('前往工作流编排');
    },
    icon: 'worktree',
    path: '/workflow',
  },
  {
    id: 'go-config',
    get label() {
      return wt('配置');
    },
    get description() {
      return wt('前往配置管理');
    },
    icon: 'config',
    path: '/config',
  },
  {
    id: 'go-tools',
    get label() {
      return wt('工具');
    },
    get description() {
      return wt('前往工具管理');
    },
    icon: 'tool',
    path: '/tools',
  },
  {
    id: 'go-plugins',
    get label() {
      return wt('插件');
    },
    get description() {
      return wt('前往插件管理');
    },
    icon: 'plugin',
    path: '/plugins',
  },
  {
    id: 'go-monitor',
    get label() {
      return wt('运行状态');
    },
    get description() {
      return wt('前往监控面板');
    },
    icon: 'heartbeat',
    path: '/settings?tab=status&details=monitor',
  },
  {
    id: 'go-mcp',
    label: 'MCP',
    get description() {
      return wt('前往 MCP 连接管理');
    },
    icon: 'mcp',
    path: '/plugins?tab=connections',
  },
  {
    id: 'go-settings',
    get label() {
      return wt('设置');
    },
    get description() {
      return wt('前往设置');
    },
    icon: 'settings',
    path: '/settings',
  },
];

export const usePaletteStore = create<PaletteState>()((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,
  commands: COMMANDS,

  open: () => set({ isOpen: true, query: '', selectedIndex: 0 }),
  close: () => set({ isOpen: false }),
  toggle: () =>
    set((s) => (s.isOpen ? { isOpen: false } : { isOpen: true, query: '', selectedIndex: 0 })),
  setQuery: (q) => set({ query: q, selectedIndex: 0 }),
  setSelectedIndex: (updater) =>
    set((s) => ({
      selectedIndex: typeof updater === 'function' ? updater(s.selectedIndex) : updater,
    })),
  reset: () => set({ isOpen: false, query: '', selectedIndex: 0 }),
}));
