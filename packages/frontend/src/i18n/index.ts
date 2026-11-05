// i18next 初始化配置 - 对齐旧版 i18n.js 功能并扩展语言切换
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './zh-CN';
import en from './en';
import { readLocalSettings, saveLocalSettings, PREFERENCES_CHANGED, type PersonalizeSettings } from '../utils/local-preferences';

/** localStorage key：保存用户语言偏好 */
export const LANGUAGE_STORAGE_KEY = 'app.language';
/** 表示"跟随系统"的哨兵值 */
export const AUTO_LANGUAGE = 'auto';
/** fallback 语言 */
export const FALLBACK_LANGUAGE = 'zh-CN';
/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * 根据浏览器语言检测应使用的语言。
 * - zh 开头 → zh-CN
 * - 其它 → en
 */
export function detectSystemLanguage(): SupportedLanguage {
  if (typeof navigator === 'undefined') return FALLBACK_LANGUAGE;
  const nav = navigator.language || '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 解析持久化的语言偏好，返回实际应使用的 i18next 语言代码。
 * - 'auto' / null / undefined → 跟随系统
 * - 其它 → 直接使用（不在支持列表则回退）
 */
export function resolveLanguage(preference: string | null | undefined): SupportedLanguage {
  if (!preference || preference === AUTO_LANGUAGE) {
    return detectSystemLanguage();
  }
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(preference)
    ? (preference as SupportedLanguage)
    : FALLBACK_LANGUAGE;
}

/** 读取本地存储的语言偏好 */
export function readStoredLanguagePreference(): string {
  return readLocalSettings().interfaceLang;
}

/** 写入语言偏好到 localStorage */
export function writeStoredLanguagePreference(value: string): void {
  const interfaceLang = value === AUTO_LANGUAGE || (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
    ? value as PersonalizeSettings['interfaceLang'] : AUTO_LANGUAGE;
  saveLocalSettings({ interfaceLang });
}

const initialPreference = readStoredLanguagePreference();
const initialLanguage = resolveLanguage(initialPreference);

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: initialLanguage,
  fallbackLng: FALLBACK_LANGUAGE,
  interpolation: {
    // React 默认对插值内容不做转义，保持与旧版 t() 一致
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
});

/**
 * 切换语言。
 * @param value 'auto' 表示跟随系统，否则为具体语言代码
 */
export async function changeLanguage(value: string): Promise<void> {
  writeStoredLanguagePreference(value);
  const next = resolveLanguage(value);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  await i18n.changeLanguage(next);
}

/** System changes only affect users who selected Auto; never persist the resolved language. */
export function watchLanguagePreference(): () => void {
  const refresh = () => {
    const next = resolveLanguage(readStoredLanguagePreference());
    document.documentElement.lang = next;
    if (i18n.language !== next) void i18n.changeLanguage(next);
  };
  refresh();
  window.addEventListener('languagechange', refresh);
  window.addEventListener('storage', refresh);
  window.addEventListener(PREFERENCES_CHANGED, refresh);
  return () => {
    window.removeEventListener('languagechange', refresh);
    window.removeEventListener('storage', refresh);
    window.removeEventListener(PREFERENCES_CHANGED, refresh);
  };
}

export default i18n;
