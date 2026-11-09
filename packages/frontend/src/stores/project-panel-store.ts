import { wt } from '@/i18n/workbench-text';
import type { RemoteWorkspace } from '@/components/workspace/RemoteWorkspaceView';
// 工程面板状态（IDE 工程模式）：右侧可收缩面板的展开态、当前预览文件、
// 项目目录（会话绑定优先，回退全局默认）与目录选择器开关。
// 规则：一个项目文件夹可被多个会话使用；一个会话同时只绑定一个项目文件夹。
// 会话切换时自动重新加载当前会话的生效目录。
import { create } from 'zustand';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
import { useSessionStore } from './session-store';

function currentSessionId(): string | undefined {
  return useSessionStore.getState().currentSessionId ?? undefined;
}

function fileIdentity(path: string) {
  const value = path.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}

interface ProjectPanelState {
  remoteWorkspace: RemoteWorkspace | null;
  /** 面板展开态 */
  open: boolean;
  /** 当前预览文件绝对路径（空 = 显示文件树） */
  currentFile: string;
  openFiles: string[];
  /** 当前生效的项目目录（空 = 未选择，产物落智能体工作目录） */
  projectDir: string;
  /** 生效来源：session=会话绑定 / global=全局默认 / ''=未选择 */
  dirSource: 'session' | 'global' | '';
  /** 文件树刷新版本号；根目录与已展开子目录更新内容并保留展开状态。 */
  treeVersion: number;
  /** projectDir 是否已初始化（防止未加载时误显示"未选择"） */
  initialized: boolean;
  /** 目录选择器弹窗 */
  pickerOpen: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
  /** 打开文件预览（自动展开面板）——对话产物点击联动入口 */
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  /** 返回文件树 */
  showTree: () => void;
  /** 外部改动了工程目录内容（回滚/写入），让文件树重新加载 */
  bumpTreeVersion: () => void;
  setPickerOpen: (v: boolean) => void;
  /**
   * 拉取当前会话生效的项目目录（GET /files/project?sessionId=）。
   * force=true 跳过 initialized 守卫（会话切换时强制重拉）。
   */
  initProjectDir: (force?: boolean) => Promise<void>;
  /** 选择工程目录（POST /files/project，带当前会话 id → 会话绑定；后端自动加白名单并持久化） */
  chooseProjectDir: (dir: string) => Promise<boolean>;
  /** 清除工程目录（DELETE /files/project?sessionId= → 仅解绑当前会话，回退全局默认） */
  clearProjectDir: () => Promise<void>;
}

export const useProjectPanel = create<ProjectPanelState>((set, get) => ({
  remoteWorkspace: null,
  open: false,
  currentFile: '',
  openFiles: [],
  projectDir: '',
  dirSource: '',
  treeVersion: 0,
  initialized: false,
  pickerOpen: false,

  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (v) => set({ open: v }),

  openFile: (path) => {
    if (!path) return;
    set((s) => {
      const existing = s.openFiles.find((p) => fileIdentity(p) === fileIdentity(path));
      return {
        open: true,
        currentFile: existing || path,
        openFiles: existing ? s.openFiles : [...s.openFiles, path],
      };
    });
  },

  closeFile: (path) =>
    set((s) => {
      const index = s.openFiles.indexOf(path);
      const openFiles = s.openFiles.filter((p) => p !== path);
      return {
        openFiles,
        currentFile:
          s.currentFile === path
            ? openFiles[Math.min(index, openFiles.length - 1)] || ''
            : s.currentFile,
      };
    }),

  showTree: () => set({ currentFile: '' }),

  bumpTreeVersion: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  setPickerOpen: (v) => set({ pickerOpen: v }),

  initProjectDir: async (force = false) => {
    if (get().initialized && !force) return;
    const sid = currentSessionId();
    set({
      initialized: false,
      projectDir: '',
      remoteWorkspace: null,
      currentFile: '',
      openFiles: [],
    });
    try {
      const d = await apiClient.get<{ path?: string; source?: 'session' | 'global' | '' }>(
        `/files/project${sid ? `?sessionId=${encodeURIComponent(sid)}` : ''}`,
      );
      // 只认会话绑定：新会话未绑定时显示"未选择"（不回退展示全局默认目录）——
      // 一个对话对应一个选定文件夹，新建对话须重新选择（产物落盘仍走后端原逻辑）。
      // 目录切换（切会话/换绑）后旧预览文件失效：回到文件树视图。
      const sessionDir = d?.source === 'session' ? d?.path || '' : '';
      const remote = await apiClient.get<{ workspaces: RemoteWorkspace[]; bound: string | null }>(
        `/remote-workspaces?sessionId=${encodeURIComponent(sid || '')}`,
      );
      if (sid !== currentSessionId()) return;
      set({
        remoteWorkspace: remote.workspaces.find((w) => w.id === remote.bound) || null,
        projectDir: sessionDir,
        dirSource: d?.source ?? '',
        initialized: true,
        currentFile: '',
      });
    } catch {
      if (sid === currentSessionId())
        set({ initialized: true, projectDir: '', remoteWorkspace: null });
    }
  },

  chooseProjectDir: async (dir) => {
    try {
      let sid = currentSessionId();
      if (!sid) {
        const created = await useSessionStore.getState().createSession(undefined, dir);
        if (!created) throw new Error(useSessionStore.getState().error || wt('创建会话失败'));
        sid = created;
      }
      const d = await apiClient.post<{ path?: string }>('/files/project', {
        path: dir,
        sessionId: sid,
      });
      set({
        projectDir: d?.path || dir,
        dirSource: sid ? 'session' : 'global',
        pickerOpen: false,
        remoteWorkspace: null,
      });
      await useSessionStore.getState().loadSessions();
      window.dispatchEvent(new Event('wing-projects-changed'));
      toast.success(
        wt('项目文件夹已设置'),
        sid ? wt('已绑定到当前会话（该会话的产物将保存到此目录）') : wt('AI 产物将保存到该目录'),
      );
      return true;
    } catch (e) {
      toast.error(wt('设置失败'), e instanceof Error ? e.message : undefined);
      return false;
    }
  },

  clearProjectDir: async () => {
    try {
      const sid = currentSessionId();
      if (sid && get().remoteWorkspace)
        await apiClient.post('/remote-workspaces/bind', { sessionId: sid, id: null });
      await apiClient.delete(`/files/project${sid ? `?sessionId=${encodeURIComponent(sid)}` : ''}`);
      set({ projectDir: '', dirSource: '', currentFile: '', openFiles: [], remoteWorkspace: null });
      await useSessionStore.getState().loadSessions();
      toast.success(
        wt('已清除项目文件夹'),
        sid
          ? wt('当前会话已解绑，产物将落全局配置或智能体工作目录')
          : wt('产物将保存到智能体工作目录'),
      );
    } catch (e) {
      toast.error(wt('清除失败'), e instanceof Error ? e.message : undefined);
    }
  },
}));

// 会话切换时重新加载当前会话的工程目录绑定（一会话一目录；未绑定的会话回退全局默认）
useSessionStore.subscribe((s, prev) => {
  if (s.currentSessionId !== prev.currentSessionId) {
    void useProjectPanel.getState().initProjectDir(true);
  }
});
