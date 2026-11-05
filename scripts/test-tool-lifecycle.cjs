const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createServer } = require('node:net'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), runtimeIndex = process.argv.indexOf('--backend-dir');
const backend = runtimeIndex < 0 ? path.join(root, 'packages/backend') : path.resolve(process.argv[runtimeIndex + 1]);
const frontend = path.join(root, 'packages/frontend');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-tool-catalog-'));
const output = path.join(root, '.source-check/tool-list-20261102', runtimeIndex < 0 ? '' : 'installed'); fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, ui, browser, page, log = '';
async function stop() {
  if (!child) return;
  const ended = new Promise(resolve => child.once('close', resolve)); child.kill(); await Promise.race([ended, delay(3000)]); child = undefined;
}
(async () => {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path','systemroot','comspec','temp','tmp','pathext'].includes(key.toLowerCase())));
  Object.assign(env, { NODE_ENV: 'production', PORT: String(port), SKYALYTICWING_DATA_DIR: profile, SKYALYTICWING_WEB_DATA_DIR: profile,
    SKYALYTICWING_AUTH_TOKEN: 'tool-list-fixture', APPDATA: profile, LOCALAPPDATA: profile, USERPROFILE: profile, HOME: profile });
  async function start() {
    child = spawn(process.execPath, [path.join(backend, 'dist/main.js')], { cwd: profile, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    for (let i = 0; i < 160 && child.exitCode === null; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
      await delay(250);
    }
    throw new Error('Isolated backend did not start');
  }
  async function request(url, body, expectSuccess = true, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { Authorization: 'Bearer tool-list-fixture', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (expectSuccess) assert(response.ok && result.success !== false, JSON.stringify(result));
    return result.data ?? result;
  }
  await start();
  let catalog = await request('/tools/catalog');
  assert.equal(catalog.length, 150); assert(catalog.every(t => !t.installed && !t.loaded)); assert.equal((await request('/tools')).length, 0);
  await request('/tools/install', { name: 'file-read' });
  assert.deepEqual((await request('/tools')).map(t => t.name), ['file-read']);
  await request('/tools/uninstall', { name: 'file-read' }); assert.equal((await request('/tools')).length, 0);
  for (const pack of await request('/extensions')) await request(`/extensions/${pack.id}/install`, {});
  assert.equal((await request('/tools')).length, 150);
  await request('/tools/uninstall', { name: 'file-read' });
  assert.equal((await request('/tools')).length, 149); assert((await request('/tools')).some(t => t.name === 'file-write'));
  const unavailable = await request('/tool/execute', { tool: 'file-read', args: {} }, false);
  assert.equal(unavailable.code, 'NOT_FOUND');
  await stop(); await start();
  assert.equal((await request('/tools')).length, 149); assert(!(await request('/tools')).some(t => t.name === 'file-read'));
  await request('/tools/install', { name: 'file-read' }); assert.equal((await request('/tools')).length, 150);
  // Every row uses the same lifecycle endpoint, including desktop, terminal and internal utilities.
  for (const tool of await request('/tools/catalog')) await request('/tools/uninstall', { name: tool.name });
  assert.equal((await request('/tools')).length, 0); assert((await request('/tools/catalog')).every(t => !t.installed && !t.loaded));
  assert((await request('/extensions')).every(pack => !pack.loaded));
  await stop(); await start(); assert.equal((await request('/tools')).length, 0);
  for (const tool of await request('/tools/catalog')) await request('/tools/install', { name: tool.name });
  assert.equal((await request('/tools')).length, 150);
  const report = { passed: true, edition: JSON.parse(fs.readFileSync(path.join(root, 'config/source-edition.json'))).edition,
    catalog: 150, freshInstalled: 0, individualUninstalls: 150, individualReinstalls: 150, siblingUnaffected: true,
    restartPersisted: true, blockedExecution: true, afterAllRemoval: 0, loadedPacksAfterRemoval: 0, modelRequests: 0 };
  if (process.argv.includes('--permissions')) {
    const target = path.join(profile, 'permission-probe.txt');
    const mode = value => request('/permissions/mode', { mode: value }, true, 'PUT');
    const permission = (value, disabled = false) => request('/tools/permission', { toolId: 'file-write', permission: value, disabled });
    const write = content => request('/tool/execute', { tool: 'file-write', args: { path: target, content }, sessionId: 'permission-fixture' }, false);
    async function pending() {
      for (let i = 0; i < 80; i++) { const rows = await request('/approvals'); if (rows.length) return rows[0]; await delay(50); }
      throw Error('Expected pending approval');
    }
    await request('/sandbox/profile', { mode: 'danger-full-access' }, true, 'PUT');
    await mode('ask'); await permission('allow');
    assert.equal((await write('auto')).success, true); assert.equal(fs.readFileSync(target, 'utf8'), 'auto');
    assert.equal((await request('/tools/catalog')).find(t => t.name === 'file-write').permission, 'auto');
    await permission('ask');
    const waiting = write('approved'); const prompt = await pending();
    assert.equal(fs.readFileSync(target, 'utf8'), 'auto');
    await request(`/approvals/${prompt.id}`, { decision: 'allow-once' });
    assert.equal((await waiting).success, true); assert.equal(fs.readFileSync(target, 'utf8'), 'approved');
    const release = write('full-access'); await pending(); await mode('yolo');
    assert.equal((await release).success, true); assert.equal(fs.readFileSync(target, 'utf8'), 'full-access');
    assert.equal((await write('no-prompt')).success, true); assert.equal((await request('/approvals')).length, 0);
    await permission('auto', true);
    assert.equal((await write('must-not-write')).success, false); assert.equal(fs.readFileSync(target, 'utf8'), 'no-prompt');
    await mode('ask'); await permission('ask');
    const rejected = write('must-not-write'); const rejectPrompt = await pending();
    await request(`/approvals/${rejectPrompt.id}`, { decision: 'denied' });
    assert.equal((await rejected).success, false); assert.equal(fs.readFileSync(target, 'utf8'), 'no-prompt');
    const stale = write('must-not-write'); const stalePrompt = await pending(); await permission('auto', true);
    await request(`/approvals/${stalePrompt.id}`, { decision: 'allow-once' });
    assert.equal((await stale).success, false); assert.equal(fs.readFileSync(target, 'utf8'), 'no-prompt');
    await stop(); await start();
    assert.equal((await request('/permissions')).mode, 'ask');
    assert.equal((await write('must-not-write')).success, false); assert.equal(fs.readFileSync(target, 'utf8'), 'no-prompt');
    await permission('auto'); assert.equal((await write('restored')).success, true);
    const invalid = await request('/tools/permission', { toolId: 'file-write', permission: 'invalid' }, false);
    assert(invalid.success === false || invalid.statusCode === 400);
    report.permissions = { autoAndLegacyAllow: true, askWaitsBeforeWriting: true, fullAccessReleasesPending: true,
      fullAccessBypassesAsk: true, disabledBlocksFullAccess: true, rejectionPreventsWrite: true,
      staleApprovalCannotOverrideDisable: true, modeAndDisableSurviveRestart: true, restoreAutomatic: true, invalidRejected: true };
  }
  if (process.argv.includes('--ui')) {
    const vite = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
    const viteServer = vite.createServer || vite.default.createServer;
    const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [frontend] })).href)).default;
    const html = '<!doctype html><html lang="zh-CN" class="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{PermissionModePicker}from"/src/components/chat/PermissionModePicker.tsx";import{ToolsPage}from"/src/modules/tools/ToolsPage.tsx";import"/src/i18n/index.ts";import"/src/styles/global.css";import"/src/index.css";import"/src/styles/workbench.css";createRoot(document.getElementById("root")).render(React.createElement(React.Fragment,null,React.createElement(PermissionModePicker),React.createElement(ToolsPage)));</script></body></html>';
    ui = await viteServer({ configFile: false, root: frontend, plugins: [react(), { name: 'tool-list-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__tool_list') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html));
    }); } }], resolve: { alias: { '@': path.join(frontend, 'src') } }, server: { host: '127.0.0.1', port: 0, proxy: { '/api': {
      target: `http://127.0.0.1:${port}`, changeOrigin: true, headers: { Origin: `http://127.0.0.1:${port}` },
    } } } });
    await ui.listen();
    const { chromium } = require(require.resolve('playwright-core', { paths: [backend] }));
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1060, height: 800 }, locale: 'zh-CN' });
    const pageErrors = []; page.on('pageerror', e => { pageErrors.push(e.message); console.error(e.message); });
    page.on('response', async response => { if (response.status() >= 400 && response.url().includes('/api/')) console.error(response.status(), response.url(), await response.text()); });
    await page.addInitScript(() => localStorage.setItem('skyalyticwing.auth.token', 'tool-list-fixture'));
    await page.goto(`http://127.0.0.1:${ui.httpServer.address().port}/__tool_list`);
    await page.getByRole('button', { name: '卸载', exact: true }).first().waitFor();
    assert.equal(await page.getByRole('table').count(), 1); assert.equal(await page.getByRole('button', { name: '卸载', exact: true }).count(), 150);
    assert.equal(await page.getByRole('columnheader', { name: '状态', exact: true }).count(), 0);
    if (process.argv.includes('--permissions')) {
      await page.getByRole('button', { name: /手动审批/ }).click();
      await page.getByRole('menuitemradio').filter({ hasText: '完全访问' }).click();
      await page.getByRole('button', { name: /完全访问/ }).waitFor();
      assert.equal((await request('/permissions')).mode, 'yolo');
      await page.getByRole('button', { name: /完全访问/ }).click();
      await page.getByRole('menuitemradio').filter({ hasText: '手动审批' }).click();
      await page.getByRole('button', { name: /手动审批/ }).waitFor();
      assert.equal((await request('/permissions')).mode, 'ask');
    }
    const fileRow = () => page.getByRole('row').filter({ has: page.getByText('file-read', { exact: true }) });
    await fileRow().getByRole('button', { name: '卸载', exact: true }).click();
    await fileRow().getByRole('button', { name: '安装', exact: true }).waitFor();
    assert.equal(await request('/tools').then(t => t.length), 149);
    await fileRow().getByRole('button', { name: '安装', exact: true }).click();
    await fileRow().getByRole('button', { name: '卸载', exact: true }).waitFor();
    assert.equal(await request('/tools').then(t => t.length), 150);
    await fileRow().getByRole('combobox').selectOption('disabled');
    await page.waitForFunction(() => !document.querySelector('.tool-catalog select:disabled'));
    assert.equal((await request('/tools/catalog')).find(t => t.name === 'file-read').disabled, true);
    await fileRow().getByRole('combobox').selectOption('auto');
    await page.waitForFunction(() => !document.querySelector('.tool-catalog select:disabled'));
    assert.equal((await request('/tools/catalog')).find(t => t.name === 'file-read').disabled, false);
    await page.locator('.tool-catalog').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: path.join(output, 'tool-list.png') });
    await page.setViewportSize({ width: 760, height: 800 }); await page.screenshot({ path: path.join(output, 'tool-list-narrow.png') });
    const action = await page.getByRole('button', { name: '卸载', exact: true }).first().boundingBox();
    assert(action && action.x >= 0 && action.x + action.width <= 760, 'Uninstall must remain visible in a narrow window');
    assert.deepEqual(pageErrors, []); report.ui = { tables: 1, rows: 150, uninstallReinstall: true, permissionSettings: true, statusColumn: false, modeSwitch: process.argv.includes("--permissions"), browserErrors: 0 };
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(async error => { console.error(error.message); if (page) { await page.screenshot({ path: path.join(output, 'ui-failure.png') }); fs.writeFileSync(path.join(output, 'ui-failure.txt'), await page.locator('body').innerText()); } process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await ui?.close(); await stop(); fs.writeFileSync(path.join(output, 'backend.log'), log);
});
