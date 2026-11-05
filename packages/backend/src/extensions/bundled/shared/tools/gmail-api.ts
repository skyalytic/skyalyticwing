import type { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import type { ConfigService } from '../../../../modules/core/config/config.service.js';
export async function gmailApi(action:'search'|'send',args:Record<string,unknown>,config:ConfigService,http:HttpClientService){
  try{
    let raw:unknown;try{raw=process.env['GMAIL_CREDENTIALS']?JSON.parse(process.env['GMAIL_CREDENTIALS']):config.get('gmail');}catch{throw new Error('配置格式错误');}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {success:false,error:'Gmail 未配置：需要已授权的 Google OAuth client_id、client_secret、refresh_token，或有效 access_token'};
    const c=raw as Record<string,unknown>;let token=c['access_token'];
    if(c['refresh_token']){
      if(!['client_id','client_secret','refresh_token'].every(k=>typeof c[k]==='string'&&c[k]))return {success:false,error:'Gmail OAuth 刷新凭据不完整'};
      const response=await http.post<{access_token?:string}>('https://oauth2.googleapis.com/token',new URLSearchParams({grant_type:'refresh_token',client_id:String(c['client_id']),client_secret:String(c['client_secret']),refresh_token:String(c['refresh_token'])}).toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},maxRedirects:0,timeout:15000});
      if(response.status!==200||!response.data.access_token)return {success:false,error:'Google 授权刷新失败，请重新授权'};token=response.data.access_token;
    }
    if(typeof token!=='string'||!token||/[\r\n]/.test(token))return {success:false,error:'Gmail 缺少有效访问凭据'};
    const options={headers:{Authorization:'Bearer '+token},maxRedirects:0,timeout:15000};
    if(action==='search'){
      if(typeof args['query']!=='string'||!args['query']||args['query'].length>2000)return {success:false,error:'请输入有效搜索条件'};
      const n=args['maxResults']===undefined?10:Number(args['maxResults']);if(!Number.isInteger(n)||n<1||n>50)return {success:false,error:'maxResults 需要为 1–50'};
      const q=new URLSearchParams({q:args['query'],maxResults:String(n)});
      if(args['labelIds']!==undefined){if(!Array.isArray(args['labelIds'])||args['labelIds'].some(x=>typeof x!=='string'))return {success:false,error:'labelIds 格式无效'};for(const id of args['labelIds'])q.append('labelIds',id);}
      const r=await http.get<{messages?:Array<{id:string;threadId:string}>;nextPageToken?:string;resultSizeEstimate?:number}>('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+q,options);
      if(r.status!==200)return {success:false,error:'Gmail 搜索失败 HTTP '+r.status};
      const messages=[];for(const m of (r.data.messages||[]).slice(0,n)){
        const detail=await http.get<Record<string,unknown>>('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(m.id)+'?format=metadata',options);
        if(detail.status!==200)return {success:false,error:'Gmail 部分邮件读取失败 HTTP '+detail.status};
        messages.push({id:m.id,threadId:m.threadId,snippet:detail.data['snippet'],headers:(detail.data['payload'] as {headers?:unknown})?.headers});
      }
      const data={messages,nextPageToken:r.data.nextPageToken,resultSizeEstimate:r.data.resultSizeEstimate};return {success:true,output:JSON.stringify(data),data};
    }
    const headers=[];for(const key of ['to','cc','bcc']){
      const value=args[key];if(value===undefined&&key!=='to')continue;
      if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value)||!value.split(',').every(x=>/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(x.trim())))return {success:false,error:'邮件地址无效（仅支持逗号分隔的邮箱地址）'};
      headers.push(key+': '+value);
    }
    if(typeof args['subject']!=='string'||args['subject'].length>500||/[\r\n]/.test(args['subject'])||typeof args['body']!=='string'||Buffer.byteLength(args['body'])>1024*1024)return {success:false,error:'主题或正文格式无效，正文上限 1 MB'};
    const subject=Buffer.from(args['subject']).toString('base64'),body=Buffer.from(args['body']).toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
    const rawMail=[...headers,'Subject: =?UTF-8?B?'+subject+'?=','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+body].join('\r\n');
    const r=await http.post<{id?:string;threadId?:string}>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{raw:Buffer.from(rawMail).toString('base64url')},options);
    if(r.status!==200||!r.data.id)return {success:false,error:'Gmail 未确认发送成功，请检查已发送邮件后再决定是否重试'};
    return {success:true,output:JSON.stringify(r.data),data:r.data};
  }catch{return {success:false,error:'Gmail 请求失败；检查 OAuth 配置、授权范围和网络。发送超时时不要自动重复发送，请先核对已发送邮件。'};}
}
