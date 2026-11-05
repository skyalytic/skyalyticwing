// Real UI components + real local controllers / files / PTY, with an isolated data directory.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {createServer}=require('http'),{createRequire}=require('module'),{execFileSync}=require('child_process');
const {chromium}=require('playwright-core');
const qa=path.resolve('build/workspace-2.0.1-qa');fs.mkdirSync(qa,{recursive:true});
const data=fs.mkdtempSync(path.join(os.tmpdir(),'wing-workspace-click-')),project=path.join(data,'project');fs.mkdirSync(project);
process.env.SKYALYTICWING_DATA_DIR=path.join(data,'data');
const req=createRequire(path.resolve('packages/backend/package.json'));req('reflect-metadata');
const mod=p=>require(path.resolve('packages/backend/dist/modules',p));
const {TerminalService}=mod('terminal/terminal.service.js');
const {FilesService}=mod('tools/files/files.service.js');
const {FilesController}=mod('tools/files/files.controller.js');
const {DocumentHistoryController}=mod('tools/files/document-history.controller.js');
const {PermissionController}=mod('core/security/permission.controller.js');
const {YoloClassifierService}=mod('tools/executor/yolo-classifier.service.js');
const history=mod('tools/files/document-history.js');
const security={isPathAllowed:p=>path.resolve(p)===project||path.resolve(p).startsWith(project+path.sep)};
let cfg={security:{yolo:'ask'},general:{projectDir:project}};
const config={get:k=>cfg[k]||{},set:(k,v)=>{cfg[k]=v;},save:()=>fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(cfg))};
const terminal=new TerminalService(security),files=new FilesService(security,config),fileApi=new FilesController(files),changeApi=new DocumentHistoryController(security);
const permissions=new PermissionController(security,{listCommandRules:()=>[]},new YoloClassifierService(),{getApprovalHistory:()=>[],approvePendingForFullAccess:()=>{}},config,{info:()=>{}});
const note=path.join(project,'工作笔记.txt');fs.writeFileSync(note,'第一版\n');
const section=process.env.WING_QA_SECTION||'all';
const roundFile=path.join(project,'三轮对话.txt'),roundStart=Date.now();fs.writeFileSync(roundFile,'第一轮之前');
for(const text of ['第一轮','第二轮','第三轮'])history.withDocumentSession('qa-rounds',()=>history.trackDocumentMutationSync(roundFile,()=>fs.writeFileSync(roundFile,text)));
let savedMessages;
let browser,server;const checks=[],errors=[];let activePage;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await wait(100);}throw Error('Timed out: '+label);}
(async()=>{
  const {Document,Packer,Paragraph}=req('docx');
  const office=path.join(project,'方案.docx');
  fs.writeFileSync(office,await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('项目目标：初稿')]}]})));
  const updated=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('项目目标：完成交付')]}]}));
  history.trackDocumentMutationSync(office,()=>fs.writeFileSync(office,updated));
  const {build}=createRequire(require.resolve('../packages/frontend/node_modules/vite'))('esbuild');
  const src=path.resolve('packages/frontend/src').replaceAll('\\','/');
  fs.writeFileSync(path.join(qa,'fixture.tsx'),`import React from 'react';import {createRoot} from '${src}/../node_modules/react-dom/client';
import {TabBar} from '${src}/components/workspace/TabBar';import {EditorView} from '${src}/components/workspace/EditorView';import {TerminalView} from '${src}/components/workspace/TerminalView';import {ChangesView} from '${src}/components/workspace/ChangesView';import {PermissionModePicker} from '${src}/components/chat/PermissionModePicker';import {useProjectPanel} from '${src}/stores/project-panel-store';import {useWorkspaceTabs} from '${src}/stores/workspace-tab-store';import '${src}/i18n';
import {MemoryRouter} from 'react-router-dom';import {MessageItem} from '${src}/components/chat/MessageItem';import {useChatStore} from '${src}/stores/chat-store';import {useSessionStore} from '${src}/stores/session-store';import {ToastContainer} from '${src}/components/ui/Toast';
useProjectPanel.setState({projectDir:${JSON.stringify(project)},initialized:true,open:true});
useSessionStore.setState({currentSessionId:'qa-rounds'});useChatStore.setState({messagesSessionId:'qa-rounds',messages:[0,1,2].flatMap(i=>[{id:'u'+i,role:'user',content:'第'+(i+1)+'轮要求',timestamp:${roundStart}+i},{id:'a'+i,role:'assistant',content:'已修改第'+(i+1)+'轮',timestamp:${roundStart}+i}])});
function App(){const active=useWorkspaceTabs(s=>s.activeTab),tabs=useWorkspaceTabs(s=>s.tabs),messages=useChatStore(s=>s.messages);const [chat,setChat]=React.useState(false);return <main style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',containerType:'inline-size',containerName:'wing-panel'}}><header style={{display:'flex',padding:8,gap:8}}><TabBar/><button onClick={()=>setChat(!chat)}>对话撤销验收</button></header>{chat?<section data-testid="round-messages" style={{flex:1,overflow:'auto',padding:24}}>{messages.map((m,i)=><MessageItem key={m.id} message={m} index={i}/>)}</section>:<><div style={{display:active==='editor'?'flex':'none',flex:1,minHeight:0,flexDirection:'column'}}><EditorView/></div>{tabs.some(t=>t.kind==='terminal')&&<div style={{display:active==='terminal'?'flex':'none',flex:1,minHeight:0}}><TerminalView/></div>}{active==='changes'&&<ChangesView/>}</>}<footer style={{padding:12,borderTop:'1px solid #cbd5e1'}}><PermissionModePicker/></footer><ToastContainer/></main>};createRoot(document.getElementById('root')).render(<MemoryRouter><App/></MemoryRouter>);`);
  await build({entryPoints:[path.join(qa,'fixture.tsx')],outfile:path.join(qa,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',alias:{'@':src},define:{'import.meta.env':'{}','process.env.NODE_ENV':'"production"'},loader:{'.css':'empty'},nodePaths:[path.resolve('packages/frontend/node_modules')]});
  const css=fs.readdirSync('packages/frontend/dist/assets').find(n=>n.startsWith('index-')&&n.endsWith('.css'));
  const styles=fs.readFileSync(path.join('packages/frontend/dist/assets',css),'utf8')+'\n'+fs.readFileSync('packages/frontend/node_modules/@xterm/xterm/css/xterm.css','utf8')+'\n'+fs.readFileSync('packages/frontend/src/styles/workspace.css','utf8');
  server=createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://localhost'),p=u.pathname;let result;
      if(!p.startsWith('/api/')){res.setHeader('Content-Type',p==='/fixture.js'?'text/javascript':p==='/styles.css'?'text/css':'text/html');res.end(p==='/fixture.js'?fs.readFileSync(path.join(qa,'fixture.js')):p==='/styles.css'?styles:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><body class="light"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
      let body='';for await(const chunk of req)body+=chunk;body=body?JSON.parse(body):{};
      const id=p.split('/')[3];
      if(p==='/api/permissions')result=permissions.getPermissions();
      else if(p==='/api/permissions/mode')result=permissions.switchMode(body);
      else if(p==='/api/files/list')result=files.list(u.searchParams.get('path'));
      else if(p==='/api/files/read')result=files.read(u.searchParams.get('path'));
      else if(p==='/api/files/write')result=await fileApi.write(body);
      else if(p==='/api/files/rollback')result=await fileApi.rollback(body);
      else if(p.includes('/sessions/')&&p.endsWith('/messages')){savedMessages=body.messages;result={success:true};}
      else if(p==='/api/files/create-entry')result=files.createEntry(body.directory,body.name,body.type);
      else if(p==='/api/files/changes')result=changeApi.list(u.searchParams.get('dir'));
      else if(p.startsWith('/api/files/changes/')){
        const cid=p.split('/')[4];
        if(p.endsWith('/restore'))result=await changeApi.restore(cid,body);
        else if(p.endsWith('/snapshot')){const snapshot=history.documentSnapshot(cid,u.searchParams.get('version'));res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition','attachment; filename="snapshot.docx"');res.end(fs.readFileSync(snapshot.path));return;}
        else result=await changeApi.detail(cid);
      }
      else if(p==='/api/terminal/open')result=terminal.open(body.cwd,body.cols,body.rows);
      else if(p.endsWith('/input'))result=terminal.input(id,body.text,body.raw);
      else if(p.endsWith('/output'))result=terminal.output(id,Number(u.searchParams.get('since')));
      else if(p.endsWith('/resize'))result=terminal.resize(id,body.cols,body.rows);
      else if(p.endsWith('/close'))result=terminal.close(id);
      else if(p==='/api/files/git-changes')result={isRepo:false,dir:project};
      else if(p==='/api/files/projects')result=[];
      else throw Error('Unhandled endpoint: '+p);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
    }catch(e){res.statusCode=e.getStatus?.()||500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:e.message}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'msedge',headless:true});const page=activePage=await browser.newPage({viewport:{width:1180,height:800},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  async function tab(label){await page.getByRole('button',{name:'打开工作区工具',exact:true}).click();await page.getByRole('button',{name:new RegExp(label)}).last().click();}
  if(section==='all'||section==='documents'){
  for(const [label,mode] of [['自动审批','auto'],['完全访问','yolo'],['手动审批','ask']]){
    await page.locator('.sky-permission-picker > button').click();await page.getByRole('menuitemradio',{name:new RegExp(label)}).click();await until(()=>cfg.security.yolo===mode,'permission saved');
  }checks.push('三档权限菜单切换与落盘');
  await page.getByText('工作笔记.txt',{exact:true}).click();const editor=page.locator('.cm-content');await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('第二版，增加内容\n');
  await until(()=>fs.readFileSync(note,'utf8').includes('第二版'),'editor autosave');checks.push('编辑器真实输入、自动保存并记录修改');
  await tab('文档变更');await page.locator('.sky-changes-list button').filter({hasText:'工作笔记.txt'}).first().click();await page.getByText('+第二版，增加内容',{exact:false}).waitFor();
  await page.screenshot({path:path.join(qa,'document-diff.png')});
  await page.getByRole('button',{name:'撤销此变更',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.ok(fs.readFileSync(note,'utf8').includes('第二版'));
  await page.getByRole('button',{name:'撤销此变更',exact:true}).click();await page.getByRole('button',{name:'确认恢复',exact:true}).click();await until(()=>fs.readFileSync(note,'utf8')==='第一版\n','undo');
  await page.getByRole('button',{name:'重做此变更',exact:true}).click();await page.getByRole('button',{name:'确认恢复',exact:true}).click();await until(()=>fs.readFileSync(note,'utf8').includes('第二版'),'redo');checks.push('差异显示、取消撤销、撤销与重做');
  fs.writeFileSync(note,'外部修改，不可覆盖');await page.getByRole('button',{name:'刷新',exact:true}).click();await until(()=>page.getByRole('button',{name:'撤销此变更',exact:true}).isDisabled(),'conflict');assert.equal(fs.readFileSync(note,'utf8'),'外部修改，不可覆盖');checks.push('冲突时禁止覆盖');
  await page.locator('.sky-changes-list button').filter({hasText:'方案.docx'}).click();await page.getByText('+项目目标：完成交付',{exact:false}).waitFor();const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载修改前版本',exact:true}).click();await (await download).saveAs(path.join(qa,'before.docx'));assert.ok(fs.statSync(path.join(qa,'before.docx')).size>0);checks.push('Office 文字差异和完整快照下载');
  await page.screenshot({path:path.join(qa,'office-diff.png')});
  await page.getByRole('button',{name:'Git',exact:true}).click();await page.getByText('该目录不是 git 仓库',{exact:true}).waitFor();await page.getByRole('button',{name:'文档历史',exact:true}).click();checks.push('Git 子页');
  }
  if(section==='all'||section==='terminal'){
  await tab('终端');const input=page.getByRole('textbox',{name:'终端输入',exact:true}).first();await input.waitFor();await wait(600);await input.focus();await page.keyboard.type('$wingProbe = 620 + 83; Write-Output $wingProbe');await page.keyboard.press('Enter');
  await until(()=>page.locator('.xterm-rows').innerText().then(t=>t.includes('703')),'pty output');
  await page.keyboard.type('Write-Output ($wingProbe + 8)');await page.keyboard.press('Enter');await until(()=>page.locator('.xterm-rows').innerText().then(t=>t.includes('711')),'persistent shell');
  await page.keyboard.type('Start-Sleep -Seconds 20');await page.keyboard.press('Enter');await wait(300);await page.keyboard.press('Control+c');await wait(400);await page.keyboard.type('Write-Output (1900 + 73)');await page.keyboard.press('Enter');await until(()=>page.locator('.xterm-rows').innerText().then(t=>/^\s*1973\s*$/m.test(t)),'interrupt');
  await page.keyboard.type('Set-Content -LiteralPath terminal-note.txt -Value "from-terminal"');await page.keyboard.press('Enter');await until(()=>history.listDocumentChanges(project).some(c=>c.path.endsWith('terminal-note.txt')),'terminal file tracking');
  await page.getByRole('button',{name:'新建终端',exact:true}).click();await until(()=>terminal.status().sessions===2,'second terminal');await page.getByRole('tab',{name:'powershell',exact:true}).first().click();
  await page.screenshot({path:path.join(qa,'interactive-terminal.png')});
  await page.setViewportSize({width:640,height:740});await wait(200);await page.getByRole('button',{name:'清屏',exact:true}).first().click();await page.getByRole('button',{name:'关闭终端',exact:true}).last().click();await until(()=>terminal.status().sessions===1,'close second terminal');checks.push('真实 PowerShell 输入、变量保留、Ctrl+C、多标签、关闭、尺寸变化和清屏');
  await tab('文档变更');await page.locator('.sky-changes-list button').filter({hasText:'terminal-note.txt'}).click();await page.getByRole('button',{name:'撤销此变更',exact:true}).click();await page.getByRole('button',{name:'确认恢复',exact:true}).click();await until(()=>!fs.existsSync(path.join(project,'terminal-note.txt')),'undo created file');checks.push('终端创建文件的快照和撤销');
  await page.reload();await tab('文档变更');await page.locator('.sky-changes-list button').filter({hasText:'terminal-note.txt'}).click();await page.getByRole('button',{name:'重做此变更',exact:true}).waitFor();
  const record=history.listDocumentChanges(project).find(c=>c.path.endsWith('terminal-note.txt'));
  const script=`const h=require(${JSON.stringify(path.resolve('packages/backend/dist/modules/tools/files/document-history.js'))});h.restoreDocumentChange(${JSON.stringify(record.id)});console.log('restored');`;
  execFileSync(process.execPath,['-e',script],{env:process.env,windowsHide:true});assert.ok(fs.readFileSync(path.join(project,'terminal-note.txt'),'utf8').includes('from-terminal'));checks.push('页面重载及独立新进程从磁盘恢复');
  }
  if(section==='all'||section==='conversation'){
    await page.getByRole('button',{name:'对话撤销验收',exact:true}).click();
    const first=page.getByTestId('round-messages').locator('.group').first();await first.hover();
    fs.writeFileSync(roundFile,'用户另行修改');
    await first.getByTitle('撤销本轮及之后的对话和文件修改',{exact:true}).click();
    await page.getByText('回退失败',{exact:true}).waitFor();assert.equal(await page.getByTestId('round-messages').locator('.chat-msg-user').count(),3);assert.equal(fs.readFileSync(roundFile,'utf8'),'用户另行修改');checks.push('对话回退冲突时保留文件与全部消息');
    fs.writeFileSync(roundFile,'第三轮');await first.hover();await first.getByTitle('撤销本轮及之后的对话和文件修改',{exact:true}).click();
    await until(()=>fs.readFileSync(roundFile,'utf8')==='第一轮之前','three rounds');await until(()=>page.getByTestId('round-messages').locator('.chat-msg-user').count().then(n=>n===0),'messages truncated');
    await until(()=>Array.isArray(savedMessages)&&savedMessages.length===0,'server messages saved');checks.push('点击第一轮回退同时撤销三轮文件修改与消息，恢复第一轮前');
    await page.screenshot({path:path.join(qa,'conversation-rollback.png')});
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(qa,'results-'+section+'.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,data},null,2));console.log(JSON.stringify({checks,errors,data},null,2));
})().catch(async e=>{console.error(e);if(activePage)await activePage.screenshot({path:path.join(qa,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(qa,'failure.json'),JSON.stringify({message:e.message,checks,errors,data},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();await terminal.onModuleDestroy();server?.close();});
