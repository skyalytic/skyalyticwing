/** Scale authored pixel typography together with the root-relative utilities.
 * Runs after Tailwind; does not touch layout dimensions or document/iframe content.
 */
module.exports = () => ({
  postcssPlugin: 'wing-font-scale',
  OnceExit(root) {
    root.walkDecls(/^(font-size|font|line-height)$/, (decl) => {
      if (decl.value.includes('--ui-font-scale')) return;
      decl.value = decl.value.replace(/\b(\d*\.?\d+)(px|vw)\b/g,
        (_, value, unit) => `calc(${value}${unit} * var(--ui-font-scale, 1))`);
    });
  },
});
module.exports.postcss = true;
