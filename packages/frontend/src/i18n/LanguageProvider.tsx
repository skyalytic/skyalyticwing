// 语言上下文 Provider：对外暴露 language / changeLanguage / t
// 内部基于 react-i18next，保持与旧版 i18n.js 的 t(key) 行为一致
import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AUTO_LANGUAGE,
  changeLanguage as applyLanguageChange,
  resolveLanguage,
  watchLanguagePreference,
  type SupportedLanguage,
} from './index';

export interface I18nContextValue {
  /** 当前生效的语言代码（已解析，非 'auto'） */
  language: SupportedLanguage;
  /** 切换语言；传入 'auto' 跟随系统，否则为具体语言代码 */
  changeLanguage: (value: string) => Promise<void>;
  /** 翻译函数：先按完整 key 查找，找不到再按区域回退，最终返回 key 本身 */
  t: (key: string, options?: Record<string, unknown>) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export interface LanguageProviderProps {
  children: ReactNode;
}

/**
 * 语言 Provider：包裹应用根节点，提供统一的 i18n 上下文。
 * 与 react-i18next 的 useTranslation 完全兼容，已挂载的组件可继续使用 useTranslation。
 */
export function LanguageProvider({ children }: LanguageProviderProps) {
  const { t, i18n } = useTranslation();
  useEffect(watchLanguagePreference, []);

  const value = useMemo<I18nContextValue>(() => {
    // i18n.language 可能是 'zh-CN' / 'en'，也可能是 'auto'（持久化值），统一解析
    const resolved = resolveLanguage(
      i18n.language === AUTO_LANGUAGE ? AUTO_LANGUAGE : i18n.language,
    );
    return {
      language: resolved,
      changeLanguage: (next: string) => applyLanguageChange(next),
      t: (key: string, options?: Record<string, unknown>) => t(key, options) ?? key,
    };
  }, [t, i18n.language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export default LanguageProvider;
