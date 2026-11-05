import { primaryModifier, isMacPlatform, composingKey } from '@/utils/shortcuts';
// Tauri 桥接服务（从旧版 public/tauri-bridge.js 迁移）
// 提供：Tauri 环境检测、统一 invoke、应用版本、自启动、更新、原生体验增强、标题栏控制
// 仅在 Tauri 桌面端生效；浏览器开发模式保留默认行为方便调试。

/** Tauri internals 注入对象（由 Tauri runtime 注入到 window） */
interface TauriInternalsLike {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  plugins?: {
    autostart?: {
      isEnabled: () => Promise<boolean>;
      enable: () => Promise<void>;
      disable: () => Promise<void>;
    };
  };
}

interface TauriGlobalApi {
  app?: {
    getVersion?: () => Promise<string>;
  };
  window?: {
    getCurrentWindow?: () => {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      close: () => Promise<void>;
      startDragging: () => Promise<void>;
    };
  };
  fs?: unknown;
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** 本地 Window 觢约（通过 cast 访问，避免全局污染） */
interface WindowWithTauri extends Window {
  __TAURI_INTERNALS__?: TauriInternalsLike;
  __TAURI__?: TauriGlobalApi;
}

function getWin(): WindowWithTauri {
  return typeof window === 'undefined' ? ({} as WindowWithTauri) : (window as WindowWithTauri);
}

/** 是否运行在 Tauri 桌面端 */
export function isTauri(): boolean {
  try {
    return typeof window !== 'undefined' && !!getWin().__TAURI_INTERNALS__;
  } catch {
    return false;
  }
}

/** 是否桌面端（等价于 isTauri） */
export function isDesktop(): boolean {
  return isTauri();
}

/** 统一 invoke 走 __TAURI_INTERNALS__.invoke（与旧版单一路径一致） */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return (await getWin().__TAURI_INTERNALS__?.invoke?.(cmd, args)) as T;
  } catch (e) {
    console.warn('[Tauri] invoke failed:', cmd, e);
    return null;
  }
}

export async function getServerStatus(): Promise<unknown> {
  return invoke('get_server_status');
}

export async function checkForUpdates(): Promise<unknown> {
  return invoke('check_for_updates');
}

export async function installUpdate(): Promise<unknown> {
  return invoke('install_update');
}

/** 获取应用版本：优先 core API getVersion()，其次自定义命令，最后返回 null 让前端重试 */
export async function getAppVersion(): Promise<string | null> {
  const w = getWin();
  // 1. 优先 Tauri 核心 API getVersion()
  try {
    if (w.__TAURI__?.app?.getVersion) {
      const v = await w.__TAURI__.app.getVersion();
      if (v) {
        return v;
      }
    }
  } catch (e) {
    console.warn('[Tauri] app.getVersion failed:', e);
  }
  // 2. fallback 自定义命令
  try {
    const v2 = await invoke<string>('get_app_version');
    if (v2) {
      return v2;
    }
  } catch (e) {
    console.warn('[Tauri] get_app_version failed:', e);
  }
  // 3. IPC 未就绪：返回 null 让前端持续重试（绝不返回硬编码假版本号）
  console.warn('[Tauri] All version APIs unavailable, returning null');
  return null;
}

/**
 * 查询开机自启动状态（Tauri autostart 插件）。
 * Tauri v2 插件命令经 invoke('plugin:autostart|is_enabled') 调用
 * （旧 __TAURI_INTERNALS__.plugins.autostart 路径在 v2 运行时不存在，
 * 静默失败导致开关永远显示关闭——已废弃）。
 */
export async function isAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    // Rust 命令 is_enabled 直接返回裸 bool（tauri-plugin-autostart 2.5.1
    // `async fn is_enabled(...) -> Result<bool>`）；兼容 { enabled } 包装形态
    const r = await invoke<boolean | { enabled?: boolean }>('plugin:autostart|is_enabled');
    if (typeof r === 'boolean') return r;
    return !!(r && typeof r === 'object' && r.enabled);
  } catch (e) {
    console.warn('[Tauri] autostart is_enabled failed:', e);
    return false;
  }
}

