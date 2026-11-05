const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { NativeOfficeService } = require('../packages/backend/dist/modules/tools/files/native-office.service.js');
const dir = path.resolve('build/file-workspace-2.0.1/qa');
fs.mkdirSync(dir, { recursive: true });
process.env.SKYALYTICWING_DATA_DIR = path.join(dir, 'data');
const service = new NativeOfficeService({ isPathAllowed: p => path.resolve(p).startsWith(dir + path.sep) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, timeout = 90000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await fn()) return; await sleep(200); } throw Error('Timed out'); }
let browser, activePage;
(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const ext of (process.env.OFFICE_FORMATS || 'docx,xlsx,pptx,doc,xls,ppt').split(',')) {
    const file = path.join(dir, `空白中文 ${Date.now()}.${ext}`);
    fs.writeFileSync(file, '', { flag: 'wx' });
    let session = await service.open(file);
    let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    activePage=page;
    page.on('pageerror', e => console.log(ext, 'pageerror', e.message));
    await page.goto(session.url, { waitUntil: 'commit' });
    await wait(() => { const s = service.state(session.id); if (s.error) throw Error(s.error); return s.ready; });
    if (ext.startsWith('xls')) await service.live(file, 'set_cell', { row: 0, column: 0, value: '=12+8' });
    else await service.live(file, 'insert_text', { text: '旧格式与空白文档保存验证' });
    await sleep(1000);
    const before = service.state(session.id).savedAt;
    service.command(session.id, 'save');
    await wait(() => { const s = service.state(session.id); if (s.error) throw Error(s.error); return s.savedAt > before && !s.dirty; }, 20000);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 100, `${ext}: saved actual document`);
    assert.equal(bytes.subarray(0, ext.endsWith('x') ? 2 : 8).toString('hex'), ext.endsWith('x') ? '504b' : 'd0cf11e0a1b11ae1');
    await page.screenshot({ path: path.join(dir, `office-${ext}-saved.png`) });
    await page.close(); service.release(session.id);
    session = await service.open(file);
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    activePage=page;
    page.on('console',m=>{if(m.type()==='error')console.log(ext,m.text().slice(0,500));});
    page.on('pageerror',e=>console.log(ext,e.message));
    await page.goto(session.url, { waitUntil: 'commit' });
    await wait(() => { const s = service.state(session.id); if (s.error) throw Error(s.error); return s.ready; });
    await page.screenshot({ path: path.join(dir, `office-${ext}-reopened.png`) });
    await page.close(); service.release(session.id);
    console.log(ext + ' blank → edit → save → reopen PASS (' + bytes.length + ' bytes)');
  }
})().catch(async e => { console.error(e); if(activePage && !activePage.isClosed()){await activePage.screenshot({path:path.join(dir,'office-failure.png')});console.log(await activePage.locator('body').innerText());} process.exitCode = 1; }).finally(async () => { await browser?.close(); service.onModuleDestroy(); });
