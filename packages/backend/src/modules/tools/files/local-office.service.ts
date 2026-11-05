import { BadRequestException, Body, Controller, Get, Injectable, Post, Req } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { OfficeEngineService } from './office-engine.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';

interface LocalState { phase: string; message: string; bridgePort?: number; frameOrigin?: string; updatedAt: number; }
@Injectable()
export class LocalOfficeService {
  private readonly directory=join(getDefaultDataDir(),'local-office');
  private readonly file=join(this.directory,'state.json');
  private state: LocalState=readJsonRecover(this.file,{phase:'not-installed',message:'尚未安装本地 Office',updatedAt:Date.now()});
  private process: ChildProcess | undefined;
  private bridge: Server | undefined;
  private readonly healthToken=randomBytes(24).toString('hex');
  constructor(private readonly office: OfficeEngineService) {}
  private assets() {
    let parent=__dirname;
    for(let i=0;i<9;i++){
      for(const p of [join(parent,'office-installer'),join(parent,'deploy','office-engine')])if(existsSync(join(p,'local-engine.cjs')))return p;
      parent=dirname(parent);
    }
    throw new BadRequestException('安装包缺少本地 Office 安装组件，请重新安装完整 Wing 包');
  }
  status(){ return {...this.state,running:!!this.process,platform:process.platform,architecture:process.arch}; }
  private update(phase:string,message:string){this.state={...this.state,phase,message:message.slice(0,2000),updatedAt:Date.now()};writeJsonAtomicSync(this.file,this.state);}
  async onModuleInit(){
    if(this.state.phase==='ready'&&this.state.frameOrigin&&!this.office.configuration().managed){
      try{await this.start(this.state.frameOrigin,false,'start');}catch(e){this.update('failed','恢复本地 Office 失败：'+String(e));}
    }else if(!['not-installed','stopped','failed','cancelled','runtime-required','system-setup-required','restart-required'].includes(this.state.phase))this.update('interrupted','上次安装被中断，可继续安装');
  }
  private async ensureBridge(){
    if(this.bridge)return;
    let active=0;
    const server=createServer(async(req,res)=>{
      let url:URL;try{url=new URL(req.url||'/','http://localhost');}catch{res.writeHead(400);res.end();return;}
      if(req.method==='GET'&&url.pathname==='/health/'+this.healthToken){res.end('wing-office');return;}
      const match=/^\/api\/office-engine\/wopi\/files\/([a-f0-9]{48})(\/contents)?$/.exec(url.pathname);
      const token=url.searchParams.get('access_token')||'';
      if(!match||!['GET','POST'].includes(req.method||'')||!this.office.validCapability(match[1]!,token)||active>=16){res.writeHead(403);res.end();return;}
      active++;
      try{
        res.setHeader('Cache-Control','no-store');
        if(req.method==='GET'){
          if(match[2]){res.setHeader('Content-Type','application/octet-stream');res.end(this.office.download(match[1]!,token));}
          else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(this.office.info(match[1]!,token)));}
        }else{
          if(!match[2])throw new Error('Unsupported operation');
          let size=0;const chunks:Buffer[]=[];
          for await(const chunk of req){size+=chunk.length;if(size>50*1024*1024)throw new Error('File too large');chunks.push(Buffer.from(chunk));}
          const saved=await this.office.save(match[1]!,token,Buffer.concat(chunks));
          res.statusCode=saved.conflict?409:200;
          if(saved.conflict)res.setHeader('X-WOPI-Lock','');else res.setHeader('X-WOPI-ItemVersion',saved.version!);
          res.end(JSON.stringify(saved.conflict?{error:'Version conflict'}:{LastModifiedTime:new Date().toISOString()}));
        }
      }catch{if(!res.headersSent)res.writeHead(400);res.end('Office request failed');}finally{active--;}
    });
    server.requestTimeout=60000;server.headersTimeout=15000;
    await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(this.state.bridgePort||0,'0.0.0.0',()=>{server.removeListener('error',fail);ok();});});
    this.bridge=server;this.state.bridgePort=(server.address() as {port:number}).port;writeJsonAtomicSync(this.file,this.state);
  }
  async start(origin:string,installRuntime:boolean,action:'start'|'repair'|'stop'='start'){
    if(this.process)throw new BadRequestException('已有安装或维护任务在运行');
    if(this.office.configuration().managed)throw new BadRequestException('此引擎由企业部署管理');
    let url:URL;try{url=new URL(origin);}catch{throw new BadRequestException('工作台地址无效');}
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new BadRequestException('自动安装仅支持本机工作台；远程工作台请配置企业私有引擎');
    const assets=this.assets();mkdirSync(this.directory,{recursive:true});
    if(action==='repair'&&!this.bridge)delete this.state.bridgePort;
    await this.ensureBridge();
    this.state.frameOrigin=url.origin;
    const callback='http://host.docker.internal:'+this.state.bridgePort;
    const config=join(this.directory,'install-request.json');
    writeFileSync(config,JSON.stringify({directory:this.directory,frameOrigin:url.origin,callback,healthUrl:callback+'/health/'+this.healthToken,installRuntime,action}),{mode:0o600});
    this.update('checking','检测本地运行环境');
    const child=spawn(process.execPath,[join(assets,'local-engine.cjs'),config],{windowsHide:true,stdio:['ignore','pipe','pipe']});this.process=child;
    let pending='',lastError='';
    child.stdout?.on('data',chunk=>{
      pending+=chunk.toString();if(pending.length>64000)pending=pending.slice(-64000);
      let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);
        try{const event=JSON.parse(line);if(event.phase==='ready')this.office.configure({url:event.url,internal:event.url,callback:event.callback,frameOrigin:event.frameOrigin});if(typeof event.phase==='string'&&typeof event.message==='string')this.update(event.phase,event.message);}catch(e){lastError=String(e);this.update('failed','无法配置本地引擎：'+lastError);}
      }
    });
    child.stderr?.on('data',b=>{lastError=(lastError+b.toString()).slice(-2000);});
    child.once('error',e=>{this.process=undefined;this.update('failed',e.message);});
    child.once('exit',code=>{this.process=undefined;if(code!==0&&!['failed','cancelled'].includes(this.state.phase))this.update('failed',lastError||'安装进程中断');});
    return this.status();
  }
  cancel(){if(this.process){this.process.kill();this.update('cancelled','已请求取消；已下载组件保留，可重试。运行中的文档不会被删除。');}return this.status();}
  enableWindows(){
    if(process.platform!=='win32'||this.process)throw new BadRequestException('当前不能进行 Windows 系统配置');
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(this.assets(),'enable-wsl.ps1')],{windowsHide:true,stdio:'ignore'});this.process=child;this.update('system-setup','等待 Windows 系统授权');
    child.once('error',e=>{this.process=undefined;this.update('failed',e.message);});
    child.once('exit',code=>{this.process=undefined;this.update(code===0||code===3010?'restart-required':'system-setup-required',code===0||code===3010?'系统组件已配置；如 Windows 要求重启，请重启后继续安装。':'Windows 未完成授权或安装，请检查 WSL 2 与虚拟化后重试。');});return this.status();
  }
  allowFirewall(){
    if(process.platform!=='win32'||this.process||!this.state.bridgePort)throw new BadRequestException('请先尝试安装本地 Office，再处理回传权限');
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(this.assets(),'allow-wopi-firewall.ps1'),'-Port',String(this.state.bridgePort),'-Program',process.execPath],{windowsHide:true,stdio:'ignore'});this.process=child;this.update('system-setup','等待 Windows 授权本地 Office 文件回传');
    child.once('error',e=>{this.process=undefined;this.update('failed',e.message);});
    child.once('exit',code=>{this.process=undefined;this.update(code===0?'runtime-required':'failed',code===0?'已允许当前程序在专用网络的本地子网回传文件，请继续安装。':'防火墙配置未完成，请联系本机管理员。');});return this.status();
  }
  onModuleDestroy(){this.process?.kill();this.bridge?.closeAllConnections();this.bridge?.close();}
}
@Controller('office-engine/local')
export class LocalOfficeController {
  constructor(private readonly local:LocalOfficeService){}
  private requireLocal(req:Request){if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress||''))throw new BadRequestException('只能在本机操作本地引擎安装');}
  @Get('status')status(){return this.local.status();}
  @Post('install')install(@Req()req:Request,@Body()body:{origin:string;repair?:boolean}){this.requireLocal(req);return this.local.start(body.origin,true,body.repair?'repair':'start');}
  @Post('cancel')cancel(@Req()req:Request){this.requireLocal(req);return this.local.cancel();}
  @Post('stop')stop(@Req()req:Request,@Body()body:{origin:string}){this.requireLocal(req);return this.local.start(body.origin,false,'stop');}
  @Post('enable-windows')windows(@Req()req:Request){this.requireLocal(req);return this.local.enableWindows();}
  @Post('allow-firewall')firewall(@Req()req:Request){this.requireLocal(req);return this.local.allowFirewall();}
}
