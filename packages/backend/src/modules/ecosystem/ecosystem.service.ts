import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, Inject, Optional } from '@nestjs/common';
import { createHash, verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { HttpClientService } from '../core/http/http-client.service.js';
import { McpService } from '../tools/mcp/mcp.service.js';
import { TemplateInstallerService } from './template-installer.service.js';
import { ConnectorOAuthService, type ConnectorOAuth } from './connector-oauth.service.js';
import { EcosystemPolicyService } from './ecosystem-policy.service.js';
import { connectorFields } from './connector-fields.js';
import { LocalResourcePolicy } from '../core/security/local-resource-policy.service.js';
import { NativeResourceInstaller } from './native-resource-installer.service.js';

export const CATALOG_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxMaA9HUcBF1bVhv5PK5v9rKAjBmv6VPAk3/YpIRwhUs=\n-----END PUBLIC KEY-----';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export interface CatalogItem {
  oauth?: ConnectorOAuth;
  id: string; name: string; description: string; version: string; kind: 'skill' | 'mcp' | 'plugin' | 'expert' | 'team';
  entry?: string;
  publisher: string; source: string; license: string; permissions: string[]; artifactSha256: string;
  minDesktopVersion: string; install?: { spec: string; args: string[]; defaults: Record<string,string>; envKeys: string[] };
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

@Injectable()
export class EcosystemService {
  private readonly baseRoot = resolve(process.env['SKYALYTICWING_DATA_DIR'] || getDefaultDataDir(), 'skills');
  private get root() { return join(this.enterprisePolicy?.localResourceRoot?.(dirname(this.baseRoot)) || dirname(this.baseRoot), basename(this.baseRoot)); }
  private readonly busy = new Set<string>();
  constructor(private readonly http: HttpClientService, private readonly mcp: McpService,
    @Optional() @Inject('ECOSYSTEM_CATALOG_KEY') private readonly publicKey: string = CATALOG_PUBLIC_KEY,
    @Optional() private readonly templates?: TemplateInstallerService,
    @Optional() private readonly oauth?: ConnectorOAuthService,
    @Optional() private readonly policy?: EcosystemPolicyService,
    @Optional() private readonly enterprisePolicy?: LocalResourcePolicy,
    @Optional() private readonly native?: NativeResourceInstaller) {}
  private base(): string {
    const preview=process.env['SKYALYTICWING_ECOSYSTEM_PREVIEW_URL'];
    if(preview && process.env['NODE_ENV']!=='production') {
      const u=new URL(preview);if(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash)return u.href.replace(/\/$/,'');
    }
    return 'https://skyalytic.com/api/ecosystem/v1';
  }
  private async get<T>(path: string, text=false): Promise<T> {
    const r=await this.http.get<T>(this.base()+path,{timeout:15000,maxRedirects:0,responseType:text?'text':'json'});
    if(r.status!==200)throw new ServiceUnavailableException('官网生态暂不可用或资源未上架');return r.data;
  }
  async catalog(q='',kind=''):Promise<{items:CatalogItem[];installed:CatalogItem[];source:string;preview:boolean;paymentChannels?:Record<string,boolean>}> {
    const result=await this.get<{items:CatalogItem[]}>('/catalog?q='+encodeURIComponent(q.slice(0,100))+'&kind='+encodeURIComponent(kind));
    if(!Array.isArray(result.items)||result.items.length>1000)throw new ServiceUnavailableException('官网目录格式无效');
    return {items:result.items.filter(item=>!item.id.startsWith('community-')&&!item.id.startsWith('enterprise-')&&!((item as any).priceCents>0)),installed:this.installed(),source:'https://skyalytic.com',preview:this.base().startsWith('http:')};
  }
  installed(): CatalogItem[] {
    if(existsSync(this.root)&&lstatSync(this.root).isSymbolicLink())throw new BadRequestException('技能目录不可使用符号链接');
    const items: CatalogItem[]=[];
    for(const entry of existsSync(this.root)?readdirSync(this.root,{withFileTypes:true}):[])if(entry.isDirectory()&&validId(entry.name)){
      const p=join(this.root,entry.name,'.skyalytic-install.json');
      if(existsSync(p)&&!lstatSync(p).isSymbolicLink())try{const m=JSON.parse(readFileSync(p,'utf8'));if(m.id===entry.name)items.push(m);}catch{/* unrelated local files */}
    }
    // MCP receipts contain no user credentials. Credentials stay in the existing local MCP store.
    const receipts=join(dirname(this.root),'ecosystem-mcp');
    if(existsSync(receipts)&&!lstatSync(receipts).isSymbolicLink())for(const name of readdirSync(receipts)){
      if(!/^[a-z0-9-]+\.json$/.test(name))continue;
      if(lstatSync(join(receipts,name)).isSymbolicLink())continue;
      try{const m=JSON.parse(readFileSync(join(receipts,name),'utf8'));if(this.mcp.listServers().some(s=>s.id==='skyalytic:'+m.id))items.push(m);}catch{/* invalid receipt ignored */}
    }
    return [...items,...(this.templates?.installed() || []),...(this.native?.installed() || [])];
  }
  async install(id: string, alreadyLocked=false, current=()=>true) {
    const scope = this.root, wasCurrent = current;
    current = () => wasCurrent() && this.root === scope;
    if(!validId(id))throw new BadRequestException('资源 ID 无效');
    if(!alreadyLocked&&this.busy.has(id))throw new ConflictException('资源正在安装');this.busy.add(id);
    try {
      if(id.startsWith('community-')||id.startsWith('enterprise-'))throw new BadRequestException('Account resources are unavailable');
      const signed=await this.get<{manifest:CatalogItem;signature:string;sha256:string;keyId:string}>('/items/'+id);
      const m=signed.manifest;const bytes=Buffer.from(canonical(m));
      if(!current())throw new ConflictException('资源目录已变化，请重试');
      if(m.id!==id||signed.keyId!=='skyalytic-2026-preview-1'||hash(bytes)!==signed.sha256||!verify(null,bytes,this.publicKey,Buffer.from(signed.signature,'base64')))throw new BadRequestException('官网资源签名无效');
      this.policy?.check(m);
      if(m.kind==='skill'||m.kind==='mcp'||m.kind==='plugin')await this.enterprisePolicy?.assert(m.kind,m.kind==='mcp'?'skyalytic:'+id:id);
      if(!current())throw new ConflictException('资源目录已变化，请重试');
      if(!['skill','mcp','plugin','expert','team'].includes(m.kind)||m.minDesktopVersion!=='2.0.0'||!m.license||typeof m.source!=='string'||!m.source.startsWith('https://'))throw new BadRequestException('资源类型、来源或兼容版本无效');
      if(this.installed().some(x=>x.id===id)&&!(alreadyLocked&&m.kind==='plugin'))throw new ConflictException('已安装，请先卸载后更换版本');
      this.policy?.audit('install.request',id+'@'+m.version);
      if(m.kind==='mcp') {
        const i=m.install;
        if(!i||!/^(@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+$/.test(i.spec)||!Array.isArray(i.args)||i.args.length>30||!i.args.every(a=>typeof a==='string'&&a.length<300)||!Array.isArray(i.envKeys))throw new BadRequestException('MCP 配置无效');
        const receiptDir=join(dirname(this.root),'ecosystem-mcp');mkdirSync(receiptDir,{recursive:true});if(lstatSync(receiptDir).isSymbolicLink())throw new BadRequestException('收据目录无效');
        this.mcp.addServer({id:'skyalytic:'+id,name:m.name,command:'npx',args:['--yes',i.spec,...i.args],env:i.defaults||{},enabled:false});
        try{writeFileSync(join(receiptDir,id+'.json'),JSON.stringify(m),{flag:'wx'});}catch(e){this.mcp.removeServer('skyalytic:'+id);throw e}
        return {success:true,note:'已安装，等待配置连接。请在当前页面填写授权信息；首次连接会从 npm 下载固定版本及依赖。'};
      }
      if(!/^[a-f0-9]{64}$/.test(m.artifactSha256))throw new BadRequestException('制品摘要无效');
      const payload=await this.get<string>('/artifacts/'+m.artifactSha256,true);
      if(!current())throw new ConflictException('资源目录已变化，请重试');
      if(typeof payload!=='string'||Buffer.byteLength(payload)>8*1024*1024||hash(payload)!==m.artifactSha256)throw new BadRequestException('下载内容校验失败');
      if(m.kind==='expert'||m.kind==='team'){
        if(!this.templates)throw new ServiceUnavailableException('模板安装器未启用');
        return this.templates.install(m,payload);
      }
      const bundle=JSON.parse(payload) as {files:Array<{path:string;content:string;sha256:string}>};
      if(!Array.isArray(bundle.files)||bundle.files.length>100||!bundle.files.some(f=>f.path===(m.kind==='plugin'?'plugin.json':'SKILL.md'))||!bundle.files.some(f=>typeof f.path==='string'&&f.path.startsWith('LICENSE')))throw new BadRequestException('资源缺少内容或许可证');
      const names=new Set<string>();let total=0;
      const files=bundle.files.map(f=>{
        if(typeof f.path!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))||f.path.startsWith('.')||names.has(f.path.toLowerCase()))throw new BadRequestException('制品包含非法路径');
        if(typeof f.content!=='string')throw new BadRequestException('制品文件内容无效');
        names.add(f.path.toLowerCase());const data=Buffer.from(f.content,'base64');total+=data.length;if(total>5*1024*1024||hash(data)!==f.sha256)throw new BadRequestException('制品文件损坏');return {path:f.path,data};
      });
      if(m.kind==='plugin'){
        if(!this.native||!m.entry||!/^[a-zA-Z0-9_/-]+\.(cjs|js)$/.test(m.entry)||!files.some(f=>f.path===m.entry)||files.some(f=>f.path==='wing-enterprise-entry.cjs'))throw new BadRequestException('内部插件入口无效');
        return await this.native.install(m,files,alreadyLocked);
      }
      mkdirSync(this.root,{recursive:true});if(lstatSync(this.root).isSymbolicLink())throw new BadRequestException('技能目录不可使用符号链接');
      const target=join(this.root,id);if(existsSync(target))throw new ConflictException('本地存在同名技能，不会覆盖');
      const tmp=join(this.root,'.install-'+id);if(existsSync(tmp))throw new ConflictException('发现未完成安装，请先检查暂存目录');mkdirSync(tmp);
      try{for(const f of files){const p=join(tmp,f.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,f.data,{flag:'wx'});}writeFileSync(join(tmp,'.skyalytic-install.json'),JSON.stringify(m));renameSync(tmp,target);}catch(e){rmSync(tmp,{recursive:true,force:true});throw e}
      return {success:true,note:'已安装到本地技能目录'};
    }finally{if(!alreadyLocked)this.busy.delete(id)}
  }
  private backupRoot(id:string){return join(dirname(this.root),'ecosystem-backups',id);}
  async upgrade(id:string){
    if(!validId(id)||this.busy.has(id))throw new ConflictException('资源不可升级');
    const old=this.installed().find(item=>item.id===id);if(!old)throw new BadRequestException('资源未安装');
    if(old.kind==='expert'||old.kind==='team')throw new BadRequestException('专家模板导入后由你编辑；请解除关联后导入新版，保留原专家');
    if(old.kind==='plugin'){this.busy.add(id);try{return await this.install(id,true);}finally{this.busy.delete(id);}}
    this.busy.add(id);const backup=this.backupRoot(id);
    try{
      // Keep one full rollback generation, including locally edited skill files.
      if(existsSync(backup))throw new ConflictException('已有回滚版本，请先回滚或删除回滚副本后升级');
      mkdirSync(backup,{recursive:true});if(lstatSync(backup).isSymbolicLink())throw new BadRequestException('回滚目录无效');
      writeFileSync(join(backup,'manifest.json'),JSON.stringify(old));
      if(old.kind==='skill')renameSync(join(this.root,id),join(backup,'skill'));
      else {if(old.oauth&&this.oauth)await this.oauth.revoke(id);this.mcp.removeServer('skyalytic:'+id);renameSync(join(dirname(this.root),'ecosystem-mcp',id+'.json'),join(backup,'mcp.json'));}
      try{return await this.install(id,true);}catch(e){this.restoreBackup(id);throw e;}
    }finally{this.busy.delete(id);}
  }
  private restoreBackup(id:string){
    const backup=this.backupRoot(id);const old=JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8')) as CatalogItem;
    if(old.id!==id||!['skill','mcp'].includes(old.kind))throw new BadRequestException('回滚记录无效');
    if(old.kind==='skill'){
      const target=join(this.root,id);if(existsSync(target))throw new ConflictException('请先移走新版技能');
      cpSync(join(backup,'skill'),target,{recursive:true,errorOnExist:true,force:false});
    }else{
      if(!old.install)throw new BadRequestException('回滚配置无效');
      this.mcp.addServer({id:'skyalytic:'+id,name:old.name,command:'npx',args:['--yes',old.install.spec,...old.install.args],env:old.install.defaults,enabled:false});
      writeFileSync(join(dirname(this.root),'ecosystem-mcp',id+'.json'),JSON.stringify(old));
    }
  }
  rollback(id:string){
    if(!validId(id)||this.busy.has(id))throw new ConflictException('资源不可回滚');
    if(this.native?.installed().some(i=>i.id===id))return this.native.rollback(id);
    const backup=this.backupRoot(id);if(!existsSync(join(backup,'manifest.json')))throw new BadRequestException('没有回滚版本');
    const current=this.installed().find(item=>item.id===id);
    if(current?.oauth)throw new BadRequestException('请先撤销 OAuth 授权并卸载新版，再回滚');
    // Preserve the current skill as well so rollback never discards user edits.
    if(current?.kind==='skill'){
      const retained=join(backup,'replaced-'+Date.now());renameSync(join(this.root,id),retained);
      try{this.restoreBackup(id);}catch(e){renameSync(retained,join(this.root,id));throw e;}
    }else{if(current)this.uninstall(id);this.restoreBackup(id);}
    return {success:true,note:'已恢复上一个版本；连接器保持停用，请重新授权。技能新版副本保留在本地 ecosystem-backups。'};
  }
  discardBackup(id:string){
    if(!validId(id)||this.busy.has(id))throw new BadRequestException('资源不可操作');
    if(this.native?.installed().some(i=>i.id===id))return this.native.discardBackup(id);
    const backup=this.backupRoot(id);if(existsSync(backup)&&lstatSync(backup).isSymbolicLink())throw new BadRequestException('回滚目录无效');
    rmSync(backup,{recursive:true,force:true});return {success:true};
  }
  uninstall(id: string) {
    if(!validId(id))throw new BadRequestException('资源 ID 无效');if(this.busy.has(id))throw new ConflictException('资源正在安装');
    const item=this.installed().find(x=>x.id===id);if(!item)throw new BadRequestException('资源未安装');
    if(item.kind==='plugin')return this.native!.uninstall(id).then(result=>{return result;});
    if(item.kind==='expert'||item.kind==='team')return this.templates!.uninstall(id);
    if(item.kind==='mcp'){this.mcp.removeServer('skyalytic:'+id);rmSync(join(dirname(this.root),'ecosystem-mcp',id+'.json'));}
    else {const target=join(this.root,id);if(lstatSync(target).isSymbolicLink()||dirname(target)!==this.root)throw new BadRequestException('路径无效');rmSync(target,{recursive:true});}
    
    return {success:true};
  }
  /** Credentials remain in the private local MCP configuration; never return them to the catalog. */
  async approveVersion(id:string){
    if(!validId(id)||!this.policy)throw new BadRequestException('资源或策略不可用');
    const signed=await this.get<{manifest:CatalogItem;signature:string;sha256:string;keyId:string}>('/items/'+id);
    const bytes=Buffer.from(canonical(signed.manifest));
    if(signed.manifest.id!==id||signed.keyId!=='skyalytic-2026-preview-1'||hash(bytes)!==signed.sha256||!verify(null,bytes,this.publicKey,Buffer.from(signed.signature,'base64')))throw new BadRequestException('官网资源签名无效');
    return this.policy.approve(signed.manifest);
  }

  async revoke(id:string){
    if(!validId(id)||this.busy.has(id))throw new BadRequestException('资源不可操作');
    const item=this.installed().find(x=>x.id===id&&x.kind==='mcp');if(!item)throw new BadRequestException('连接器未安装');
    if(item.oauth&&this.oauth)return this.oauth.revoke(id);
    this.mcp.stopServer('skyalytic:'+id);this.mcp.updateServer('skyalytic:'+id,{env:{},enabled:false});
    return {success:true,note:'已停用连接器并清除本地凭据；第三方应用密钥可在其管理平台撤销'};
  }

  connectionStatus() {
    return this.mcp.listServers().filter(s=>s.id.startsWith('skyalytic:')).map(s=>({id:s.id.slice(10),status:s.status,enabled:s.enabled}));
  }

  configuration(id: string) {
    if(!validId(id))throw new BadRequestException('资源 ID 无效');
    const item=this.installed().find(x=>x.id===id&&x.kind==='mcp');
    if(!item?.install)throw new BadRequestException('连接器未安装');
    const saved=this.mcp.getEnvironmentForConfiguration('skyalytic:'+id);
    return {fields:connectorFields(item.install).map(field=>({...field,configured:Boolean(saved[field.key]),value:field.secret?'':saved[field.key]||field.defaultValue||''})),
      source:item.source,description:item.description};
  }

  async configure(id: string, env: unknown) {
    if(!validId(id)||!env||typeof env!=='object'||Array.isArray(env))throw new BadRequestException('连接配置无效');
    if(this.busy.has(id))throw new ConflictException('资源正在操作');
    const item=this.installed().find(x=>x.id===id&&x.kind==='mcp');
    if(!item?.install)throw new BadRequestException('连接器未安装');
    this.policy?.check(item);
    if(item.oauth)throw new BadRequestException('请使用浏览器授权此连接器');
    const fields=connectorFields(item.install);
    const keys=fields.map(f=>f.key);
    const supplied=env as Record<string,unknown>;
    if(Object.keys(supplied).some(k=>!keys.includes(k)))throw new BadRequestException('包含未声明的凭据字段');
    const credentials:Record<string,string>={...item.install.defaults};
    const saved=this.mcp.getEnvironmentForConfiguration('skyalytic:'+id);
    for(const field of fields){
      const raw=supplied[field.key];
      if(raw!==undefined&&(typeof raw!=='string'||raw.length>8192))throw new BadRequestException('授权字段格式无效');
      const value=(typeof raw==='string'?raw.trim():'')||saved[field.key]||field.defaultValue||'';
      if(field.required&&!value)throw new BadRequestException('请填写授权字段：'+field.label);
      if(field.type==='port'&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>65535))throw new BadRequestException('端口必须为 1–65535');
      if(field.type==='boolean'&&!['true','false'].includes(value))throw new BadRequestException('TLS 设置必须为 true 或 false');
      if(['\r','\n',String.fromCharCode(0)].some(c=>value.includes(c)))throw new BadRequestException('授权字段不能包含换行或空字符');
      if(value)credentials[field.key]=value;
    }
    this.busy.add(id);
    const serverId='skyalytic:'+id;
    try{
      this.mcp.stopServer(serverId);
      this.mcp.updateServer(serverId,{env:credentials,enabled:true});
      await this.mcp.startServer(serverId);
      const tools=await this.mcp.listTools(serverId);
      return {success:true,toolCount:tools.length,note:'插件已连接并读取工具列表；第三方账号权限需以实际任务结果为准'};
    }catch{
      this.mcp.stopServer(serverId);
      this.mcp.updateServer(serverId,{enabled:false});
      throw new ServiceUnavailableException('连接验证失败，已停用。请检查凭据、网络及本机 Node.js 环境后重试。');
    }finally{this.busy.delete(id)}
  }
}
