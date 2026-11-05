import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorOAuthService } from '../../src/modules/ecosystem/connector-oauth.service';
import type { CatalogItem } from '../../src/modules/ecosystem/ecosystem.service';
describe('connector OAuth lifecycle',()=>{
  let root:string,service:ConnectorOAuthService;const prior=process.env['SKYALYTICWING_DATA_DIR'];
  const http={post:jest.fn()};const mcp={setCredentialRefresh:jest.fn(),stopServer:jest.fn(),updateServer:jest.fn(),startServer:jest.fn()};
  const item:CatalogItem={id:'oauth-fixture',kind:'mcp',name:'Fixture',version:'1.0.0',description:'',publisher:'test',source:'https://example.com',license:'MIT',permissions:[],artifactSha256:'',minDesktopVersion:'2.0.0',install:{spec:'fixture@1.0.0',args:[],defaults:{},envKeys:['ACCESS_TOKEN']},oauth:{clientId:'public-client',authorizationUrl:'https://accounts.example.com/authorize',tokenUrl:'https://accounts.example.com/token',revocationUrl:'https://accounts.example.com/revoke',scopes:['files.read'],tokenEnv:'ACCESS_TOKEN'}};
  beforeEach(()=>{jest.resetAllMocks();root=mkdtempSync(join(tmpdir(),'wing-oauth-'));process.env['SKYALYTICWING_DATA_DIR']=root;
    service=new ConnectorOAuthService(http as never,mcp as never);service.onModuleInit();
    http.post.mockResolvedValue({status:200,data:{access_token:'private-access',refresh_token:'private-refresh',token_type:'Bearer',expires_in:3600,scope:'files.read'}});
  });
  afterEach(()=>{jest.restoreAllMocks();service.onModuleDestroy();if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(root,{recursive:true,force:true});});
  async function authorize(){const begun=await service.begin(item);const url=new URL(begun.url);const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','authorization-code');const response=await fetch(callback);await response.text();return {url,response};}
  it('validates state, uses S256 PKCE, encrypts tokens and returns no secrets',async()=>{
    const begun=await service.begin(item);const url=new URL(begun.url);expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state','wrong');callback.searchParams.set('code','code');expect((await fetch(callback)).status).toBe(400);expect(http.post).not.toHaveBeenCalled();
    callback.searchParams.set('state',url.searchParams.get('state')!);const response=await fetch(callback);expect(response.status).toBe(200);await response.text();
    const params=new URLSearchParams(http.post.mock.calls[0][1]);expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    const disk=readFileSync(join(root,'connector-oauth.json'),'utf8');expect(disk).not.toContain('private-access');expect(disk).not.toContain('private-refresh');expect(JSON.stringify(service.status(item.id))).not.toContain('private');
    expect(mcp.updateServer).toHaveBeenCalledWith('skyalytic:oauth-fixture',expect.objectContaining({env:{ACCESS_TOKEN:'private-access'}}));
  });
  it('refreshes once for concurrent requests and revokes the rotated token',async()=>{
    http.post.mockResolvedValueOnce({status:200,data:{access_token:'old',refresh_token:'old-refresh',token_type:'Bearer',expires_in:1,scope:'files.read'}});await authorize();
    const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+2000);await Promise.all([service.ensureFresh('skyalytic:oauth-fixture'),service.ensureFresh('skyalytic:oauth-fixture')]);expect(http.post).toHaveBeenCalledTimes(2);
    const result=await service.revoke(item.id);expect(result.remoteRevoked).toBe(true);expect(new URLSearchParams(http.post.mock.calls[2][1]).get('token')).toBe('private-refresh');
    expect(readFileSync(join(root,'connector-oauth.json'),'utf8')).toBe('{}');expect(readFileSync(join(root,'connector-oauth.json.bak'),'utf8')).toBe('{}');
  });
  it('rejects elevated scopes without enabling the connector',async()=>{
    http.post.mockResolvedValue({status:200,data:{access_token:'secret',token_type:'Bearer',expires_in:3600,scope:'files.write'}});
    const {response}=await authorize();expect(response.status).toBe(400);expect(mcp.startServer).not.toHaveBeenCalled();expect(service.status(item.id).status).toBe('error');
  });
});

