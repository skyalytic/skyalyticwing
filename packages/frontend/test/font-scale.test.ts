import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);
const postcss = require('postcss');
const fontScale = require('../scripts/font-scale.cjs');
describe('authored typography scaling', () => {
  it('scales font sizes and line spacing without changing dimensions or double-scaling rem', async () => {
    const source = '.sample{font-size:14px;line-height:22px;width:140px;padding:8px}.code{font:13px/20px monospace}.rem{font-size:1rem}.responsive{font-size:clamp(16px,2vw,30px)}';
    const result = (await postcss([fontScale()]).process(source, { from: undefined })).css;
    expect(result).toContain('font-size:calc(14px * var(--ui-font-scale, 1))');
    expect(result).toContain('font:calc(13px * var(--ui-font-scale, 1))/calc(20px * var(--ui-font-scale, 1)) monospace');
    expect(result).toContain('width:140px;padding:8px'); expect(result).toContain('font-size:1rem');
    expect((await postcss([fontScale()]).process(result, { from: undefined })).css).toBe(result);
  });
});
