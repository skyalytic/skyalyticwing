// Playwright 配置：浏览器级 E2E（chat-flow / tool-approval）
//
// 本地运行方式：
//   0) 前置：pnpm install；pnpm --filter @skyalyticwing/frontend build（生成 dist）
//      浏览器：npx playwright install chromium（首次需要；本仓库 CI/开发机通常已有缓存）
//   1) 根目录执行：pnpm e2e（等价于 pnpm --filter @skyalyticwing/e2e e2e）
//   2) 有头模式调试：pnpm --filter @skyalyticwing/e2e e2e:headed
//   3) 查看报告：  pnpm --filter @skyalyticwing/e2e e2e:report
//
// 说明：e2e 为独立脚本，不进入 `pnpm test`（turbo test）链，
//       避免无浏览器环境下阻塞常规单测/集成测试。
import { defineConfig } from '@playwright/test';

const PORT = parseInt(process.env.E2E_PORT || '9199', 10);
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  webServer: {
    // mock 后端：静态托管前端 dist + mock REST + 真实 WS + 测试控制端点
    command: 'node mock-server.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    // Fail on an occupied port instead of testing against an unrelated local server.
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
