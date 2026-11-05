// Real ProjectPanel, editor and CSS; isolated HTTP fixture, no user files or Office engine.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createServer } = require('node:http'), { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..'), qa = path.join(root, 'build/workspace-resize-qa');
fs.mkdirSync(qa, { recursive: true });
const source = path.join(root, 'packages/frontend/src').replaceAll('\\', '/');
const { build } = createRequire(require.resolve('../packages/frontend/node_modules/vite'))('esbuild');
let browser, server, content = '正在编辑的文档\n', reads = 0;
const checks = [], errors = [];
(async () => {
  const fixture = `import React from 'react';import {createRoot} from '${source}/../node_modules/react-dom/client';
import {MemoryRouter} from 'react-router-dom';import {ProjectPanel} from '${source}/components/project/ProjectPanel';
import {useProjectPanel} from '${source}/stores/project-panel-store';import '${source}/i18n';
useProjectPanel.setState({open:true,initialized:true,projectDir:'C:/resize-qa',currentFile:'C:/resize-qa/note.txt',openFiles:['C:/resize-qa/note.txt'],initProjectDir:async()=>{}});
function App(){const [draft,setDraft]=React.useState('保留对话草稿');return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><header style={{height:48,flexShrink:0}}>Wing 工作区 <button onClick={()=>useProjectPanel.getState().setOpen(true)}>打开工作区</button></header><div style={{display:'flex',flex:1,minHeight:0}}><aside data-testid="navigation" style={{width:200,flexShrink:0,background:'var(--bg-secondary)',padding:16}}>项目与会话</aside><div className="sky-chat-workspace flex flex-row h-full w-full min-w-0 overflow-hidden" style={{flex:1}}><div className="chat-view flex flex-col h-full flex-1 min-w-0 overflow-hidden" style={{padding:16}}><p>对话区域</p><textarea aria-label="对话草稿" value={draft} onChange={e=>setDraft(e.target.value)}/></div><ProjectPanel/></div></div></div>};
createRoot(document.getElementById('root')).render(<MemoryRouter><App/></MemoryRouter>);`;
  fs.writeFileSync(path.join(qa, 'fixture.tsx'), fixture);
  await build({ entryPoints:[path.join(qa,'fixture.tsx')], outfile:path.join(qa,'fixture.js'), bundle:true,format:'esm',jsx:'automatic',alias:{'@':source},define:{'import.meta.env':'{}','process.env.NODE_ENV':'"production"'},loader:{'.css':'empty'},nodePaths:[path.join(root,'packages/frontend/node_modules')] });
  const cssFile = fs.readdirSync(path.join(root,'packages/frontend/dist/assets')).find(n=>/^index-.*\.css$/.test(n));
  const styles = fs.readFileSync(path.join(root,'packages/frontend/dist/assets',cssFile),'utf8') + '\n' + fs.readFileSync(path.join(source,'styles/workspace.css'),'utf8');
  server = createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/fixture.js') {res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(qa,'fixture.js')));return;}
    if (url.pathname === '/styles.css') {res.setHeader('Content-Type','text/css');res.end(styles);return;}
    if (!url.pathname.startsWith('/api/')) {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><body class="light"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
    let body='';for await (const chunk of req)body+=chunk;
    let result={};
    if(url.pathname==='/api/files/read'){reads++;result={content,size:Buffer.byteLength(content),revision:'qa'};}
    else if(url.pathname==='/api/files/list')result=[{name:'note.txt',type:'file',size:100}];
    else if(url.pathname==='/api/files/write'){content=JSON.parse(body).content;result={revision:'qa'};}
    else if(url.pathname==='/api/files/projects')result=[];
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const panel=page.locator('.sky-project-panel'), handle=page.getByRole('separator',{name:'调整工作区宽度'}), chat=page.locator('.chat-view'), work=page.locator('.sky-chat-workspace');
  await page.locator('.cm-content').waitFor();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('拖拽后继续保留');
  await page.evaluate(()=>{window.editorBeforeResize=document.querySelector('.cm-content');const frame=document.createElement('iframe');frame.id='qa-frame';frame.srcdoc='<input value="保留嵌入页面状态">';frame.style.cssText='position:absolute;top:200px;right:20px;width:60%;height:150px';document.querySelector('.sky-project-panel').append(frame);});
  const frame=page.frameLocator('#qa-frame');await frame.locator('input').fill('已修改的嵌入页面');
  const closeTo=(actual,expected)=>assert.ok(Math.abs(actual-expected)<3,`${actual} != ${expected}`);
  async function start(){const r=await handle.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+260);await page.mouse.down();return r;}
  async function width(){return (await panel.boundingBox()).width;}
  async function dragTo(cssWidth){const r=await work.boundingBox(),scale=await work.evaluate(e=>e.getBoundingClientRect().width/e.clientWidth);await start();await page.mouse.move(r.x+r.width-cssWidth*scale+3.5*scale,r.y+260,{steps:12});await page.mouse.up();await page.waitForTimeout(80);}
  async function expanded(){return panel.evaluate(e=>e.classList.contains('is-expanded'));}
  async function sameState(){assert.equal(await page.evaluate(()=>window.editorBeforeResize===document.querySelector('.cm-content')),true);assert.ok((await page.locator('.cm-content').innerText()).includes('拖拽后继续保留'));assert.equal(await frame.locator('input').inputValue(),'已修改的嵌入页面');assert.equal(await page.getByLabel('对话草稿').inputValue(),'保留对话草稿');}

  await dragTo(850);closeTo(await width(),850);assert.equal(await expanded(),false);
  checks.push('拖拽宽度超过旧的 640 像素限制并持久化');
  await page.screenshot({path:path.join(qa,'wide-split.png')});
  const area=await work.boundingBox();await start();
  assert.equal(await page.locator('#qa-frame').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  await page.mouse.move(area.x+210,area.y+260,{steps:12});await page.waitForTimeout(80);
  assert.equal(await expanded(),true);closeTo(await width(),area.width);assert.equal(await chat.evaluate(e=>getComputedStyle(e).visibility),'hidden');
  await page.screenshot({path:path.join(qa,'drag-expanded.png')});
  await page.mouse.move(area.x+420,area.y+260,{steps:10});await page.mouse.up();await page.waitForTimeout(80);
  assert.equal(await expanded(),false);assert.equal(await chat.evaluate(e=>getComputedStyle(e).visibility),'visible');
  await sameState();checks.push('同一次拖动越过阈值展开、反向拖回；跨 iframe 拖动不断开，内容不重载');

  const docked=await width();await page.getByRole('button',{name:'展开工作区',exact:true}).click();
  await start();await page.mouse.move(area.x+450,area.y+260,{steps:10});await page.mouse.up();await page.waitForTimeout(80);assert.equal(await expanded(),false);
  await page.getByRole('button',{name:'展开工作区',exact:true}).click();await page.getByRole('button',{name:'还原面板宽度',exact:true}).click();
  await sameState();assert.ok(await width()>640);checks.push('展开状态可重新拖回分栏，展开/还原按钮有效');

  const before=await width();await start();await page.mouse.move(area.x+600,area.y+260,{steps:6});await page.keyboard.press('Escape');await page.mouse.up();closeTo(await width(),before);
  assert.equal(await page.evaluate(()=>document.body.dataset.wingWorkspaceResizing),undefined);
  await start();await page.mouse.move(area.x+650,area.y+260,{steps:5});await handle.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();closeTo(await width(),before);
  checks.push('Esc 和指针取消恢复拖动前宽度并释放捕获');

  await start();await page.mouse.move(area.x+area.width-120,area.y+260,{steps:10});await page.waitForTimeout(80);
  assert.equal(await panel.getAttribute('data-collapsing'),'true');closeTo(await width(),0);
  await page.mouse.move(area.x+area.width-500,area.y+260,{steps:10});await page.mouse.up();await page.waitForTimeout(80);
  assert.equal(await panel.getAttribute('data-collapsing'),null);assert.equal(await panel.isVisible(),true);assert.ok(await width()>490);
  await dragTo(830);await start();await page.mouse.move(area.x+area.width-100,area.y+260,{steps:10});await page.mouse.up();await page.waitForTimeout(80);
  assert.equal(await panel.isVisible(),false);assert.equal(await page.evaluate(()=>document.body.dataset.wingWorkspaceResizing),undefined);
  await page.getByRole('button',{name:'打开工作区',exact:true}).click();closeTo(await width(),830);await sameState();
  await start();await page.mouse.move(area.x+area.width-100,area.y+260,{steps:10});await page.keyboard.press('Escape');await page.mouse.up();closeTo(await width(),830);assert.equal(await panel.isVisible(),true);
  checks.push('右拖到阈值收起、同次反向拖动取消收起，重开恢复原宽度，Esc 可取消收起');

  await handle.focus();await page.keyboard.press('End');assert.equal(await expanded(),true);await page.keyboard.press('ArrowRight');assert.equal(await expanded(),false);
  await page.keyboard.press('Home');closeTo(await width(),280);await page.keyboard.press('ArrowLeft');closeTo(await width(),312);
  checks.push('键盘调宽、展开和还原');
  await dragTo(830);await page.getByRole('button',{name:'返回对话',exact:true}).click();await page.getByRole('button',{name:'打开工作区',exact:true}).click();closeTo(await width(),830);await sameState();
  checks.push('收起再打开保留宽度、文档与对话草稿');

  await page.setViewportSize({width:650,height:900});await page.waitForTimeout(120);assert.equal(await expanded(),true);closeTo(await width(),450);
  await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(120);assert.equal(await expanded(),false);closeTo(await width(),830);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('缩小窗口自动适应、放大窗口恢复分栏，不产生页面横向溢出');
  await page.evaluate(()=>document.body.style.zoom='0.8');await page.waitForTimeout(120);await dragTo(900);closeTo(await width(),720);
  await page.evaluate(()=>document.body.style.zoom='1');await page.waitForTimeout(120);closeTo(await width(),900);
  checks.push('界面缩放时拖拽距离正确');
  await sameState();assert.equal(reads,1);await page.reload();await page.locator('.cm-content').waitFor();closeTo(await width(),900);
  checks.push('重开页面保留大于 640 像素的分栏宽度');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(qa,'results.json'),JSON.stringify({checks,errors,verifiedAt:new Date().toISOString()},null,2));
  console.log('PASS',checks);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.close();});
