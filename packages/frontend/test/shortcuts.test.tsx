import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { composingKey, primaryModifier, shortcutText, terminalCopyKey } from '@/utils/shortcuts';
import { useCommandPalette } from '@/hooks/use-command-palette';
import { usePaletteStore } from '@/stores/palette-store';
import { useSessionStore } from '@/stores/session-store';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePaletteStore.getState().close();
});
describe.each(['Win32', 'MacIntel', 'Linux x86_64'])('%s shortcuts', (platform) => {
  const mac = platform === 'MacIntel';
  const keys = { ctrlKey: !mac, metaKey: mac };
  it('formats each primary shortcut without mixed platform labels', () => {
    expect(shortcutText('Ctrl/⌘ U', platform)).toBe(mac ? '⌘+U' : 'Ctrl+U');
    expect(shortcutText('Ctrl+Alt+B', platform)).toBe(mac ? '⌘+⌥+B' : 'Ctrl+Alt+B');
    expect(shortcutText('Ctrl K', platform)).toBe(mac ? '⌘+K' : 'Ctrl+K');
    expect(primaryModifier(keys, platform)).toBe(true);
    expect(primaryModifier({ ctrlKey: mac, metaKey: !mac }, platform)).toBe(false);
  });
  it('copies terminal selections without consuming Control+C interrupts', () => {
    expect(
      terminalCopyKey({ ...keys, shiftKey: !mac, altKey: false, code: 'KeyC' }, platform),
    ).toBe(true);
    expect(
      terminalCopyKey(
        { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: 'KeyC' },
        platform,
      ),
    ).toBe(false);
  });
  it('opens the actual command palette, ignores IME and preserves terminal keys', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    renderHook(() => useCommandPalette(), { wrapper: MemoryRouter });
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...keys, isComposing: true })),
    );
    expect(usePaletteStore.getState().isOpen).toBe(false);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...keys })));
    expect(usePaletteStore.getState().isOpen).toBe(true);
    act(() => usePaletteStore.getState().close());
    const term = document.createElement('textarea');
    term.className = 'xterm';
    document.body.append(term);
    act(() =>
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...keys, bubbles: true })),
    );
    expect(usePaletteStore.getState().isOpen).toBe(false);
    term.remove();
  });
  it('binds the displayed new-conversation shortcut', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const create = vi
      .spyOn(useSessionStore.getState(), 'createSession')
      .mockResolvedValue(undefined as never);
    renderHook(() => useCommandPalette(), { wrapper: MemoryRouter });
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...keys, cancelable: true })),
    );
    expect(create).toHaveBeenCalledOnce();
  });
});
it('recognizes browser and Windows IME composition events', () => {
  expect(composingKey({ isComposing: true })).toBe(true);
  expect(composingKey({ keyCode: 229 })).toBe(true);
  expect(composingKey({ keyCode: 13 })).toBe(false);
});
