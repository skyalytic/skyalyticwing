/* Managed local Office installer. Runs only after the local administrator selects Install. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const runtime=require('./desktop-runtime.lock.json'),engine=require('./runtime.lock.json');
const NAME='skyalyticwing-office',LABEL='com.skyalyticwing.office',IMAGE='skyalyticwing-office:26.04.5';
let child,aborted=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const emit=(phase,message,extra={})=>process.stdout.write(JSON.stringify({phase,message,...extra})+'\n');
const digest=file=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256');fs.createReadStream(file).on('data',b=>h.update(b)).on('error',reject).on('end',()=>resolve(h.digest('hex')));});
async function run(bin,args,timeout=60000,options={}) {
  if(aborted)throw new Error('安装已取消');
  return new Promise((resolve,reject)=>{
    let output='';const proc=spawn(bin,args,{windowsHide:true,env:process.env,...options});child=proc;
    const timer=setTimeout(()=>{proc.kill();reject(new Error('步骤超时：'+path.basename(bin)));},timeout);
    for(const stream of [proc.stdout,proc.stderr])stream?.on('data',b=>{output=(output+b.toString()).slice(-12000);});
    proc.once('error',e=>{clearTimeout(timer);reject(e);});
    proc.once('close',code=>{clearTimeout(timer);if(child===proc)child=null;code===0?resolve(output):reject(Object.assign(new Error(path.basename(bin)+' 执行失败 ('+code+'): '+output.slice(-1800)),{code}));});
  });
}
function tools(platform=process.platform,home=os.homedir(),env=process.env){
  if(platform==='win32'){
    const app=path.join(env.LOCALAPPDATA||home,'Programs','Rancher Desktop');
    const machine=path.join(env.ProgramFiles||'C:\\Program Files','Rancher Desktop');
    return [app,machine].flatMap(p=>[path.join(p,'resources','resources','win32','bin'),path.join(p,'resources','resources','win32','internal')]);
  }
  return [path.join(home,'.rd','bin'),path.join(home,'Applications','Rancher Desktop.app','Contents','Resources','resources','darwin','bin'),'/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin'];
}
function binary(name){const exe=process.platform==='win32'?name+'.exe':name;return tools().map(p=>path.join(p,exe)).find(fs.existsSync)||exe;}
async function dockerLocal(){
  const bin=binary('docker');
  for(const context of ['rancher-desktop',null]){
    const prefix=context?['--context',context]:[];
    try{
      const info=JSON.parse(await run(bin,[...prefix,'context','inspect',...(context?[context]:[])],10000));
      const host=info[0]?.Endpoints?.docker?.Host||'';
      if(!/^(unix:|npipe:)/.test(host))continue; // Never provision into a remote Docker context.
      await run(bin,[...prefix,'info','--format','{{.OSType}}'],15000).then(s=>{if(s.trim()!=='linux')throw new Error('需要 Linux 容器');});
      return {bin,prefix};
    }catch{/* try next local context */}
  }
  return null;
}
async function download(url,file,sha,max){
  if(fs.existsSync(file)&&await digest(file)===sha)return;
  const u=new URL(url);if(u.protocol!=='https:'||!['github.com','skyalytic.com'].includes(u.hostname))throw new Error('下载来源不在允许范围');
  const r=await fetch(url,{signal:AbortSignal.timeout(20*60000)});if(!r.ok||!r.body)throw new Error('组件下载失败 HTTP '+r.status);
  const tmp=file+'.part';let size=0;const h=crypto.createHash('sha256');const out=fs.createWriteStream(tmp,{flags:'w'});
  let writeError;out.on('error',e=>{writeError=e;});
  try{
    for await(const b of r.body){if(writeError)throw writeError;if(aborted)throw new Error('安装已取消');size+=b.length;if(size>max)throw new Error('组件大小异常');h.update(b);if(!out.write(b))await new Promise((ok,fail)=>{const done=()=>{out.removeListener('error',fail);ok();};out.once('drain',done);out.once('error',fail);});}
    if(writeError)throw writeError;
    await new Promise((ok,fail)=>{out.once('error',fail);out.end(ok);});
    if(h.digest('hex')!==sha)throw new Error('组件 SHA-256 校验失败');fs.renameSync(tmp,file);
  }catch(e){out.destroy();throw e;}
}
async function installRuntime(dir){
  if(process.platform==='win32'&&Number(os.release().split('.')[2])<22000)throw new Error('自动运行环境需要 Windows 11 / Server 2025；旧系统可连接企业私有 Office 引擎');
  if(process.platform==='darwin'&&Number(os.release().split('.')[0])<22)throw new Error('自动运行环境需要 macOS 13 或更高版本');
  const asset=runtime[process.platform+'-'+process.arch];if(!asset)throw new Error('当前平台没有自动运行环境安装器；请安装本地 Linux Docker 引擎后重试');
  if(process.platform==='win32'){
    try{await run('wsl.exe',['--status'],15000);}catch{
      emit('system-setup-required','需要先启用 WSL 2。点击“启用 Windows 运行环境”，完成系统授权/重启后重试。');return false;
    }
  }
  // Do not overwrite or reset an existing Rancher installation that cannot start.
  const rd=binary('rdctl');let installed=path.isAbsolute(rd);if(!installed)try{await run(rd,['version'],10000);installed=true;}catch{}
  if(installed){
    emit('starting-runtime','启动已安装的 Rancher Desktop（保留已有配置）');await run(rd,['start','--application.start-in-background=true'],120000);return true;
  }
  emit('downloading-runtime','下载并校验 Rancher Desktop '+runtime.version);
  const file=path.join(dir,asset.file);await download(asset.url,file,asset.sha256,900*1024*1024);
  emit('installing-runtime','安装本地运行环境，系统可能要求确认权限');
  if(process.platform==='win32'){
    try{await run('msiexec.exe',['/i',file,'/passive','/norestart','ALLUSERS=2','MSIINSTALLPERUSER=1'],15*60000);}catch(e){if(e.code===3010){emit('restart-required','运行环境安装完成，需要重启 Windows 后继续');return false;}throw e;}
  }else{
    const apps=path.join(os.homedir(),'Applications');fs.mkdirSync(apps,{recursive:true});
    const app=path.join(apps,'Rancher Desktop.app');if(fs.existsSync(app))throw new Error('已有用户运行环境，不自动覆盖');
    await run('/usr/bin/ditto',['-x','-k',file,apps],180000);
    await run('/usr/bin/codesign',['--verify','--deep','--strict',app],60000);
  }
  const args=['start','--container-engine.name=moby','--kubernetes.enabled=false','--application.start-in-background=true','--application.telemetry.enabled=false','--application.auto-start=true'];
  if(process.platform==='darwin'&&process.arch==='arm64')args.push('--virtual-machine.use-rosetta=true');
  await run(binary('rdctl'),args,180000);return true;
}
function safeOrigin(s){const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('服务地址无效');return u.origin;}
async function main(config){
  const dir=path.resolve(config.directory);fs.mkdirSync(dir,{recursive:true});
  const callback=safeOrigin(config.callback),frame=safeOrigin(config.frameOrigin);
  let docker=await dockerLocal();
  if(!docker){
    if(config.action==='stop'){emit('stopped','本地容器运行环境未启动');return;}
    if(!config.installRuntime){
      try{await run(binary('rdctl'),['start','--application.start-in-background=true'],120000);}catch{emit('runtime-required','没有可用的本地 Linux 容器环境；可继续安装或启动已有环境');return;}
    }else if(!await installRuntime(dir))return;
    emit('starting-runtime','等待本地运行环境启动');
    for(let n=0;n<60&&!docker;n++){await sleep(3000);docker=await dockerLocal();}
    if(!docker)throw new Error('本地运行环境未就绪。已有 Rancher 若使用 containerd，请自行切换到 Moby；Wing 不会重置已有环境。');
  }
  const d=(args,timeout)=>run(docker.bin,[...docker.prefix,...args],timeout);
  let prior;
  try{prior={Config:JSON.parse(await d(['inspect','--format','{{json .Config}}',NAME]))};}catch{/* absent */}
  if(prior&&prior.Config?.Labels?.[LABEL]!=='managed')throw new Error('同名容器不属于 Wing，拒绝操作');
  if(config.action==='stop') {if(prior)await d(['stop','--time','30',NAME]);emit('stopped','本地 Office 已停止，文档仍保留在原位置');return;}
  if(prior&&config.action==='repair'){await d(['stop','--time','30',NAME]);await d(['rm',NAME]);prior=null;}
  if(!prior){
    let image=false;try{const labels=JSON.parse(await d(['image','inspect','--format','{{json .Config.Labels}}',IMAGE]));if(labels?.[LABEL]!=='managed')throw new Error('镜像标签不属于 Wing');image=true;}catch(e){if(e.message==='镜像标签不属于 Wing')throw e;}
    if(!image){
      emit('downloading-engine','准备校验后的 Office 引擎组件');
      const kit=path.join(dir,'kit');fs.mkdirSync(kit,{recursive:true});
      if(config.kitDirectory){
        const src=path.resolve(config.kitDirectory);for(const name of ['packages','licenses'])fs.cpSync(path.join(src,name),path.join(kit,name),{recursive:true});
      }else{
        const payload=require('./payload.lock.json');const file=path.join(dir,'office-components.zip');
        await download(payload.url,file,payload.sha256,400*1024*1024);
        // The ZIP is authored and hash-pinned by Wing, never an arbitrary user archive.
        if(process.platform==='win32')await run('tar.exe',['-xf',file,'-C',kit],180000);else if(process.platform==='darwin')await run('/usr/bin/ditto',['-x','-k',file,kit],180000);else await run('python3',['-m','zipfile','-e',file,kit],180000);
      }
      for(const item of engine.packages)if(await digest(path.join(kit,'packages',item.name))!==item.sha256)throw new Error('Office 包校验失败：'+item.name);
      const actual=fs.readdirSync(path.join(kit,'packages'));if(actual.some(n=>!engine.packages.some(x=>x.name===n)))throw new Error('包含未许可的额外 Office 包');
      for(const name of ['Dockerfile','container-entrypoint.py'])fs.copyFileSync(path.join(__dirname,name),path.join(kit,name));
      const base=require('./base-image.lock.json');await download(base.url,path.join(kit,'ubuntu-root.tar.gz'),base.sha256,100*1024*1024);
      emit('building-engine','构建本机 Office 引擎，首次需要下载 Linux 基础依赖');
      await d(['build','--platform','linux/amd64','--label',LABEL+'=managed','-t',IMAGE,kit],30*60000);
    }
    emit('starting-engine','启动本地 Office');
    await d(['run','-d','--platform','linux/amd64','--name',NAME,'--label',LABEL+'=managed','--restart','unless-stopped','-p','127.0.0.1:19980:9980','--add-host','host.docker.internal:host-gateway','--cap-add','MKNOD','--cap-add','SYS_CHROOT','-e','WING_WOPI_ORIGIN='+callback,'-e','WING_FRAME_ORIGIN='+frame,IMAGE],120000);
  }else{
    const env=prior.Config.Env||[];
    if(!env.includes('WING_WOPI_ORIGIN='+callback)||!env.includes('WING_FRAME_ORIGIN='+frame))throw new Error('本地 Office 的回传端口已改变。请停止当前编辑后使用修复连接操作。');
    await d(['start',NAME]);
  }
  emit('checking-engine','验证编辑引擎与文件回传通道');
  for(let n=0;n<40;n++){
    try{
      const r=await fetch('http://127.0.0.1:19980/hosting/discovery',{signal:AbortSignal.timeout(3000)});
      if(r.ok&&(await r.text()).includes('wopi-discovery')){
        await d(['exec',NAME,'curl','--fail','--silent','--max-time','10',config.healthUrl],15000);
        emit('ready','本地 Office 已安装并连接',{url:'http://127.0.0.1:19980',callback,frameOrigin:frame});return;
      }
    }catch{/* wait for service startup */}
    await sleep(3000);
  }
  throw new Error('引擎或文件回传检查失败，请检查虚拟化、防火墙和 19980 端口；未标记为安装成功');
}
if(require.main===module){
  process.on('SIGTERM',()=>{aborted=true;child?.kill();});
  try{const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));main(config).catch(e=>{emit('failed',e.message);process.exitCode=1;});}catch(e){emit('failed',e.message);process.exitCode=1;}
}
module.exports={tools,safeOrigin,main};