/** 设置开机自启动（写/删 HKCU Run 注册表项；桌面端经 --minimized 静默启动到托盘） */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    // 直连 internals.invoke：封装层 invoke 失败时吞错返回 null，会误报成功
    await getWin().__TAURI_INTERNALS__?.invoke?.(
      enabled ? 'plugin:autostart|enable' : 'plugin:autostart|disable',
    );
    return true;
  } catch (e) {
    console.warn('[Tauri] autostart ' + (enabled ? 'enable' : 'disable') + ' failed:', e);
    return false;
  }
}

/**
 * 原生应用体验增强（仅 Tauri 桌面端）：
 * - 禁用右键菜单（输入控件除外）
 * - 外部链接用系统浏览器打开
 * - 屏蔽 F5 / Ctrl+R 刷新、Alt+方向键、Ctrl+h/j/g
 * - 禁止拖放
 *
 * 必须在 DOM 就绪后调用。多次调用幂等（通过标志位避免重复绑定）。
 */
export function initNativeEnhance(): void {
  if (!isTauri()) return; // 浏览器开发模式保留默认行为方便调试
  const flagWin = window as unknown as { __skyNativeEnhanceBound?: boolean };
  if (flagWin.__skyNativeEnhanceBound) return;
  flagWin.__skyNativeEnhanceBound = true;

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    e.preventDefault();
  });

  document.addEventListener(
    'click',
    (e) => {
      let target = e.target as HTMLElement | null;
      while (target && target.tagName !== 'A') target = target.parentElement as HTMLElement | null;
      if (target && (target as HTMLAnchorElement).href) {
        const href = (target as HTMLAnchorElement).href;
        if (/^https?:\/\//i.test(href) && !/localhost|127\.0\.0\.1/i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          void invoke('plugin:shell|open', { path: href });
        }
      }
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || composingKey(e) || (e.target instanceof Element && e.target.closest('.xterm'))) return;
    if (e.key === 'F5' || (primaryModifier(e) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      return;
    }
    if (!isMacPlatform() && e.ctrlKey &&
        !(e.target instanceof Element && e.target.closest('input,textarea,[contenteditable="true"]')) &&
        (e.key === 'h' || e.key === 'j' || e.key === 'g')) {
      e.preventDefault();
    }
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

/**
 * 自定义标题栏窗口控制（使用与旧版相同的 plugin:window|* 单一 invoke 路径）。
 * 优先使用 React 端已绑定的 getCurrentWindow 路径，失败回退到 internals invoke。
 */
export async function windowAction(
  action: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging',
): Promise<void> {
  const w = getWin();
  // 优先新版 core API（getCurrentWindow）
  try {
    const win = w.__TAURI__?.window?.getCurrentWindow?.();
    if (win) {
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') await win.toggleMaximize();
      else if (action === 'startDragging') await win.startDragging();
      else await win.close();
      return;
    }
  } catch (e) {
    console.warn('[Tauri] getCurrentWindow failed:', e);
  }
  // 回退到 __TAURI_INTERNALS__.invoke('plugin:window|*')
  const cmdMap: Record<typeof action, string> = {
    minimize: 'plugin:window|minimize',
    toggleMaximize: 'plugin:window|toggle_maximize',
    close: 'plugin:window|close',
    startDragging: 'plugin:window|start_dragging',
  } as const;
  await invoke(cmdMap[action], { label: 'main' });
}

/** Tauri 桥接对象（兼容旧版 window.SkyTauri 形态） */
export const SkyTauri = {
  isDesktop,
  isTauri,
  getServerStatus,
  checkForUpdates,
  installUpdate,
  getAppVersion,
  isAutostartEnabled,
  setAutostart,
  initNativeEnhance,
  windowAction,
};

export type SkyTauriApi = typeof SkyTauri;

