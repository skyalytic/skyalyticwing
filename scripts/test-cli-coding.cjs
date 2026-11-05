const {spawn,execFileSync}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(require('node:child_process').execFile);
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {createServer}=require('node:net');
const assert=require('node:assert/strict');
const project=resolve(__dirname,'..'),base=mkdtempSync(join(tmpdir(),'wing-cli-real-')),repo=join(base,'repository'),data=join(base,'profile');
const installIndex=process.argv.indexOf('--installed-root');
const installed=installIndex>=0?resolve(process.argv[installIndex+1]):undefined;
const runtime=installed?join(installed,'node.exe'):process.execPath;
const backendEntry=installed?join(installed,'_up_/packages/backend/deploy/dist/main.js'):join(project,'packages/backend/dist/main.js');
const cliEntry=installed?join(installed,'_up_/packages/web/bin/skyalyticwing.cjs'):join(project,'packages/cli/dist/cli.js');
mkdirSync(repo);mkdirSync(data);
writeFileSync(join(repo,'math.ts'),'export function add(a: number,b: number) { return a+b; }\n');
writeFileSync(join(repo,'main.ts'),"import {add} from './math';\nexport const result=add(1,2);\n");
writeFileSync(join(repo,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,types:[],target:'ES2022'},include:['*.ts']}));
writeFileSync(join(repo,'test.cjs'),"require('node:assert/strict').equal(2+2,4);\n");
execFileSync('git',['init','--quiet',repo],{windowsHide:true});
execFileSync('git',['add','.'],{cwd:repo,windowsHide:true});
execFileSync('git',['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture'],{cwd:repo,windowsHide:true});
writeFileSync(join(data,'config.json'),JSON.stringify({security:{yolo:'yolo',allowedPaths:[repo,data]}}));
let backend,log='',url;
const env={};
for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{NODE_ENV:'production',SKYALYTICWING_DATA_DIR:data,SKYALYTICWING_WEB_DATA_DIR:data,APPDATA:data,LOCALAPPDATA:data,SKYALYTICWING_AUTH_TOKEN:'cli-coding-test-only'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
  backend=spawn(runtime,[backendEntry],{cwd:data,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  backend.stdout.on('data',b=>{log+=b;});backend.stderr.on('data',b=>{log+=b;});
  const deadline=Date.now()+180000;
  while(Date.now()<deadline&&backend.exitCode===null){try{if((await fetch(url+'/health')).ok)return;}catch{}await delay(150);}
  throw new Error('Isolated backend startup failed: '+log.slice(-6000));
}
async function stop(){if(!backend||backend.exitCode!==null)return;const closed=new Promise(r=>backend.once('close',r));backend.kill();await closed;}
async function api(path,body){const r=await fetch(url+'/api'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',Authorization:'Bearer cli-coding-test-only'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();assert(r.ok&&j.success!==false,JSON.stringify(j));return j.data??j;}
async function cli(args){const result=await exec(runtime,[cliEntry,'--cwd',repo,'--base-url',url,'--json',...args],{cwd:repo,env,windowsHide:true,maxBuffer:8*1024*1024,timeout:60000});return JSON.parse(result.stdout.trim());}
(async()=>{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));env.PORT=String(port);url='http://127.0.0.1:'+port;
  try {
    await start();
    const session=(await api('/sessions',{title:'CLI coding integration'})).id;
    const context=['--session',session];
    const servers=await cli(['lsp','servers']);assert(servers.servers.some(s=>s.language==='typescript/javascript'));
    const references=await cli(['lsp','references','math.ts','1','18',...context]);assert(references.data.length>=3);
    const preview=await cli(['lsp','rename','math.ts','1','18','sum',...context]);assert.equal(preview.data.files.length,2);
    await stop();await start();
    await cli(['lsp','apply',preview.data.id,...context]);
    assert(readFileSync(join(repo,'main.ts'),'utf8').includes('sum(1,2)'));
    const inspect=await cli(['repo','inspect',...context]);assert(inspect.data.diff.includes('function sum'));
    const verify=await cli(['repo','verify',runtime,'test.cjs',...context]);assert.equal(verify.data.exitCode,0);
    const passthrough=await cli(['repo','verify',...context,'--',runtime,'--test','test.cjs']);assert.equal(passthrough.data.exitCode,0);
    writeFileSync(join(repo,'test.cjs'),'process.exit(7)');
    let failed;
    try{await cli(['repo','verify',runtime,'test.cjs',...context]);}catch(error){failed=JSON.parse(error.stdout.trim());}
    assert.equal(failed?.ok,false);assert.equal(failed.data.data.exitCode,7);assert(failed.data.data.outputPath);
    console.log('PASS: actual backend + CLI language query, persisted rename, apply, Git inspect, passing/failing process exit and failure log.');
    writeFileSync(join(project,'build',installed?'cli-installed-integration-20261028.json':'cli-coding-integration-20261028.json'),JSON.stringify({passed:true,base,session,checks:8,installed:installed??null,modelEvaluated:false},null,2));
  }finally{await stop();writeFileSync(join(base,'backend.log'),log);console.log('Evidence:',base);}
})().catch(error=>{console.error(error.stack);if(error.stdout)console.error('CLI output:',error.stdout);if(error.stderr)console.error('CLI diagnostic:',error.stderr);process.exitCode=1;});
