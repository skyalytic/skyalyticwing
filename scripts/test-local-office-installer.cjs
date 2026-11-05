// Exercise OS orchestration without installing a hypervisor or changing the host system.
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'../deploy/office-engine/local-engine.cjs'),'utf8');
async function scenario(platform,options={}){
 const calls=[],events=[];let installed=false,available=!!options.docker;
 const fakeFs={...fs,mkdirSync(){},existsSync(p){return String(p).includes('rdctl')&&!!options.installedRuntime;}};
 const spawn=(bin,args)=>{calls.push([bin,args]);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 queueMicrotask(()=>{let result='',code=0;
 if(bin.includes('docker')){
  if(!available)code=1;
  else if(args.includes('context'))result=JSON.stringify([{Endpoints:{docker:{Host:options.remote?'tcp://remote:2375':'unix:///docker.sock'}}}]);
  else if(args.includes('info'))result='linux';
  else if(args.includes('inspect'))result=JSON.stringify({Labels:{'com.skyalyticwing.office':options.foreign?'foreign':'managed'},Env:['WING_WOPI_ORIGIN=http://host.docker.internal:18000','WING_FRAME_ORIGIN=http://127.0.0.1:910']});
 }else if(bin.includes('rdctl')){if(!options.installedRuntime)code=1;else if(args[0]==='start'){available=true;installed=true;}}
 else if(bin==='wsl.exe')code=options.wsl?0:1;
 if(result)child.stdout.emit('data',Buffer.from(result));child.emit('close',code);});return child;};
 const fakeProcess={platform,arch:'x64',env:{LOCALAPPDATA:'C:/user/local',ProgramFiles:'C:/Program Files'},stdout:{write:s=>events.push(JSON.parse(s))}};
 const context={require:n=>n==='node:fs'?fakeFs:n==='node:os'?{homedir:()=>'/test/home',release:()=>platform==='win32'?'10.0.26100':'23.0.0'}:n==='node:child_process'?{spawn}:n.startsWith('./')?require(path.join(__dirname,'../deploy/office-engine',n)):require(n),module:{exports:{}},process:fakeProcess,__dirname:path.join(__dirname,'../deploy/office-engine'),Buffer,URL,AbortSignal,setTimeout:(f,ms)=>ms===3000?(queueMicrotask(f),0):setTimeout(f,ms),clearTimeout,fetch:async()=>({ok:true,text:async()=>'<wopi-discovery>'})};
 vm.runInNewContext(source,context);let error;try{await context.module.exports.main({directory:'/fixture',frameOrigin:'http://127.0.0.1:910',callback:'http://host.docker.internal:18000',healthUrl:'http://host.docker.internal:18000/health/test',installRuntime:!!options.install,action:options.stop?'stop':'start'});}catch(e){error=e.message;}
 return {calls,events,installed,error};
}
(async()=>{
 let n=0;for(const p of ['win32','darwin','linux']){const r=await scenario(p,{docker:true});assert.equal(r.events.at(-1).phase,'ready');assert(!r.calls.some(c=>c[0].includes('msiexec')));n++;}
 for(const p of ['win32','darwin']){const r=await scenario(p,{installedRuntime:true});assert(r.installed);assert(r.calls.some(c=>c[1][0]==='start'&&c[1].length===2));assert.equal(r.events.at(-1).phase,'ready');n++;}
 const wsl=await scenario('win32',{install:true});assert.equal(wsl.events.at(-1).phase,'system-setup-required');n++;
 const foreign=await scenario('win32',{docker:true,foreign:true});assert.match(foreign.error,/不属于 Wing/);assert(!foreign.calls.some(c=>c[1].includes('stop')||c[1].includes('rm')));n++;
 const remote=await scenario('linux',{docker:true,remote:true});assert.equal(remote.events.at(-1).phase,'runtime-required');n++;
 const stop=await scenario('darwin',{stop:true});assert.equal(stop.events.at(-1).phase,'stopped');assert(!stop.installed);n++;
 console.log(JSON.stringify({passed:true,scenarios:n,scope:'simulated OS orchestration; no physical Windows/macOS installation'}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
