const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const backend = process.env.WING_TEST_BACKEND || path.resolve('packages/backend');
const { NativeOfficeService } = require(
  path.join(backend, 'dist/modules/tools/files/native-office.service.js'),
);
const { OfficeService } = require(path.join(backend, 'dist/modules/tools/files/office.service.js'));
const dir = path.resolve('build/office-ime-qa');
fs.mkdirSync(dir, { recursive: true });
process.env.SKYALYTICWING_DATA_DIR = path.join(dir, 'data');
const security = {
    isPathAllowed: (p) => path.resolve(p) === dir || path.resolve(p).startsWith(dir + path.sep),
  },
  service = new NativeOfficeService(security),
  office = new OfficeService(security);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error('Timed out');
}
let browser, page;
const evidence = { timings: [], tests: [] };
(async () => {
  let context;
  async function freshBrowser() {
    await browser?.close();
    browser = await chromium.launch({
      channel: process.env.WING_TEST_BROWSER || 'msedge',
      headless: true,
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  }
  let cdp;
  const docs = [];
  async function ime(text) {
    await cdp.send('Input.imeSetComposition', {
      text: 'pinyin',
      selectionStart: 6,
      selectionEnd: 6,
    });
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await cdp.send('Input.insertText', { text });
    await sleep(200);
  }
  for (const format of ['docx', 'xlsx', 'pptx']) {
    await freshBrowser();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    let startupError;
    page.on('pageerror', (e) => {
      startupError = e;
      console.log('ERROR', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) console.log('RUNTIME', m.text());
    });
    const file = await office.create(dir, '中文输入-' + format, format),
      s = await service.open(file.path);
    docs.push({ file, s });
    const start = Date.now();
    await page.goto(s.url);
    await wait(() => {
      if (startupError) throw startupError;
      const state = service.state(s.id);
      if (state.error) throw Error(state.error);
      return state.ready;
    });
    evidence.timings.push({ format, openMs: Date.now() - start });
    console.log('READY', format, evidence.timings.at(-1));
    // Wait for the native canvas to finish its first layout before pixel clicks.
    await sleep(1000);
    if (format === 'docx') {
      await page.locator('#qtcanvas').click({ position: { x: 390, y: 230 } });
      await sleep(150);
      await page.keyboard.press('Control+End');
      await page.keyboard.type('ABC123 ');
      await ime('中文输入验证');
      await cdp.send('Input.imeSetComposition', {
        text: 'quxiao',
        selectionStart: 6,
        selectionEnd: 6,
      });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await ime('，第二次。');
    } else if (format === 'xlsx') {
      await page.locator('#qtcanvas').click({ position: { x: 138, y: 152 } });
      await sleep(150);
      await ime('表格中文');
      await page.keyboard.press('Enter');
      await service.live(file.path, 'set_cell', { row: 1, column: 0, value: '12' });
      await service.live(file.path, 'set_cell', { row: 2, column: 0, value: '=A2*2' });
    } else {
      await service.live(file.path, 'insert_text', { text: '演示文字' });
      await sleep(250);
      await page.locator('#qtcanvas').dblclick({ position: { x: 316, y: 296 } });
      await sleep(150);
      await page.keyboard.press('End');
      await ime('，中文幻灯片');
      await page.keyboard.press('Escape');
    }
    await sleep(200);
    const before = service.state(s.id).savedAt;
    service.command(s.id, 'save');
    await wait(() => service.state(s.id).savedAt > before, 15000);
    const read = await office.read(file.path);
    const text = read.sections.flatMap((s) => s.fields.map((f) => f.value)).join('');
    console.log('TEXT', format, text);
    if (format === 'docx') {
      assert.ok(text.includes('ABC123 中文输入验证，第二次。'));
      assert.ok(!text.includes('pinyin'));
      assert.ok(!text.includes('quxiao'));
    }
    if (format === 'xlsx') {
      assert.ok(text.includes('表格中文'));
      const XLSX = require('../packages/backend/node_modules/xlsx');
      const wb = XLSX.readFile(file.path);
      assert.equal(wb.Sheets[wb.SheetNames[0]].A3.v, 24);
    }
    if (format === 'pptx') assert.ok(text.includes('中文幻灯片'));
    await page.locator('#qtcanvas').click({
      button: 'right',
      position: format === 'pptx' ? { x: 100, y: 200 } : { x: 390, y: 230 },
    });
    await page.locator('#office-context-menu').waitFor({ state: 'visible', timeout: 10000 });
    const labels = await page.locator('#office-context-menu').innerText();
    assert.match(labels, /[\u4e00-\u9fff]/);
    assert.ok(!labels.includes('.uno:'));
    console.log('MENU', format, labels.slice(0, 400));
    await page.screenshot({ path: path.join(dir, format + '-ime-menu.png') });
    if (format === 'pptx') {
      assert.ok(labels.includes('新建幻灯片'));
      await page
        .locator('#office-context-menu button')
        .filter({ hasText: /新建幻灯片/ })
        .click();
      await sleep(400);
      const prior = service.state(s.id).savedAt;
      service.command(s.id, 'save');
      await wait(() => service.state(s.id).savedAt > prior, 15000);
      assert.equal(
        (await office.read(file.path)).sections.length,
        2,
        'context menu creates a slide',
      );
    } else await page.keyboard.press('Escape');
    if (format === 'docx') {
      await page.locator('#menus > details').first().locator('summary').first().click();
      await page
        .locator('#menus button')
        .filter({ hasText: /^另存为\(/ })
        .first()
        .click();
      const copyName = '菜单副本-' + Date.now() + '.docx';
      await page.locator('dialog input').fill(copyName);
      await page.locator('dialog button').filter({ hasText: '保存' }).click();
      await wait(() => fs.existsSync(path.join(dir, copyName)), 15000);
      assert.ok(
        JSON.stringify(await office.read(path.join(dir, copyName))).includes('中文输入验证'),
      );
    }
    evidence.tests.push({ format, text, menu: labels });
    await page.close();
    service.release(s.id);
  }
  await freshBrowser();
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const reopened = await service.open(docs[0].file.path);
  const start = Date.now();
  await page.goto(reopened.url);
  await wait(() => service.state(reopened.id).ready);
  evidence.timings.push({ reopenMs: Date.now() - start });
  await sleep(1000);
  await page.locator('#qtcanvas').click({ position: { x: 390, y: 230 } });
  await page.keyboard.press('Control+End');
  await ime('重新打开继续');
  const before = service.state(reopened.id).savedAt;
  service.command(reopened.id, 'save');
  await wait(() => service.state(reopened.id).savedAt > before, 15000);
  assert.ok(JSON.stringify(await office.read(docs[0].file.path)).includes('重新打开继续'));
  await page.close();
  service.release(reopened.id);
  fs.writeFileSync(path.join(dir, 'ime-evidence.json'), JSON.stringify(evidence, null, 2));
  // Exercise the user's legacy PPT through a copy; preserve the original exactly.
  const original = 'D:/新建文件夹/新建 PPT 演示文稿.ppt';
  if (fs.existsSync(original)) {
    const bytes = fs.readFileSync(original);
    const legacy = path.join(dir, '旧版副本-' + Date.now() + '.ppt');
    fs.writeFileSync(legacy, bytes, { flag: 'wx' });
    await freshBrowser();
    let s = await service.open(legacy);
    page = await context.newPage();
    await page.goto(s.url);
    await wait(() => service.state(s.id).ready);
    await service.live(legacy, 'insert_text', { text: '旧版演示文稿验证' });
    const prior = service.state(s.id).savedAt;
    service.command(s.id, 'save');
    await wait(() => service.state(s.id).savedAt > prior, 15000);
    await page.close();
    service.release(s.id);
    // Reopening in a fresh browser also verifies persistence across app restarts
    // and releases test-only compiled modules on memory-constrained machines.
    await freshBrowser();
    s = await service.open(legacy);
    page = await context.newPage();
    await page.goto(s.url);
    await wait(() => service.state(s.id).ready);
    await sleep(500);
    await page.locator('#qtcanvas').click({ button: 'right', position: { x: 100, y: 200 } });
    await page.locator('#office-context-menu').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('#office-context-menu').innerText(), /新建幻灯片/);
    await page.screenshot({ path: path.join(dir, 'legacy-ppt-menu.png') });
    assert.ok(fs.readFileSync(original).equals(bytes), 'user original preserved');
    evidence.tests.push({ format: 'ppt', savedAndReopened: true, originalUnchanged: true });
    await page.close();
    service.release(s.id);
  }
  fs.writeFileSync(path.join(dir, 'ime-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS', JSON.stringify(evidence.timings));
})()
  .catch(async (e) => {
    console.error(e);
    await page?.screenshot({ path: path.join(dir, 'ime-failure.png') }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    service.onModuleDestroy();
  });
