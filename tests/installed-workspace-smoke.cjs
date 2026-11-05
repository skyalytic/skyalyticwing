// Verify the installed runtime through its real authenticated HTTP routes in an isolated profile.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),net=require('net');
const {spawn,execFileSync}=require('child_process'),{randomBytes}=require('crypto');
const install=process.argv[2]||'D:/skyalyticwing',deploy=path.join(install,'_up_/packages/backend/deploy'),runtime=path.join(install,'node.exe');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'wing-installed-workspace-')),project=path.join(data,'project');fs.mkdirSync(project);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({security:{yolo:'ask',allowedPaths:[project]},general:{projectDir:project}}));
const token=randomBytes(32).toString('hex'),headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
const env={...process.env,SKYALYTICWING_DATA_DIR:data,SKYALYTICWING_WEB_DATA_DIR:data,APPDATA:data,LOCALAPPDATA:data,XDG_CONFIG_HOME:data,SKYALYTICWING_AUTH_TOKEN:token};
let child,term,base,logs='';const checks=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(route,method='GET',body){const response=await fetch(base+'/api'+route,{method,headers,...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw Error(route+': '+JSON.stringify(value));return 'success' in value?value.data:value;}
(async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
 child=spawn(runtime,[path.join(deploy,'desktop-main.cjs'),'--port',String(port)],{cwd:data,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{logs=(logs+b).slice(-10000);});child.stderr.on('data',b=>{logs=(logs+b).slice(-10000);});
 let healthy=false;for(let i=0;i<90;i++){if(child.exitCode!==null)throw Error('Runtime exit '+child.exitCode);if(await fetch(base+'/health').then(r=>r.ok).catch(()=>false)){healthy=true;break;}await sleep(500);}assert.ok(healthy,'healthy installed runtime');
 const html=await fetch(base).then(r=>r.text()),asset=html.match(/src="([^"\s]+\.js)"/);assert.ok(asset);assert.ok((await fetch(new URL(asset[1],base))).ok);checks.push('安装目录中的服务启动及前端资源');
 assert.equal((await call('/permissions')).mode,'ask');assert.equal((await call('/permissions/mode','PUT',{mode:'yolo'})).mode,'yolo');assert.equal(JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8')).security.yolo,'yolo');checks.push('实际权限接口与配置持久化');
 const file=path.join(project,'note.txt');fs.writeFileSync(file,'original\n');await call('/files/write','POST',{path:file,content:'updated\n'});
 let changes=(await call('/files/changes?dir='+encodeURIComponent(project))).changes;const c=changes.find(c=>c.path===file);assert.ok(c);assert.ok((await call('/files/changes/'+c.id)).diff.includes('+updated'));
 await call('/files/changes/'+c.id+'/restore','POST',{state:'applied'});assert.equal(fs.readFileSync(file,'utf8'),'original\n');await call('/files/changes/'+c.id+'/restore','POST',{state:'undone'});assert.equal(fs.readFileSync(file,'utf8'),'updated\n');checks.push('真实文件保存、差异、撤销和重做接口');
 const round=path.join(project,'rounds.txt');fs.writeFileSync(round,'zero');const sinceTs=Date.now();
 const seed=`const fs=require('fs'),h=require(${JSON.stringify(path.join(deploy,'dist/modules/tools/files/document-history.js'))});for(const value of ['one','two','three'])h.withDocumentSession('acceptance-rounds',()=>h.trackDocumentMutationSync(${JSON.stringify(round)},()=>fs.writeFileSync(${JSON.stringify(round)},value)));`;
 execFileSync(runtime,['-e',seed],{env,windowsHide:true});const restored=await call('/files/rollback','POST',{sessionId:'acceptance-rounds',sinceTs});assert.ok(restored.restored.includes(round));assert.equal(fs.readFileSync(round,'utf8'),'zero');checks.push('安装版本三轮对话整体回退');
 term=await call('/terminal/open','POST',{cwd:project,cols:90,rows:25});let cursor=0,output='';
 const drain=async()=>{const r=await call('/terminal/'+term.id+'/output?since='+cursor);cursor=r.seq;output+=r.data;if(r.data.includes('\x1b[6n'))await call('/terminal/'+term.id+'/input','POST',{text:'\x1b[1;1R',raw:true});};
 for(let i=0;i<50&&!output.includes('PS ');i++){await drain();await sleep(100);}assert.ok(output.includes('PS '));
 await call('/terminal/'+term.id+'/input','POST',{text:'Write-Output (37000 + 49002)'});for(let i=0;i<60&&!output.includes('86002');i++){await drain();await sleep(100);}assert.ok(output.includes('86002'));checks.push('安装版内置 Node 与原生 PTY 执行命令');
 await call('/terminal/'+term.id+'/close','POST',{});term=null;await sleep(3500);assert.equal((await call('/terminal/status')).sessions,0);assert.ok(!logs.includes('AttachConsole failed'));checks.push('终端关闭及资源清理');
 fs.writeFileSync(path.resolve('build/workspace-2.0.1-qa/installed-smoke.json'),JSON.stringify({checks,data,install,at:new Date().toISOString()},null,2));console.log(JSON.stringify({checks,data,install},null,2));
})().catch(e=>{console.error(e.stack);console.error(logs.slice(-2500));process.exitCode=1;}).finally(async()=>{if(term){await call('/terminal/'+term.id+'/close','POST',{}).catch(()=>{});await sleep(3500);}if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}});
