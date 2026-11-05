/** Primary application shortcuts use Command on macOS, Control on Windows/Linux. */
export function isMacPlatform(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  return /mac|iphone|ipad/i.test(platform);
}
export function shortcutText(text: string, platform?: string): string {
  const normalized = text
    .replace(/Ctrl\/⌘\s*/g, 'Ctrl+')
    .replace(/Ctrl (?=[A-Z](?:\b|$))/g, 'Ctrl+');
  return isMacPlatform(platform)
    ? normalized.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥')
    : normalized;
}
export function primaryModifier(
  event: { ctrlKey: boolean; metaKey: boolean },
  platform?: string,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
export function composingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
export function terminalCopyKey(
  event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string },
  platform?: string,
): boolean {
  return (
    event.code === 'KeyC' &&
    !event.altKey &&
    primaryModifier(event, platform) &&
    (isMacPlatform(platform) || event.shiftKey)
  );
}
