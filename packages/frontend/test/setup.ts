import '@testing-library/jest-dom/vitest';

// The regression suite asserts the Chinese UI. Locale-specific suites explicitly
// switch languages; tests must not depend on the host machine's system locale.
if (typeof localStorage !== 'undefined') localStorage.setItem('app.language', 'zh-CN');
