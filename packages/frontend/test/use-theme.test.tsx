// useTheme hook 测试：初始读取 / DOM 应用 / system 跟随 / localStorage 持久化
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '@/hooks/use-theme';

function setSystemDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: dark && query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        (globalThis as any).__mqCallback = cb;
      },
      removeEventListener: () => {
        (globalThis as any).__mqCallback = null;
      },
    })),
  );
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    setSystemDark(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认主题跟随系统：应用 dataset.theme 与 class', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('localStorage 持久化：切换后写入，下次初始化读取', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('light'));
    expect(localStorage.getItem('app.theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);

    const second = renderHook(() => useTheme());
    expect(second.result.current.theme).toBe('light');
  });

  it('system 模式：跟随 prefers-color-scheme 并响应系统切换', () => {
    setSystemDark(false);
    const { result } = renderHook(() => useTheme({ defaultTheme: 'system', persist: false }));
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    // 系统切换到 dark
    act(() => {
      (globalThis as any).__mqCallback({ matches: true });
    });
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persist:false 不写 localStorage', () => {
    const { result } = renderHook(() => useTheme({ persist: false }));
    act(() => result.current.setTheme('light'));
    expect(localStorage.getItem('app.theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('切换主题不覆盖根元素上的其它 class（如 compact）', () => {
    document.documentElement.classList.add('compact');
    const { result } = renderHook(() => useTheme({ persist: false }));
    act(() => result.current.setTheme('light'));
    expect(document.documentElement.classList.contains('compact')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
