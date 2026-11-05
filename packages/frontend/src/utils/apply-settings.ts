// 启动时应用持久化的个性化设置（主题 / 字号）
// 数据来源与 SettingsPage PersonalizeTab 一致：localStorage 'app.settings'（同步读取，避免闪烁 FOUC）
import { applyThemeToDocument, type Theme, type ResolvedTheme } from '@/hooks/use-theme';
import { readLocalSettings, PREFERENCES_CHANGED } from './local-preferences';
export { SETTINGS_STORAGE_KEY } from './local-preferences';

export function applyUiZoom(value = Number(localStorage.getItem('sky-ui-zoom') ?? 1)): number {
  const zoom = [0.9, 1, 1.1, 1.2].includes(value) ? value : 1;
  document.body.style.zoom = String(zoom);
  document.documentElement.style.setProperty('--ui-zoom', String(zoom));
  return zoom;
}

/** 将 theme（含 system）解析为实际生效的 dark/light */
function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 启动时读取 app.settings 并同步应用主题与字号到 document。
 * 在 main.tsx 渲染前调用，保证首帧即为用户偏好主题（不依赖 SettingsPage 挂载）。
 */
export function applyStartupSettings(): void {
  if (typeof window === 'undefined') return;
  const settings = readLocalSettings();
  applyUiZoom();
  applyThemeToDocument(resolveTheme(settings.theme));
  document.documentElement.style.fontSize = `${settings.fontSize}px`;
  document.documentElement.style.setProperty('--ui-font-scale', String(settings.fontSize / 14));
  document.documentElement.classList.toggle('compact', settings.compactMode);
}

/** Keep system theme responsive even when the settings page is unmounted. */
export function watchSystemAppearance(): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const refresh = applyStartupSettings;
  media?.addEventListener('change', refresh);
  window.addEventListener('storage', refresh);
  window.addEventListener(PREFERENCES_CHANGED, refresh);
  return () => {
    media?.removeEventListener('change', refresh);
    window.removeEventListener('storage', refresh);
    window.removeEventListener(PREFERENCES_CHANGED, refresh);
  };
}
