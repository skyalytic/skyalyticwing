// useI18n hook：消费 LanguageProvider 提供的 { language, changeLanguage, t }
// 未挂载在 Provider 内时，自动回退到 react-i18next 的 useTranslation，保证健壮性
import { useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nContext, type I18nContextValue } from '@/i18n/LanguageProvider';
import {
  AUTO_LANGUAGE,
  changeLanguage as applyLanguageChange,
  resolveLanguage,
} from '@/i18n';

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  const fallback = useTranslation();

  return useMemo<I18nContextValue>(() => {
    if (ctx) return ctx;
    // 回退分支：组件树未被 LanguageProvider 包裹时仍可用
    const resolved = resolveLanguage(
      fallback.i18n.language === AUTO_LANGUAGE
        ? AUTO_LANGUAGE
        : fallback.i18n.language,
    );
    return {
      language: resolved,
      changeLanguage: (next: string) => applyLanguageChange(next),
      t: (key: string, options?: Record<string, unknown>) =>
        fallback.t(key, options) ?? key,
    };
  }, [ctx, fallback]);
}

export default useI18n;
