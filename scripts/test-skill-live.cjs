/* Opt-in billed model acceptance, real Nest loop and tools, synthetic isolated data only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
if(!process.argv.includes('--live'))throw new Error('Pass --live for bounded real model acceptance');
const root=path.resolve(__dirname,'..'),req=createRequire(path.join(root,'packages/backend/package.json'));
const key=process.env.ACCEPTANCE_MODEL_KEY;
assert(key,'Missing acceptance model credential');
const dir=path.join(root,'.test-runtime-data/skill-live',String(Date.now())),workspace=path.join(dir,'workspace');fs.mkdirSync(workspace,{recursive:true});
const inherited=process.env;process.env={};
for(const name of ['PATH','Path','SystemRoot','SYSTEMROOT','COMSPEC','TEMP','TMP','PATHEXT','ProgramFiles','ProgramFiles(x86)','ProgramW6432'])if(inherited[name])process.env[name]=inherited[name];
for(const name of ['ProgramFiles','ProgramFiles(x86)'])if(inherited[name])process.env[name.toUpperCase()]=inherited[name];
Object.assign(process.env,{NODE_ENV:'test',SKYALYTICWING_DATA_DIR:dir,SKYALYTICWING_WEB_DATA_DIR:dir,APPDATA:dir,LOCALAPPDATA:dir,ACCEPTANCE_MODEL_KEY:key});
req('reflect-metadata');const {NestFactory}=req('@nestjs/core');
const backend=p=>require(path.join(root,'packages/backend/dist',p));
let app;const checks=[];
(async()=>{
 app=await NestFactory.createApplicationContext(backend('app.module.js').AppModule,{logger:false});
 const get=(p,n)=>app.get(backend(p)[n]);
 const config=get('modules/core/config/config.service.js','ConfigService');
 config.set('providers',{deepseek:{apiKey:'${ACCEPTANCE_MODEL_KEY}',baseUrl:'https://api.deepseek.com',models:['deepseek-flash'],type:'openai'}});
 config.mergeSection('general',{defaultModel:'deepseek-flash',defaultProvider:'deepseek',permissionMode:'yolo'});config.mergeSection('security',{yolo:'yolo'});
 get('modules/core/security/security-manager.service.js','SecurityManagerService').addAllowedPath(workspace,'readwrite');
 const skills=get('modules/ai/agent/skill.service.js','SkillService'),files=get('modules/tools/files/files.service.js','FilesService'),loop=get('modules/ai/agent/agent-loop.service.js','AgentLoopService');
 const original=loop.getToolDefinitions.bind(loop),allowed=['skill_list','skill_execute','file-read','file-write','python','node','doc_generate','directory-list'];
 loop.getToolDefinitions=id=>original(id)?.filter(t=>allowed.includes(t.name));
 const marker=randomUUID();
 skills.createSkill({name:'receipt-acceptance',description:'公司验收标记规范：对订单金额进行验收并生成 receipt.json 时必须使用。',steps:`读取当前工作目录的 order.txt。将金额乘以 2，在 receipt.json 写 JSON：amount 为计算值，verification 为 ${marker}。写完重新读取验证。`});
 fs.writeFileSync(path.join(workspace,'order.txt'),'订单金额：37.50 元');
 async function run(id,prompt){
  files.setProjectDir(workspace,id);const tools=[],errors=[];let text='';
  for await(const event of loop.run(id,prompt,{agentId:'agent',model:'deepseek-flash',maxIterations:12,maxTotalTokens:70000,maxDurationMs:180000})){
   if(event.type==='tool_call'){tools.push({name:event.toolName,args:event.args});console.log(id+' TOOL '+event.toolName);}
   if(event.type==='error')errors.push(event.error);
   if(event.type==='assistant_message')text=event.content||text;
  }
  assert.equal(errors.length,0,errors.join(';'));return {tools,text};
 }
 const receipt=await run('skill-auto','请按公司的验收标记规范处理 order.txt，生成 receipt.json 并检查结果。');
 assert(receipt.tools.some(t=>t.name==='skill_execute'&&t.args.name==='receipt-acceptance'),'Model must discover the installed skill');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'receipt.json'),'utf8')),{amount:75,verification:marker});
 checks.push({name:'automatic-installed-skill-and-real-file-output',passed:true,tools:receipt.tools.map(t=>t.name)});
 const excel=await run('skill-xlsx','创建 产品清单.xlsx，包含两列“产品”“数量”，数据：甲 10、乙 20。仅原始数据，不需要公式。生成后检查文件确实可读。');
 assert(excel.tools.some(t=>t.name==='skill_execute'&&t.args.name==='xlsx'),'Model must choose bundled spreadsheet skill');
 const XLSX=req('xlsx'),book=XLSX.readFile(path.join(workspace,'产品清单.xlsx')),rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1});
 assert(rows.some(r=>r.includes('甲')&&r.includes(10)));assert(rows.some(r=>r.includes('乙')&&r.includes(20)));
 checks.push({name:'bundled-xlsx-skill-real-readable-workbook',passed:true,tools:excel.tools.map(t=>t.name)});
 const simple=await run('skill-unrelated','2 + 2 等于多少？只回答一个数字。');assert.equal(simple.text.trim(),'4');assert(!simple.tools.some(t=>t.name==='skill_execute'));
 checks.push({name:'unrelated-question-does-not-load-skills',passed:true});
})().catch(e=>{checks.push({name:'acceptance',passed:false,error:String(e.message).split(key).join('[redacted]')});process.exitCode=1;}).finally(async()=>{
 await app?.close();delete process.env.ACCEPTANCE_MODEL_KEY;fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({at:new Date().toISOString(),authorization:'isolated account entitlement fixture; real paid model and tools',checks},null,2));console.log(JSON.stringify({dir,checks}));
});
