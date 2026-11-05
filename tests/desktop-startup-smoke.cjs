const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const out = path.resolve('build/startup-2.0.1/qa');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1100, height: 720 } });
    await context.addInitScript(() => {
      window.testCommands = [];
      window.__TAURI_INTERNALS__ = { invoke: async (name, args) => window.testCommands.push({ name, args }) };
    });
    const page = await context.newPage();
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    await page.goto(pathToFileURL(path.resolve('packages/frontend/public/desktop-startup.html')).href);
    assert.equal(await page.locator('#startup-heading').textContent(), '正在准备你的工作空间');
    assert.equal(await page.locator('#startup-retry').isVisible(), false);
    assert.ok(requests.every(url => url.startsWith('file:')), 'Startup must not require a network request');
    await page.screenshot({ path: path.join(out, 'startup-offline.png') });
    await page.evaluate(() => {
      document.body.classList.add('startup-failed');
      document.getElementById('startup-heading').textContent = '暂时无法启动工作台';
      document.getElementById('startup-status').textContent = '请重新启动 Wing。如果仍无法打开，请联系支持协助处理。';
    });
    await page.getByRole('button', { name: '重新启动', exact: true }).click();
    await page.locator('#startup-exit').click();
    await page.locator('#startup-close').click();
    assert.deepEqual(await page.evaluate(() => window.testCommands), [
      { name: 'plugin:process|restart', args: {} },
      { name: 'plugin:process|exit', args: { code: 0 } },
      { name: 'plugin:process|exit', args: { code: 0 } },
    ]);
    assert.doesNotMatch(await page.locator('body').innerText(), /localhost|127\.0\.0\.1|ERR_|浏览器|WebView|引擎|端口/);
    await page.screenshot({ path: path.join(out, 'startup-failure.png') });
    console.log('PASS: offline startup, application error state, restart and exit controls');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
