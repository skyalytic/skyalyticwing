/* Real local browser acceptance. No external accounts, model calls or messages. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { BuiltInBrowserService } = require('../packages/backend/dist/modules/browser/browser.service.js');
const { createBuiltinBrowserTools } = require('../packages/backend/dist/modules/tools/executor/built-in/builtin-browser.js');
const browser = new BuiltInBrowserService();
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><body><input id="name" placeholder="姓名"><select id="choice"><option value="a">甲</option><option value="b">乙</option></select><button id="target" onclick="this.textContent='clicked'">目标</button><button id="add" onclick="const b=document.createElement('button');b.textContent='新增';document.body.prepend(b)">插入按钮</button><div style="height:2000px">scroll</div></body></html>`);
});
(async () => {
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${fixture.address().port}`;
    const first = await browser.navigate(url);
    const target = first.elements.find(el => el.text === '目标').index;
    const add = first.elements.find(el => el.text === '插入按钮').index;
    const input = first.elements.find(el => el.hint === '姓名').index;
    const select = first.elements.find(el => el.tag === 'select').index;
    await browser.action(first.pageId, 'click', { index: add });
    let snap = await browser.action(first.pageId, 'click', { index: target });
    assert.equal(snap.elements.find(el => el.index === target).text, 'clicked', 'dynamic insertion must not retarget an index');
    await browser.action(first.pageId, 'fill', { index: input, text: '初始内容' });
    snap = await browser.action(first.pageId, 'type', { text: ' + 输入' });
    assert.equal(snap.elements.find(el => el.index === input).text, '初始内容 + 输入');
    await browser.action(first.pageId, 'key', { key: 'Tab' });
    await browser.action(first.pageId, 'select', { index: select, text: '乙' });
    const page = browser.pages.get(first.pageId).page;
    assert.equal(await page.locator('#choice').inputValue(), 'b');
    await assert.rejects(browser.action(first.pageId, 'select', { index: select, value: 'missing' }), /Timeout/);
    const [tool] = createBuiltinBrowserTools(() => browser);
    const ready = await browser.snapshot(first.pageId);
    const result = await tool.execute({ action: 'fill', pageId: first.pageId, observationId: ready.observationId, index: input, text: 'AI 工具调用' }, {});
    assert.equal(result.success, true);
    assert.equal(await page.locator('#name').inputValue(), 'AI 工具调用');
    assert.equal((await tool.execute({ action: 'fill', pageId: first.pageId, observationId: ready.observationId, index: input, text: 'stale replay' }, {})).success, false);
    const beforeNavigation = await browser.snapshot(first.pageId);
    await page.reload();
    assert.equal((await tool.execute({ action: 'click', pageId: first.pageId, observationId: beforeNavigation.observationId, index: target }, {})).success, false, 'old element numbers must not survive document navigation');
    await page.locator('#target').evaluate(el => el.remove());
    await assert.rejects(browser.action(first.pageId, 'click', { index: target }), /不存在或已消失/);
    await browser.action(first.pageId, 'scroll', { dy: 500 });
    assert.ok(await page.evaluate(() => window.scrollY > 0));
    console.log('PASS real browser: stable element IDs, missing element rejection, fill/type/key, select by label, failed select rejection, AI tool dispatch, scroll.');
  } finally {
    await browser.closeAll();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
