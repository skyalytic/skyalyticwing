const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createServer } = require('node:http');
const { chromium } = require('playwright-core');
const root = process.cwd(), qa = path.resolve('build/file-workspace-2.0.1/qa');
fs.mkdirSync(qa, { recursive: true });
let browser, server;
(async () => {
  const { build } = createRequire(require.resolve('../packages/frontend/node_modules/vite'))('esbuild');
  const src = path.resolve('packages/frontend/src').replaceAll('\\', '/');
  fs.writeFileSync(path.join(qa, 'fixture.tsx'), `import React from 'react';import {createRoot} from '${src}/../node_modules/react-dom/client';
import {EditorView} from '${src}/components/workspace/EditorView';import {useProjectPanel} from '${src}/stores/project-panel-store';
import '${src}/i18n';import '${src}/styles/global.css';import '${src}/index.css';import '${src}/styles/workbench.css';import '${src}/styles/workspace.css';
document.body.className='light';useProjectPanel.setState({projectDir:'E:/项目',currentFile:'',openFiles:[],initialized:true});
createRoot(document.getElementById('root')).render(<main style={{height:'100vh',display:'flex',flexDirection:'column',containerType:'inline-size',containerName:'wing-panel'}}><EditorView/></main>);`);
  fs.writeFileSync(path.join(qa, 'fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  await build({entryPoints:[path.join(qa,'fixture.tsx')],outfile:path.join(qa,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',alias:{'@':src},
    define:{'import.meta.env':'{}','process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'},nodePaths:[path.resolve('packages/frontend/node_modules')]});
  const css=fs.readdirSync('packages/frontend/dist/assets').find(n=>n.startsWith('index-')&&n.endsWith('.css'));
  server=createServer((req,res)=>{const kind=req.url==='/fixture.js'?'js':req.url==='/styles.css'?'css':'html';
    res.setHeader('Content-Type',kind==='js'?'text/javascript':kind==='css'?'text/css':'text/html');
    res.end(fs.readFileSync(kind==='css'?path.resolve('packages/frontend/dist/assets',css):path.join(qa,'fixture.'+kind)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const files = new Map([['E:/项目/a.txt', 'First file'], ['E:/项目/b.txt','Second file']]);
  let names = [{name:'子目录',type:'dir'}, {name:'a.txt',type:'file'}, {name:'b.txt',type:'file'}];
  const calls=[];
  await page.route('**/api/**', async route => {
    const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();calls.push({url:url.pathname,body});
    let data={};
    if(url.pathname.endsWith('/files/list')) data=url.searchParams.get('path')==='E:/项目'?names:[];
    else if(url.pathname.endsWith('/files/read')) data={content:files.get(url.searchParams.get('path'))||'',size:30,revision:'r1'};
    else if(url.pathname.endsWith('/files/create-entry')) { data={path:body.directory+'/'+body.name};names.push({name:body.name,type:body.type});files.set(data.path,''); }
    else if(url.pathname.endsWith('/files/write')) { files.set(body.path,body.content);data={revision:'r2'}; }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
  });
  const failures=[];page.on('pageerror',e=>failures.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByText('a.txt',{exact:true}).click();
  const editor=page.locator('.cm-editor:visible .cm-content');await editor.click();await page.keyboard.press('Control+End');await page.keyboard.type(' edited by keyboard');
  await page.getByText('b.txt',{exact:true}).click();await page.getByRole('tab',{name:'a.txt',exact:true}).click();
  assert.ok((await editor.innerText()).includes('edited by keyboard'));
  await page.getByText('子目录',{exact:true}).click({button:'right'});
  await page.getByRole('menu').getByRole('button',{name:'打开所在文件夹',exact:true}).click();
  assert.ok(calls.some(c=>c.body?.action==='reveal' && c.body.path==='E:/项目/子目录'));
  await page.getByRole('button',{name:'新建文件夹',exact:true}).click();await page.getByRole('textbox',{name:'名称',exact:true}).fill('新子目录');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.getByText('新子目录',{exact:true}).waitFor();
  await page.getByRole('button',{name:'新建文件',exact:true}).click();await page.getByRole('textbox',{name:'名称',exact:true}).fill('工作笔记.txt');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.getByRole('tab',{name:'工作笔记.txt',exact:true}).waitFor();await editor.click();await page.keyboard.type('New file content');
  await page.screenshot({path:path.join(qa,'file-tabs-wide.png')});
  await page.getByRole('button',{name:'关闭文件 工作笔记.txt',exact:true}).click();await page.getByRole('tab',{name:'工作笔记.txt',exact:true}).waitFor({state:'detached'});
  assert.equal(files.get('E:/项目/工作笔记.txt'),'New file content');
  await page.setViewportSize({width:380,height:760});await page.getByRole('tab',{name:'a.txt',exact:true}).click();
  await page.screenshot({path:path.join(qa,'file-tabs-narrow.png')});
  assert.ok(await editor.isVisible());assert.deepEqual(failures,[]);
  console.log('Real keyboard editing, folder context action, file/folder creation, file tabs and narrow layout PASS');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.close();});
