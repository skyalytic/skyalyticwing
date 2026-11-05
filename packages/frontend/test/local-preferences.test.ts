import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n, { changeLanguage, readStoredLanguagePreference, watchLanguagePreference } from '@/i18n';
import { applyStartupSettings, watchSystemAppearance } from '@/utils/apply-settings';
import { readLocalSettings, saveLocalSettings } from '@/utils/local-preferences';

let dark = false;
let media: EventTarget;
let stopAppearance: () => void;
let stopLanguage: () => void;
function systemLanguage(value: string) { vi.spyOn(navigator, 'language', 'get').mockReturnValue(value); }
beforeEach(() => {
  localStorage.clear();
  dark = false; media = new EventTarget();
  vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; }, addEventListener: media.addEventListener.bind(media), removeEventListener: media.removeEventListener.bind(media) }));
  systemLanguage('en-US');
  stopAppearance = watchSystemAppearance(); stopLanguage = watchLanguagePreference();
});
afterEach(() => { stopAppearance(); stopLanguage(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('device preferences across pages and restarts', () => {
  it('follows system language and appearance on first launch without opening Settings', async () => {
    applyStartupSettings();
    expect(readLocalSettings()).toMatchObject({ theme: 'system', interfaceLang: 'auto' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(i18n.language).toBe('en');
    dark = true; media.dispatchEvent(new Event('change'));
    systemLanguage('zh-CN'); window.dispatchEvent(new Event('languagechange'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(i18n.language).toBe('zh-CN');
    expect(readStoredLanguagePreference()).toBe('auto');
  });
  it('keeps manual choices through system changes and restores all appearance settings on startup', async () => {
    localStorage.setItem('sky-ui-zoom', '1.2');
    saveLocalSettings({ theme: 'dark', fontSize: 18, compactMode: true });
    await changeLanguage('en');
    systemLanguage('zh-CN'); window.dispatchEvent(new Event('languagechange'));
    media.dispatchEvent(new Event('change'));
    document.documentElement.className = ''; document.documentElement.style.fontSize = '';
    applyStartupSettings();
    expect(i18n.language).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.fontSize).toBe('18px');
    expect(document.body.style.zoom).toBe('1.2');
    expect(document.documentElement.style.getPropertyValue('--ui-zoom')).toBe('1.2');
    expect(Number(document.documentElement.style.getPropertyValue('--ui-font-scale'))).toBeCloseTo(18 / 14);
    expect(document.documentElement.classList.contains('compact')).toBe(true);
    expect(readLocalSettings()).toMatchObject({ theme: 'dark', interfaceLang: 'en', fontSize: 18, compactMode: true });
  });
  it('restores follow-system after manual selection without saving a fixed resolved value', async () => {
    await changeLanguage('zh-CN'); saveLocalSettings({ theme: 'dark' });
    await changeLanguage('auto'); saveLocalSettings({ theme: 'system' });
    expect(i18n.language).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(JSON.parse(localStorage.getItem('app.settings')!)).toMatchObject({ theme: 'system', interfaceLang: 'auto' });
  });
  it('retains old device preferences and synchronizes changes from another window', () => {
    localStorage.setItem('app.theme', 'light');
    localStorage.setItem('app.settings', JSON.stringify({ interfaceLang: 'zh-CN', compactMode: true }));
    applyStartupSettings();
    expect(readLocalSettings()).toMatchObject({ theme: 'light', interfaceLang: 'zh-CN' });
    localStorage.setItem('app.settings', JSON.stringify({ theme: 'dark', fontSize: 16 }));
    localStorage.setItem('app.language', 'en');
    window.dispatchEvent(new StorageEvent('storage', { key: 'app.settings' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.fontSize).toBe('16px');
    expect(i18n.language).toBe('en');
  });
  it.each(['null', '[]', '{broken', '{"theme":"invalid","fontSize":"bad"}'])('recovers damaged settings %s to system defaults', (raw) => {
    localStorage.setItem('app.settings', raw);
    expect(() => applyStartupSettings()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(readLocalSettings().interfaceLang).toBe('auto');
  });
});
