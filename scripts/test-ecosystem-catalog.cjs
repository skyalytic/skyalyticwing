// Full install/uninstall of the real signed catalog in isolated data; no connector activation or business writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),site=path.join(root,'build/ecosystem-site'),dir=path.join(root,'.test-runtime-data/ecosystem-acceptance',String(Date.now()));fs.mkdirSync(dir,{recursive:true});
delete process.env.SKYALYTICWING_SKILLS_DIR;
Object.assign(process.env,{NODE_ENV:'test',SKYALYTICWING_DATA_DIR:dir,SKYALYTICWING_WEB_DATA_DIR:dir,APPDATA:dir,LOCALAPPDATA:dir});
const requireBackend=createRequire(path.join(root,'packages/backend/package.json'));requireBackend('reflect-metadata');
const load=p=>require(path.join(root,'packages/backend/dist',p));let app;const checks=[];
(async()=>{
 app=await requireBackend('@nestjs/core').NestFactory.createApplicationContext(load('app.module.js').AppModule,{logger:false});
 const get=(p,n)=>app.get(load(p)[n],{strict:false});
 const {EcosystemService}=load('modules/ecosystem/ecosystem.service.js');
 const catalog=JSON.parse(fs.readFileSync(path.join(site,'catalog.json')));
 const http={get:async(url,opt)=>{const u=new URL(url);let file;if(u.pathname.endsWith('/catalog'))file=path.join(site,'catalog.json');else if(u.pathname.includes('/items/'))file=path.join(site,'items',u.pathname.split('/').pop()+'.json');else file=path.join(site,'artifacts',u.pathname.split('/').pop());const s=fs.readFileSync(file,'utf8');return {status:200,data:opt.responseType==='text'?s:JSON.parse(s)}}};
 const mcp=get('modules/tools/mcp/mcp.service.js','McpService');
 const service=new EcosystemService(http,mcp,undefined,get('modules/ecosystem/template-installer.service.js','TemplateInstallerService'));
 const skills=get('modules/ai/agent/skill.service.js','SkillService');
 for(const item of catalog.items){await service.install(item.id);assert(service.installed().some(x=>x.id===item.id));if(item.kind==='skill'){assert(skills.listSkills().skills.some(x=>x.name===item.id));assert((await skills.getSkillContent(item.id)).content.length>100);}if(item.kind==='mcp'){assert.equal(mcp.listServers().find(s=>s.id==='skyalytic:'+item.id).enabled,false);}checks.push({id:item.id,install:true,visible:true,kind:item.kind});}
 for(const item of catalog.items){await service.uninstall(item.id);assert(!service.installed().some(x=>x.id===item.id));}
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({passed:true,checks,uninstalled:catalog.items.length},null,2));console.log(JSON.stringify({passed:true,installed:checks.length,uninstalled:catalog.items.length,report:path.join(dir,'result.json')}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{if(app)await app.close()});
