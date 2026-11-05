/** Inline UI text follows the same preference as stylesheet typography. */
export const uiFontSize = (pixels: number): string => `calc(${pixels}px * var(--ui-font-scale, 1))`;
