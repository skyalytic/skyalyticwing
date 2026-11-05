// Real browser tool + local page. The fixture is not a production account or external service.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{createServer}=require('http'),{createRequire}=require('module');
createRequire(path.resolve('packages/backend/package.json'))('reflect-metadata');
const {BuiltInBrowserService}=require('../packages/backend/dist/modules/browser/browser.service.js');
const {createBuiltinBrowserTools}=require('../packages/backend/dist/modules/tools/executor/built-in/builtin-browser.js');
const {TaskVerification}=require('../packages/backend/dist/modules/ai/agent/task-verification.js');
const browser=new BuiltInBrowserService(),ctx={sessionId:'verification-qa',workspace:process.cwd()},checks=[],qa=path.resolve('build/full-audit-2.0.1');
const tool=createBuiltinBrowserTools(()=>browser)[0],v=new TaskVerification();let server;
const accept=evidence=>v.submit({checks:[{requirement:'中文输入保存后刷新仍可读取',status:'passed',evidence,detail:'实际输入、点击保存，刷新后的页面显示已保存的中文内容'}]});
async function execute(id,args){const result=await tool.execute(args,ctx);v.record(id,'builtin_browser',args,result);assert.equal(result.success,true,result.error);return result;}
const view=r=>({pageId:r.output.match(/页面ID: (\S+)/)[1],observationId:r.output.match(/observationId: ([^;]+)/)[1]});
(async()=>{
  server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><title>Wing 实际浏览器验收</title><style>body{font:18px system-ui;padding:40px}input,button{font:inherit;padding:12px;margin:8px}</style><h1>资料编辑</h1><label>名称 <input aria-label="名称" id="name"></label><button id="save">保存</button><p id="result"></p><script>const nameInput=document.querySelector('#name'),result=document.querySelector('#result');const saved=localStorage.getItem('name');if(saved){nameInput.value=saved;result.textContent='已保存：'+saved;}document.querySelector('#save').onclick=()=>{localStorage.setItem('name',nameInput.value);result.textContent='已保存：'+nameInput.value;};</script></html>`);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let result=await execute('open',{action:'navigate',url:'http://127.0.0.1:'+server.address().port});
  let snap=view(result),index=Number(result.output.match(/#(\d+) <input>/)[1]);
  result=await execute('fill',{action:'fill',...snap,index,text:'穹析科技验收'});
  snap=view(result);index=Number(result.output.match(/#(\d+) <button>[^\n]*保存/)[1]);
  result=await execute('save',{action:'click',...snap,index});assert.ok(result.output.includes('已保存：穹析科技验收'));
  assert.equal(accept(['save']).success,false);checks.push('中文输入、真实保存按钮；不能把点击成功当成验收');
  result=await execute('reload',{action:'reload',pageId:view(result).pageId});
  result=await execute('observe',{action:'snapshot',pageId:view(result).pageId});assert.ok(result.output.includes('已保存：穹析科技验收'));
  assert.equal(accept(['observe']).success,true);assert.equal(v.beforeFinish(),undefined);checks.push('刷新后回读实际结果，再提交有效验收证据');
  fs.writeFileSync(path.join(qa,'browser-verified.jpg'),Buffer.from(result.data.browserScreenshot,'base64'));
  const child=browser.forSession(ctx.sessionId);assert.equal(child.status().agentBusy,false);child.setControl(true);
  const blocked=await tool.execute({action:'click',...view(result),index},ctx);assert.equal(blocked.success,false);assert.ok(blocked.error.includes('接管'));child.setControl(false);checks.push('操作结束不占用控制；用户接管时阻止 AI 操作');
  fs.writeFileSync(path.join(qa,'browser-verification.json'),JSON.stringify({checks,at:new Date().toISOString()},null,2));console.log(JSON.stringify({checks}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser.onModuleDestroy();if(server)await new Promise(r=>server.close(r));});
