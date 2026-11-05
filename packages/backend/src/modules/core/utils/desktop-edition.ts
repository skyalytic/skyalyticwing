export type DesktopEdition = 'community' | 'enterprise';
/** Fixed identity of this standalone source tree. */
export const SOURCE_EDITION: DesktopEdition = 'community';
export function desktopEdition(): DesktopEdition { return SOURCE_EDITION; }
