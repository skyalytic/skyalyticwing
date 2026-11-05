/* Real Edge/Chrome acceptance of browser isolation, takeover, transfers and offline PNG. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const {
  BuiltInBrowserService,
} = require('../packages/backend/dist/modules/browser/browser.service.js');
const {
  createBuiltinBrowserTools,
} = require('../packages/backend/dist/modules/tools/executor/built-in/builtin-browser.js');
const {
  renderDesignPng,
} = require('../packages/backend/dist/modules/tools/files/design-export.js');
const path = require('node:path');
const destination = path.resolve('.test-runtime-data/browser-download-' + Date.now() + '.txt');
const root = new BuiltInBrowserService({
  isPathAllowed: (p, mode) => p === destination && mode === 'write',
});
let exportNetworkRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    res.setHeader('Content-Disposition', 'attachment; filename="acceptance.txt"');
    res.end('real downloaded content');
    return;
  }
  if (req.url === '/export-network') {
    exportNetworkRequests++;
    res.end('blocked');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    '<!doctype html><html><body><h1>工作台浏览器验收</h1><input id="upload" type="file" aria-label="上传文件"><a href="/popup" target="_blank">新窗口</a><a href="/download">下载文件</a><button onclick="document.cookie=\'login=alice;path=/\'">模拟登录</button></body></html>',
  );
});
(async () => {
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const a = root.forSession('acceptance-a'),
      b = root.forSession('acceptance-b');
    const first = await a.runOperation('agent', () => a.navigate(url));
    const upload = first.elements.find((e) => e.hint === '上传文件').index;
    await a.upload(
      first.pageId,
      upload,
      'design.txt',
      'text/plain',
      Buffer.from('设计素材').toString('base64'),
    );
    const page = a.pages.get(first.pageId).page;
    assert.equal(
      await page.locator('#upload').evaluate(async (e) => await e.files[0].text()),
      '设计素材',
    );
    await page.getByRole('button', { name: '模拟登录' }).click();
    await b.navigate(url);
    assert.match(await page.evaluate(() => document.cookie), /login=alice/);
    assert.equal(
      await b.pages.get(b.status().activePageId).page.evaluate(() => document.cookie),
      '',
    );
    await assert.rejects(b.snapshot(first.pageId), /页面未打开/);
    const tab = await a.newTab(url + '/tab');
    assert.equal(a.status().tabs.length, 2);
    assert.match(await a.pages.get(tab.pageId).page.evaluate(() => document.cookie), /login=alice/);
    await a.activate(first.pageId);
    assert.equal(a.status().activePageId, first.pageId);
    await page.getByText('新窗口').click();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(a.status().tabs.length, 3, 'popup tracked');
    const [tool] = createBuiltinBrowserTools(() => root);
    a.setControl(true);
    let result = await tool.execute({ action: 'navigate', url }, { sessionId: 'acceptance-a' });
    assert.equal(result.success, false);
    assert.match(result.error, /用户已接管/);
    a.setControl(false);
    result = await tool.execute(
      { action: 'snapshot', pageId: first.pageId },
      { sessionId: 'acceptance-a' },
    );
    assert.equal(result.success, true);
    assert.ok(result.data.browserScreenshot.length > 100);
    await page.getByText('下载文件').click();
    for (let i = 0; i < 30 && !a.status().downloads.some((d) => d.status === 'ready'); i++)
      await new Promise((r) => setTimeout(r, 100));
    const download = a.status().downloads.find((d) => d.status === 'ready');
    assert.ok(download);
    const file = await a.download(download.id);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'real downloaded content');
    await a.saveDownload(download.id, destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'real downloaded content');
    await assert.rejects(a.saveDownload(download.id, destination), /EEXIST/);
    await assert.rejects(a.saveDownload(download.id, path.resolve('outside.txt')), /未授权/);
    await a.closeAll();
    await a.navigate(url);
    assert.equal(
      await a.pages.get(a.status().activePageId).page.evaluate(() => document.cookie),
      '',
      'close clears login state',
    );
    const png = await renderDesignPng(
      `<html><body style="background:#fef1cc"><h1>可编辑设计稿</h1><img src="${url}/export-network"><script>fetch('${url}/export-network')</script></body></html>`,
      375,
      812,
    );
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 375);
    assert.equal(png.readUInt32BE(20), 812);
    assert.equal(exportNetworkRequests, 0);
    fs.writeFileSync('.test-runtime-data/canvas-export-acceptance.png', png);
    console.log(
      'PASS real browser: session cookies isolated, same-session tabs share login, foreign page rejected, popup tracked, takeover blocks AI, upload bytes verified, download bytes verified, screenshots returned to tool, close clears login. PASS offline PNG dimensions and network/script blocking.',
    );
  } finally {
    await root.onModuleDestroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
