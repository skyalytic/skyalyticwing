/** Device preferences are independent of the signed-in account. */
export const SETTINGS_STORAGE_KEY = 'app.settings';
export const PREFERENCES_CHANGED = 'wing-preferences-changed';
export interface PersonalizeSettings {
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  compactMode: boolean;
  sendOnEnter: boolean;
  showTimestamps: boolean;
  autoContinue: boolean;
  planMode: boolean;
  maxIterations: number;
  interfaceLang: 'auto' | 'zh-CN' | 'en';
}
export const DEFAULT_SETTINGS: PersonalizeSettings = {
  theme: 'system', fontSize: 14, compactMode: false, sendOnEnter: true,
  showTimestamps: true, autoContinue: true, planMode: false, maxIterations: 200, interfaceLang: 'auto',
};
function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storedSettings(): Record<string, unknown> {
  try {
    const value = JSON.parse(stored(SETTINGS_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function readLocalSettings(): PersonalizeSettings {
  const value = storedSettings();
  const result = { ...DEFAULT_SETTINGS };
  const theme = value['theme'] ?? stored('app.theme');
  if (theme === 'dark' || theme === 'light' || theme === 'system') result.theme = theme;
  const language = stored('app.language') ?? value['interfaceLang'];
  if (language === 'auto' || language === 'zh-CN' || language === 'en') result.interfaceLang = language;
  for (const key of ['compactMode', 'sendOnEnter', 'showTimestamps', 'autoContinue', 'planMode'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const [key, min, max] of [['fontSize', 12, 20], ['maxIterations', 10, 500]] as const) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number)) result[key] = Math.max(min, Math.min(max, number));
  }
  return result;
}
/** Merge the latest values so changing one preference cannot reset another. */
export function saveLocalSettings(patch: Partial<PersonalizeSettings>): PersonalizeSettings {
  const next = { ...readLocalSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...storedSettings(), ...next }));
    localStorage.setItem('app.theme', next.theme);
    localStorage.setItem('app.language', next.interfaceLang);
  } catch { /* Preferences remain usable in memory when storage is unavailable. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREFERENCES_CHANGED));
  return next;
}
