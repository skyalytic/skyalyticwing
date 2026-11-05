/** Generate utilities for current components; the legacy sheet alone is not sufficient. */
module.exports = {
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}', '../shared/src/**/*.{ts,tsx}'] },
  darkMode: 'class',
  corePlugins: { preflight: false },
};
