import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { HttpClientService } from '../core/http/http-client.service.js';
import { McpService } from '../tools/mcp/mcp.service.js';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { sealSecret, openSecret } from '../core/utils/local-secrets.js';
import type { CatalogItem } from './ecosystem.service.js';

export interface ConnectorOAuth {
  authorizationUrl:string; tokenUrl:string; revocationUrl?:string; issuer?:string;
  clientId:string; scopes:string[]; tokenEnv:string; resource?:string;
}
interface TokenRecord { config:ConnectorOAuth; defaults:Record<string,string>; accessToken:string; refreshToken?:string; expiresAt:number; refreshAt:number; scopes:string[]; }
type Attempt={id:string;state:string;redirectUri:string;server:Server;timer:ReturnType<typeof setTimeout>};

/** Registered public native OAuth clients; tokens feed the signed stdio adapter's declared env field. */
@Injectable()
export class ConnectorOAuthService implements OnModuleInit,OnModuleDestroy {
  private readonly pending=new Map<string,Attempt>();
  private readonly refreshing=new Map<string,Promise<void>>();
  private readonly revoking=new Set<string>();
  private readonly statuses=new Map<string,{status:string;error?:string}>();
  private records:Record<string,string>={};
  constructor(private readonly http:HttpClientService,private readonly mcp:McpService){}
  private path(){return join(getDefaultDataDir(),'connector-oauth.json');}
  onModuleInit(){this.records=readJsonRecover(this.path(),{});this.mcp.setCredentialRefresh(id=>this.ensureFresh(id));}
  onModuleDestroy(){for(const attempt of this.pending.values())this.close(attempt);}
  private save(){writeJsonAtomicSync(this.path(),this.records);writeJsonAtomicSync(this.path(),this.records);}
  private validate(config:ConnectorOAuth){
    for(const endpoint of [config.authorizationUrl,config.tokenUrl,config.revocationUrl,config.issuer,config.resource].filter(Boolean)){
      const url=new URL(endpoint!);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new BadRequestException('OAuth 端点必须是 HTTPS');
    }
    if(!config.clientId||!Array.isArray(config.scopes)||config.scopes.some(s=>typeof s!=='string'||/\s/.test(s))||!/^[A-Z][A-Z0-9_]{0,80}$/.test(config.tokenEnv))throw new BadRequestException('OAuth 客户端配置无效');
  }
  async begin(item:CatalogItem){
    const config=item.oauth;if(!config||!item.install?.envKeys.includes(config.tokenEnv))throw new BadRequestException('连接器未声明 OAuth');this.validate(config);
    if(this.revoking.has(item.id)||this.refreshing.has(item.id)||this.statuses.get(item.id)?.status==='exchanging')throw new BadRequestException('授权正在更新，请稍后重试');
    for(const old of this.pending.values())if(old.id===item.id)this.close(old);
    if(this.pending.size>=10)throw new BadRequestException('待授权连接过多');
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    const server=createServer((req,res)=>{void(async()=>{
      res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      // A single-use callback must not leave a keep-alive socket after the listener closes.
      res.setHeader('Connection','close');
      const attempt=this.pending.get(state);const url=new URL(req.url || '/', 'http://127.0.0.1');
      if(!attempt||req.method!=='GET'||url.pathname!=='/callback'||url.searchParams.get('state')!==state||req.headers.host!==new URL(attempt.redirectUri).host){res.writeHead(400);res.end('授权回调无效');return;}
      this.close(attempt);this.statuses.set(item.id,{status:'exchanging'});
      try{
        const code=url.searchParams.get('code');if(!code||code.length>8192||url.searchParams.has('error')||(config.issuer&&url.searchParams.get('iss')!==config.issuer))throw new Error('Authorization rejected');
        const params=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:attempt.redirectUri,client_id:config.clientId});
        const record=await this.exchange(config,params,item.install!.defaults || {});
        this.records[item.id]=sealSecret(record,'oauth:'+item.id);this.save();
        this.apply(item.id,record);await this.mcp.startServer('skyalytic:'+item.id);
        this.statuses.set(item.id,{status:'connected'});res.end('授权成功，可关闭此页面并返回 Wing。');
      }catch{
        this.mcp.stopServer('skyalytic:'+item.id);this.mcp.updateServer('skyalytic:'+item.id,{enabled:false,env:{}});
        this.statuses.set(item.id,{status:'error',error:'授权失败，请检查第三方应用、回调地址和权限后重试'});res.writeHead(400);res.end('授权失败，请返回 Wing 重试。');
      }
    })().catch(()=>{if(!res.writableEnded){res.writeHead(500);res.end('授权处理失败');}});});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    const address=server.address();if(!address||typeof address==='string')throw new Error('回调监听失败');
    const redirectUri=`http://127.0.0.1:${address.port}/callback`;
    const timer=setTimeout(()=>{const attempt=this.pending.get(state);if(attempt)this.close(attempt);this.statuses.set(item.id,{status:'expired'});},600000);timer.unref();server.unref();
    this.pending.set(state,{id:item.id,state,redirectUri,server,timer});this.statuses.set(item.id,{status:'pending'});
    const url=new URL(config.authorizationUrl);for(const [key,value] of Object.entries({response_type:'code',client_id:config.clientId,redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:config.scopes.join(' '),...(config.resource?{resource:config.resource}:{})}))url.searchParams.set(key,value);
    return {url:url.href,scopes:config.scopes,expiresIn:600};
  }
  status(id:string){return this.statuses.get(id) || {status:this.records[id]?'authorized':'disconnected'};}
  private close(attempt:Attempt){clearTimeout(attempt.timer);attempt.server.close();this.pending.delete(attempt.state);}
  private async exchange(config:ConnectorOAuth,params:URLSearchParams,defaults:Record<string,string>,previous?:TokenRecord):Promise<TokenRecord>{
    if(config.resource)params.set('resource',config.resource);
    const response=await this.http.post<Record<string,unknown>>(config.tokenUrl,params.toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:15000,maxRedirects:0});
    const d=response.data;
    if(response.status!==200||typeof d['access_token']!=='string'||!d['access_token']||d['access_token'].length>65536||String(d['token_type']).toLowerCase()!=='bearer'||!Number.isFinite(Number(d['expires_in']))||Number(d['expires_in'])<1)throw new Error('Invalid token response');
    const scopes=typeof d['scope']==='string'?d['scope'].split(' ').filter(Boolean):previous?.scopes || config.scopes;
    if(scopes.some(scope=>!config.scopes.includes(scope)))throw new Error('Unexpected scope escalation');
    const refresh=typeof d['refresh_token']==='string'?d['refresh_token']:previous?.refreshToken;
    const lifetime=Math.min(Number(d['expires_in']),31536000)*1000;
    return {config,defaults,accessToken:d['access_token'],expiresAt:Date.now()+lifetime,refreshAt:Date.now()+lifetime-Math.min(30000,lifetime/10),scopes,...(refresh?{refreshToken:refresh}:{})};
  }
  private apply(id:string,record:TokenRecord){this.mcp.stopServer('skyalytic:'+id);this.mcp.updateServer('skyalytic:'+id,{env:{...record.defaults,[record.config.tokenEnv]:record.accessToken},enabled:true});}
  async ensureFresh(serverId:string):Promise<void>{
    if(!serverId.startsWith('skyalytic:'))return;const id=serverId.slice(10);
    if(this.revoking.has(id))throw new Error('连接器授权正在撤销');
    const sealed=this.records[id];if(!sealed)return;
    const record=openSecret<TokenRecord>(sealed,'oauth:'+id);if((record.refreshAt || record.expiresAt)>Date.now())return;
    if(this.refreshing.has(id))return this.refreshing.get(id)!;
    const job=(async()=>{try{
      if(!record.refreshToken)throw new Error('Reauthorization required');
      const updated=await this.exchange(record.config,new URLSearchParams({grant_type:'refresh_token',refresh_token:record.refreshToken,client_id:record.config.clientId}),record.defaults,record);
      this.records[id]=sealSecret(updated,'oauth:'+id);this.save();this.apply(id,updated);
    }catch{this.mcp.stopServer(serverId);this.mcp.updateServer(serverId,{enabled:false,env:{}});this.statuses.set(id,{status:'error',error:'授权已失效，请重新连接'});throw new Error('连接器授权已失效，请重新连接');}})();
    this.refreshing.set(id,job);try{await job;}finally{this.refreshing.delete(id);}
  }
  async revoke(id:string){
    if(this.revoking.has(id)||this.statuses.get(id)?.status==='exchanging')throw new BadRequestException('授权更新中，请稍后撤销');
    this.revoking.add(id);
    try {
    for(const attempt of this.pending.values())if(attempt.id===id)this.close(attempt);
    await this.refreshing.get(id)?.catch(()=>undefined);
    const sealed=this.records[id];let remoteRevoked=false;
    if(sealed){const record=openSecret<TokenRecord>(sealed,'oauth:'+id);if(record.config.revocationUrl)try{
      const response=await this.http.post(record.config.revocationUrl,new URLSearchParams({client_id:record.config.clientId,token:record.refreshToken || record.accessToken,token_type_hint:record.refreshToken?'refresh_token':'access_token'}).toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:10000,maxRedirects:0});remoteRevoked=response.status===200;
    }catch{ /* Clear locally even if the remote revoke endpoint is unavailable. */ }}
    delete this.records[id];this.save();this.statuses.set(id,{status:'disconnected'});
    this.mcp.stopServer('skyalytic:'+id);this.mcp.updateServer('skyalytic:'+id,{env:{},enabled:false});
    return {success:true,remoteRevoked,note:remoteRevoked?'已撤销第三方授权并清除本地凭据':'本地授权已清除；请到第三方平台确认远端授权已撤销'};
    } finally { this.revoking.delete(id); }
  }
}
