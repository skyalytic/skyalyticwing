import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FilesController } from '../../src/modules/tools/files/files.controller.js';
import { FilesService } from '../../src/modules/tools/files/files.service.js';
import { RedactInterceptor } from '../../src/modules/core/logger/redact.interceptor.js';
import { AuthGuard } from '../../src/modules/core/security/auth.guard.js';

it('preserves scoped preview credentials over authenticated HTTP', async () => {
  const frameId='12345678-1234-1234-1234-123456789abc';
  const files={createDesignFrame:jest.fn(()=>frameId),getDesignFrame:jest.fn(()=>'<p>Preview OK</p>')};
  @Module({controllers:[FilesController],providers:[{provide:FilesService,useValue:files}]}) class Fixture {}
  const app=await NestFactory.create(Fixture,{logger:false});app.setGlobalPrefix('api');
  app.useGlobalGuards(new AuthGuard({get:()=>({auth:{mode:'token',token:'fixture-auth'}})} as any));
  app.useGlobalInterceptors(new RedactInterceptor());await app.listen(0,'127.0.0.1');
  try {
    const base=await app.getUrl(),headers={'Content-Type':'application/json',Authorization:'Bearer fixture-auth'};
    const post=(path:string,body:object)=>fetch(base+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body)});
    expect((await fetch(base+'/api/files/design-frame',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
    const frameResponse=await post('files/design-frame',{html:'<p>Preview OK</p>'});
    expect(frameResponse.headers.get('cache-control')).toBe('no-store');
    const frame=await frameResponse.json();expect(frame.renderToken).not.toBe('***');
    expect(await (await fetch(base+'/api/files/design-frame/'+frame.id+'?renderToken='+encodeURIComponent(frame.renderToken))).text()).toBe('<p>Preview OK</p>');
    expect((await fetch(base+'/api/files/design-frame/'+frame.id+'?renderToken=***')).status).toBe(401);
    expect((await fetch(base+'/api/files/design-frame?renderToken='+encodeURIComponent(frame.renderToken),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
  } finally {await app.close();}
},30000);
