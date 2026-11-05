import { uiFontSize } from '@/utils/typography';
// 语言切换组件：下拉菜单，支持 简体中文 / English / 跟随系统
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { PREFERENCES_CHANGED } from '../utils/local-preferences';
import {
  AUTO_LANGUAGE,
  SUPPORTED_LANGUAGES,
  changeLanguage,
  readStoredLanguagePreference,
  resolveLanguage,
  type SupportedLanguage,
} from './index';

interface Option {
  value: string;
  label: string;
  hint: string;
}

/** 选项 label 走 i18n，保持界面语言一致；语言名自身不翻译 */
function useOptions(): Option[] {
  const { t } = useTranslation();
  return [
    { value: 'zh-CN', label: t('langs.zhCN'), hint: 'zh-CN' },
    { value: 'en', label: t('langs.en'), hint: 'en' },
    { value: AUTO_LANGUAGE, label: t('languageSwitcher.followSystem'), hint: 'auto' },
  ];
}

/** 当前生效语言的展示名 */
function useCurrentLabel(): string {
  const { t, i18n } = useTranslation();
  const current = (i18n.language || 'zh-CN') as SupportedLanguage;
  if (current === 'zh-CN') return t('langs.zhCN');
  if (current === 'en') return t('langs.en');
  return t('langs.zhCN');
}

export function LanguageSwitcher() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [preference, setPreference] = useState<string>(() => readStoredLanguagePreference());
  const containerRef = useRef<HTMLDivElement>(null);
  const options = useOptions();
  const currentLabel = useCurrentLabel();

  useEffect(() => {
    const refresh = () => setPreference(readStoredLanguagePreference());
    window.addEventListener(PREFERENCES_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = (value: string) => {
    setPreference(value);
    void changeLanguage(value);
    setOpen(false);
  };

  // 判断某个选项是否高亮：跟随系统高亮当 preference===auto，其它按 preference
  const isActive = (value: string): boolean =>
    preference === value || (!preference && value === AUTO_LANGUAGE);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="btn-secondary text-sm py-1 px-2 inline-flex items-center gap-1.5"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('languageSwitcher.title')}
      >
        <Icon name="globe" size={14} />
        <span className="language-switcher-label">{currentLabel}</span>
        <svg
          viewBox="0 0 12 12"
          width="10"
          height="10"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}
        >
          <path
            d="M2 4 L6 8 L10 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          className="lang-menu"
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 160,
            background: 'var(--bg-secondary, #1f2937)',
            border: '1px solid var(--border-color, #374151)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 50,
            padding: 4,
            margin: 0,
            listStyle: 'none',
          }}
        >
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={isActive(opt.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: uiFontSize(13),
                color: isActive(opt.value) ? 'var(--accent, #58a6ff)' : 'inherit',
                background: isActive(opt.value) ? 'rgba(88,166,255,0.12)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (!isActive(opt.value))
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = isActive(opt.value)
                  ? 'rgba(88,166,255,0.12)'
                  : 'transparent';
              }}
              onClick={() => handleSelect(opt.value)}
            >
              <span className="inline-flex items-center gap-1.5">
                {opt.value === AUTO_LANGUAGE ? (
                  <Icon name="settings" size={12} />
                ) : (
                  <Icon name="globe" size={12} />
                )}
                {opt.label}
              </span>
              <code style={{ fontSize: uiFontSize(11), opacity: 0.6 }}>{opt.hint}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default LanguageSwitcher;

// 重新导出以便外部直接消费（避免循环引用误用）
export { SUPPORTED_LANGUAGES, resolveLanguage };
