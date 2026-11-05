/* Real tool handlers + real Nest services, isolated user data; no external messages or host UI actions. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.test-runtime-data/tool-runtime',String(Date.now()));
const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace,{recursive:true});
const prior=process.env;process.env={};
for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','COMSPEC','TEMP','TMP','PATHEXT','ProgramFiles','ProgramFiles(x86)','ProgramW6432'])if(prior[key])process.env[key]=prior[key];
// Replacing process.env with a plain object removes Windows' case-insensitive lookup.
for(const key of ['ProgramFiles','ProgramFiles(x86)'])if(prior[key])process.env[key.toUpperCase()]=prior[key];
Object.assign(process.env,{NODE_ENV:'test',SKYALYTICWING_DATA_DIR:dir,SKYALYTICWING_WEB_DATA_DIR:dir,SKYALYTICWING_SKILLS_DIR:path.join(dir,'skills'),APPDATA:dir,LOCALAPPDATA:dir});
const req=createRequire(path.join(root,'packages/backend/package.json'));
const backend=p=>require(path.join(root,'packages/backend/dist',p));
const {NestFactory}=req('@nestjs/core');
const checks=[];let app,tools,ctx;
async function run(name,args={},expected=true,verify){
  console.log('CHECK '+name);
  const tool=tools.find(t=>t.name===name);assert(tool,name);
  try{const result=await tool.execute(args,ctx);assert.equal(result.success,expected,result.error||name);if(verify)await verify(result);checks.push({name,kind:expected?'local-execution':'expected-rejection',passed:true});return result;}
  catch(error){checks.push({name,kind:'local-execution',passed:false,error:String(error.message).replace(/sk-[\w-]+/g,'[redacted]')});return null;}
}
function payload(result){if(result?.data)return result.data;try{return JSON.parse(result?.output||'{}');}catch{return {};}}
(async()=>{
  app=await NestFactory.createApplicationContext(backend('app.module.js').AppModule,{logger:false});
  const get=(p,n)=>app.get(backend(p)[n],{strict:false});
  const security=get('modules/core/security/security-manager.service.js','SecurityManagerService');security.addAllowedPath(workspace,'readwrite');
  tools=backend('modules/tools/executor/built-in-tools.js').createBuiltInTools({security,http:get('modules/core/http/http-client.service.js','HttpClientService'),ws:get('modules/core/websocket/websocket.service.js','WebSocketService'),config:get('modules/core/config/config.service.js','ConfigService'),safety:get('modules/core/security/safety-manager.service.js','SafetyManagerService'),resolve:token=>{try{return app.get(token,{strict:false});}catch{return undefined;}}});
  ctx={workspace,sessionId:'runtime-fixture',agentId:'main',broadcast:()=>{},log:()=>{}};
  const session=await run('session_create',{title:'Tool runtime acceptance'});const created=payload(session);ctx.sessionId=created.id||created.sessionId||ctx.sessionId;
  const file=path.join(workspace,'fixture.txt');
  await run('file-write',{path:file,content:'Wing 中文工具测试 73'});
  await run('file-read',{path:file},true,r=>assert.match(r.output,/73/));
  await run('file-edit',{path:file,oldText:'73',newText:'85'},true,()=>assert.match(fs.readFileSync(file,'utf8'),/85/));
  await run('directory-list',{path:workspace});await run('glob',{path:workspace,pattern:'**/*.txt'});await run('grep',{path:workspace,pattern:'85'});
  await run('apply_patch',{file_path:file,patches:[{search:'85',replace:'99'}]},true,()=>assert.match(fs.readFileSync(file,'utf8'),/99/));
  await run('diff',{text1:'before',text2:'after'});
  const notebook=path.join(workspace,'fixture.ipynb');fs.writeFileSync(notebook,JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{},cells:[]}));
  await run('notebook_edit',{notebook_path:notebook,cell_number:0,edit_mode:'insert',new_source:'print(73)',cell_type:'code'},true,()=>assert.equal(JSON.parse(fs.readFileSync(notebook)).cells.length,1));
  await run('notebook_edit',{notebook_path:notebook,cell_number:0,new_source:'print(85)'},true,()=>assert.equal(JSON.parse(fs.readFileSync(notebook)).cells[0].source,'print(85)'));
  await run('notebook_edit',{notebook_path:notebook,cell_number:0,edit_mode:'delete'},true,()=>assert.equal(JSON.parse(fs.readFileSync(notebook)).cells.length,0));
  await run('tool_policy_create',{name:'runtime-fixture',allow:['file-read'],deny:['file-write']});
  await run('security_audit');await run('process_list');await run('cli_anything',{action:'list'});
  await run('env_set',{name:'WING_TOOL_TEST_LABEL',value:'fixture'});await run('env_get',{name:'WING_TOOL_TEST_LABEL'});await run('env_get',{name:'OPENAI_API_KEY'},false);
  const todo=payload(await run('todo',{action:'add',text:'验收任务'}));if(todo.items?.[0])await run('todo',{action:'update',id:todo.items[0].id,done:true});await run('todo',{action:'list'});
  await run('memory_save',{content:'验收标识 WING_RUNTIME_73',target:'longterm'});await run('memory_search',{query:'WING_RUNTIME_73'});await run('memory_get',{path:'MEMORY.md'});
  await run('knowledge_add',{title:'验收知识',content:'WING_KNOWLEDGE_85'});await run('knowledge_search',{query:'WING_KNOWLEDGE_85'});
  await run('skill_create',{name:'runtime-fixture',description:'isolated test skill',steps:'Return fixture text only.'});await run('skill_list');await run('skill_execute',{name:'runtime-fixture',input:'fixture'});
  await run('update_plan',{plan:[{step:'验收工具',status:'completed'}]});
  for(const name of ['system_info','usage_stats','queue_status','remote_nodes','cron_list','mcp_list','mcp_resources','mcp_loopback_status','mcp_conversations_list','agent_inbox','agent_message_read','sessions_list','acp_status','acp_session_list','daemon_status','pairing_list','binding_list','plugin_list','sandbox_status','agent_list','tool_policy_list'])await run(name);
  const tui=payload(await run('tui_start'));
  await run('tui_send',{id:tui.id,message:'/help'},true,r=>assert.match(payload(r).text,/输入文字/));
  await run('tui_status',{id:tui.id},true,r=>assert.equal(payload(r).running,false));
  await run('tui_stop',{id:tui.id},true,r=>assert.equal(payload(r).stopped,true));
  const loopback=payload(await run('mcp_loopback_start',{port:0}));assert(loopback.port>0,'loopback port');
  await run('mcp_loopback_status',{},true,r=>assert.equal(payload(r).running,true));await run('mcp_loopback_stop');
  await run('sessions_read',{sessionId:ctx.sessionId});await run('session_status',{sessionId:ctx.sessionId});await run('subagents',{action:'list'});await run('provider_config',{action:'list'});
  const cron=payload(await run('cron_create',{name:'isolated disabled job',expression:'0 0 1 1 *',taskType:'shell',command:'echo fixture',enabled:false}));
  const jobId=cron.jobId||cron.id||cron.job?.id;assert(jobId,'cron_create must return jobId');if(jobId){await run('cron_update',{jobId,name:'updated fixture'});await run('cron_toggle',{jobId,enabled:false});await run('cron_delivery',{jobId,mode:'none'});await run('cron_run_now',{jobId});await run('cron_delete',{jobId});}
  const acp=payload(await run('acp_session_create',{agentId:'main'}));const acpId=acp.sessionId||acp.id;if(acpId){
    await run('acp_session_list',{},true,r=>assert(payload(r).sessions.some(s=>s.sessionId===acpId)));
    await run('acp_event_replay',{sessionId:acpId});await run('acp_session_close',{sessionId:acpId});
    await run('acp_session_resume',{sessionId:acpId},true,()=>assert.equal(get('modules/ai/acp/acp-session.service.js','AcpSessionService').getSession(acpId).status,'idle'));
    await run('acp_session_close',{sessionId:acpId});}
  await run('acp_approval_classify',{toolName:'file-read'});
  await run('pairing_generate',{senderId:'local-fixture'});await run('binding_add',{agentId:'main',matchChannel:'local-fixture'});
  for(const format of ['docx','xlsx','pptx','pdf'])await run('doc_generate',{format,title:'Wing test',sections:[{heading:'Report',content:'Editable content',rows:[['A','B'],[1,73]]}],outputPath:path.join(workspace,'report.'+format)},true,()=>assert(fs.statSync(path.join(workspace,'report.'+format)).size>0));
  await run('pdf',{action:'info',file_path:path.join(workspace,'report.pdf')});
  await run('pdf',{action:'read',file_path:path.join(workspace,'report.pdf')},true,r=>assert.match(r.output,/Editable content/));
  await run('pdf',{action:'merge',file_paths:[path.join(workspace,'report.pdf'),path.join(workspace,'report.pdf')],output_path:path.join(workspace,'merged.pdf')});
  await run('pdf',{action:'read',file_path:path.join(workspace,'merged.pdf')},true,r=>assert.equal((r.output.match(/Editable content/g)||[]).length,2));
  await run('canvas',{action:'create',content:'<h1>Editable canvas</h1>',filename:'canvas.html'});
  for(const format of ['png','pdf'])await run('canvas',{action:'export',format,content:'<h1>Canvas fixture</h1>',filename:'canvas.'+format});
  await run('send_file_to_user',{filePath:path.join(workspace,'report.docx')});
  const document=payload(await run('office_read',{path:path.join(workspace,'report.docx')}));
  if(document.sections?.[0]?.fields?.[0])await run('office_edit',{path:path.join(workspace,'report.docx'),revision:document.revision,changes:[{id:document.sections[0].fields[0].id,value:'AI edited title'}]});
  const database=path.join(workspace,'test.sqlite');await get('modules/tools/files/database.service.js','DatabaseService').run({path:database,create:true});
  await run('database_execute',{path:database,sql:"INSERT INTO wing_notes(title,content) VALUES (?,?)",params:['中文','fixture']});
  await run('database_query',{path:database,sql:'SELECT title FROM wing_notes'},true,r=>assert.match(JSON.stringify(r),/中文/));
  await run('node',{code:'console.log(2+3)'});await run('python',{code:'print(2+3)'});await run('powershell',{command:'Write-Output WING_RUNTIME_85'});
  const fixtureBuild = path.join(workspace,'fixture-build.cjs');fs.writeFileSync(fixtureBuild,'console.log("WING_BUILD_SUCCESS")');
  await run('code_build',{command:'node fixture-build.cjs',cwd:workspace},true,r=>assert.match(r.output,/WING_BUILD_SUCCESS/));
  const cp=require('node:child_process');cp.execFileSync('git',['init'],{cwd:workspace,stdio:'ignore',windowsHide:true});
  await run('git_operation',{command:'status --short',repoPath:workspace},true,r=>assert.match(r.output,/fixture/));
  await run('node',{code:'console.error("intentional failure");process.exit(7)'},false,r=>assert.equal(r.data.exitCode,7));
  await run('code_build',{command:'node -e "process.exit(7)"',cwd:workspace},false,r=>assert.equal(r.data.exitCode,7));
  await run('notify',{title:'Fixture',message:'isolated in-app acceptance'});await run('show_message',{message:'isolated in-app acceptance'});
  await run('file-delete',{paths:[file]},true,()=>assert(!fs.existsSync(file)));
})().catch(e=>{checks.push({name:'harness',passed:false,error:e.message});}).finally(async()=>{
  if(app)await app.close();
  const covered=new Set(checks.map(c=>c.name));
  const report={at:new Date().toISOString(),checks,tools:(tools||[]).map(t=>({name:t.name,category:t.category,execution:covered.has(t.name)?'see-checks':'not-executed-in-local-harness'})),passed:checks.every(c=>c.passed)};
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'.test-runtime-data/tool-runtime-latest.json'),JSON.stringify({dir,...report},null,2));
  console.log(JSON.stringify({dir,checks:checks.length,toolsExecuted:covered.size,failed:checks.filter(c=>!c.passed)},null,2));process.exitCode=report.passed?0:1;
});
