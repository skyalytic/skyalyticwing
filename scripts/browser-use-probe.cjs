// Isolated local Webview2 acceptance fixture; no user profile, account or external website.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve(__dirname, '../build/browser-use-probe');
fs.mkdirSync(out, { recursive: true });
const fixture = `<!doctype html><meta charset="utf-8"><title>Browser Use fixture</title>
<style>body{font:18px system-ui;margin:24px}input,button{font:inherit;padding:8px;margin:8px}</style>
<label for="query">联系人姓名</label><input id="query"><button id="search">查询</button>
<p id="result">等待查询</p><button disabled>不可点击</button><a href="/second" target="_blank">打开详情</a>
<div id="shadow"></div><script>
const root=document.querySelector('#shadow').attachShadow({mode:'open'});
root.innerHTML='<label for="s">影子输入</label><input id="s">';
document.querySelector('#search').onclick=e=>{document.querySelector('#result').textContent='查询中';setTimeout(()=>document.querySelector('#result').textContent='联系人：'+document.querySelector('#query').value+'；可信点击：'+e.isTrusted,200)};
</script>`;
async function run() {
  const results = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (!window.__TAURI_INTERNALS__) await sleep(25);
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  const cmd = (op, args = {}, session_id = 'browser-use-probe') => invoke('native_browser_command', { command: { op, args, session_id } });
  const check = (name, ok, detail) => { results.push({ name, passed: !!ok, detail }); if (!ok) throw Error(name); };
  const snap = (args = {}) => cmd('snapshot', { screenshot: false, waitForLoad: false, ...args });
  try {
    await cmd('navigate', { pageId: 'use-page', url: 'http://127.0.0.1:19112/fixture' });
    await invoke('native_browser_bounds', { bounds: { x: 0, y: 100, width: 1100, height: 600, visible: true, page_id: 'use-page' } });
    let s;
    for (let i = 0; i < 30; i++) { s = await snap(); if (s.title === 'Browser Use fixture' && s.elements.length) break; await sleep(100); }
    check('DOM-only native observation', s.title === 'Browser Use fixture' && s.screenshot === '');
    let query = s.elements.find(e => e.hint === '联系人姓名' && e.tag === 'input');
    check('Accessible label and role', query?.role === 'textbox');
    await cmd('fill', { index: query.index, text: '文宇' });
    s = await snap();
    check('Exact Chinese field value and focus', s.activeElement?.text === '文宇' && s.activeElement?.index === query.index);
    await cmd('fill', { index: query.index, text: '' });
    s = await snap();
    check('Empty fill clears field', s.activeElement?.text === '');
    await cmd('fill', { index: query.index, text: '文宇' });
    await cmd('click', { index: s.elements.find(e => e.text === '查询').index });
    for (let i = 0; i < 30; i++) { s = await snap(); if (s.pageText.includes('联系人：文宇')) break; await sleep(100); }
    check('Trusted click and async result', s.pageText.includes('联系人：文宇；可信点击：true'));
    const disabled = s.elements.find(e => e.text === '不可点击');
    let rejected = false;
    try { await cmd('click', { index: disabled.index }); } catch { rejected = true; }
    check('Disabled input rejected', disabled.disabled && rejected);
    const shadow = s.elements.find(e => e.hint === '影子输入' && e.tag === 'input');
    await cmd('fill', { index: shadow.index, text: '独立页面' });
    s = await snap();
    check('Open Shadow DOM field', s.activeElement?.text === '独立页面');
    let foreignRejected = false;
    try { await cmd('snapshot', { pageId: 'use-page' }, 'other-session'); } catch { foreignRejected = true; }
    check('Cross-session isolation', foreignRejected);
    await cmd('navigate', { pageId: 'inactive-test', url: 'about:blank' });
    let inactiveRejected = false;
    try { await cmd('click', { pageId: 'use-page', index: query.index, requireActive: true }); } catch { inactiveRejected = true; }
    check('Inactive tab input rejected', inactiveRejected);
    await cmd('close', { pageId: 'inactive-test' });
    await cmd('activate', { pageId: 'use-page' });
    s = await cmd('snapshot', { screenshot: true });
    check('Explicit visual screenshot', s.screenshot?.length > 1000);
    await fetch('/image', { method: 'POST', body: s.screenshot });
    const popup = await cmd('click', { index: s.elements.find(e => e.text === '打开详情').index });
    const tabs = await cmd('state');
    check('Popup remains in same built-in browser', tabs.tabs.length === 2 && popup?.pageId && popup.pageId !== 'use-page');
    await cmd('close', { all: true });
    check('Clean close', (await cmd('state')).tabs.length === 0);
  } catch (error) { results.push({ name: 'error', passed: false, detail: String(error) }); }
  await fetch('/report', { method: 'POST', body: JSON.stringify({ results }) });
  await invoke('probe_finish');
}
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && ['/report', '/image'].includes(req.url)) {
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      if (req.url === '/report') fs.writeFileSync(path.join(out, 'results.json'), body);
      else fs.writeFileSync(path.join(out, 'native-page.jpg'), Buffer.from(body, 'base64'));
      res.end('ok');
    }); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url === '/fixture' ? fixture : req.url === '/second' ? '<title>Details</title><p>文宇</p>' : `<!doctype html><title>Probe</title><script>(${run.toString()})();</script>`);
});
server.listen(19112, '127.0.0.1', () => console.log('Browser Use probe ready'));
