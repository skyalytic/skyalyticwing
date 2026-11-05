// Execute with the bundled Node against the actual packaged production dependencies.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const deploy=path.resolve(process.argv[2]),data=fs.mkdtempSync(path.join(os.tmpdir(),'wing-packaged-skills-'));
process.env.SKYALYTICWING_DATA_DIR=data;
process.env.SKYALYTICWING_SKILLS_DIR=path.join(data,'skills');
const req=require('module').createRequire(path.join(deploy,'package.json'));req('reflect-metadata');
const {SkillService}=req('./dist/modules/ai/agent/skill.service.js');
const {parseSkillDocument}=req('./dist/modules/ai/agent/skill-document.js');
const service=new SkillService({info(){},warn(){},debug(){}},{isPathAllowed:()=>true,addAllowedPath(){}});
(async()=>{try{
 service.onModuleInit();
 service.createSkill({name:'fixture',description:'Verify packaged skill runtime',steps:'Run actual tools and verify the output.'});
 let prompt=await service.buildPrompt([{name:'skill_execute'}]);assert(prompt.includes('Verify packaged skill runtime'));
 const content=await service.getSkillContent('fixture');assert(parseSkillDocument(content.content).body.includes('verify the output'));
 service.deleteSkill('fixture');assert.equal(await service.buildPrompt([{name:'skill_execute'}]),'');
 const bundled=path.resolve(deploy,'../../web/skills');
 const names=fs.readdirSync(bundled).filter(n=>fs.existsSync(path.join(bundled,n,'SKILL.md')));assert(names.length>=58);
 for(const n of names){const parsed=parseSkillDocument(fs.readFileSync(path.join(bundled,n,'SKILL.md'),'utf8'));assert(String(parsed.metadata.description||'').trim().length>5,n);assert(parsed.body,n);}
 console.log('PASS packaged skill runtime: YAML dependency, hot install/discovery/read/uninstall, '+names.length+' bundled guides');
}finally{fs.rmSync(data,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
