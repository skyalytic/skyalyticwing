// 主题切换 hook：dark / light / system
// - system 模式跟随 prefers-color-scheme 并实时响应系统切换
// - 应用到 document.documentElement（dataset.theme + dark/light class，兼容 global.css 选择器）
// - 可选 localStorage 持久化（默认开启，key 'app.theme'）
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

/** 已解析的实际主题（system 被替换为 dark/light） */
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'app.theme';

export interface UseThemeOptions {
  /** 初始主题（persist 且 localStorage 有值时被忽略） */
  defaultTheme?: Theme;
  /** 是否持久化到 localStorage（默认 true） */
  persist?: boolean;
  /** localStorage key（默认 'app.theme'） */
  storageKey?: string;
}

function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light' || v === 'system';
}

/** 读取系统偏好（SSR / 无 matchMedia 时回退 dark） */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 将已解析主题应用到根元素：dataset.theme + class（不覆盖其它 class） */
export function applyThemeToDocument(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.classList.remove('dark', 'light');
  root.classList.add(resolved);
}

export function useTheme(options: UseThemeOptions = {}) {
  const { defaultTheme = 'system', persist = true, storageKey = THEME_STORAGE_KEY } = options;

  const [theme, setThemeState] = useState<Theme>(() => {
    if (persist) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (isTheme(stored)) return stored;
      } catch {
        /* localStorage 不可用时回退默认值 */
      }
    }
    return defaultTheme;
  });
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // 监听系统主题切换（system 模式下实时生效）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  // 主题变化时应用 DOM + 持久化
  useEffect(() => {
    applyThemeToDocument(resolved);
    if (persist) {
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        /* ignore */
      }
    }
  }, [theme, resolved, persist, storageKey]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  return { theme, resolvedTheme: resolved, setTheme };
}
