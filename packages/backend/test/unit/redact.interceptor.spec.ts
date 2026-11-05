import 'reflect-metadata';
import { firstValueFrom, of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { RedactInterceptor } from '../../src/modules/core/logger/redact.interceptor.js';
import { WeixinController, WecomController } from '../../src/modules/channels/wechat/wechat.controller.js';
import { sanitizeToolOutput } from '../../src/modules/tools/tool.controller.js';

describe('response redaction', () => {
  it('preserves agent usage through both tool sanitization and response redaction', async () => {
    const payload = {tokens:234,usage:{totalTokens:234,reservedTokens:'500'},token:'private',apiKey:'private'};
    const actual = await firstValueFrom(new RedactInterceptor().intercept({} as ExecutionContext,{handle:()=>of(sanitizeToolOutput(payload))}));
    expect(actual).toEqual({...payload,token:'***',apiKey:'***'});
  });
  it('keeps only validated masked key previews, never unmasked key values', async () => {
    const payload={providers:[{maskedApiKey:'sk-x****',apiKey:'private',hasApiKey:true},{maskedApiKey:'${OPENAI_API_KEY}'},{maskedApiKey:'raw-private-key'}]};
    const actual=await firstValueFrom(new RedactInterceptor().intercept({} as ExecutionContext,{handle:()=>of(payload)}));
    expect(actual).toEqual({providers:[{maskedApiKey:'sk-x****',apiKey:'***',hasApiKey:true},{maskedApiKey:'${OPENAI_API_KEY}'},{maskedApiKey:'***'}]});
  });
  it('preserves nested enterprise activation flags without exposing password fields', async () => {
    const payload = { members: [0, 1, false, true, '0', '1'].map(mustChangePassword => ({mustChangePassword, password: 'private', passwordHash: 'private'})), mustChangePassword: 'unexpected-sensitive-value' };
    const actual = await firstValueFrom(new RedactInterceptor().intercept({} as ExecutionContext, {handle: () => of(payload)}));
    expect(actual).toEqual({members: [false, true, false, true, false, true].map(mustChangePassword => ({mustChangePassword, password: '***', passwordHash: '***'})), mustChangePassword: '***'});
  });
  it.each([
    [WeixinController.prototype.poll, 'botToken'],
    [WeixinController.prototype.cliStatus, 'botToken'],
    [WecomController.prototype.poll, 'secret'],
    [WecomController.prototype.cliStatus, 'secret'],
  ])('keeps only the explicitly issued top-level credential intact', async(handler, field)=>{
    const payload={botToken:'issued-token',secret:'issued-secret',apiKey:'private',nested:{botToken:'private',secret:'private'}};
    const context={getHandler:()=>handler} as unknown as ExecutionContext;
    const actual=await firstValueFrom(new RedactInterceptor().intercept(context,{handle:()=>of(payload)}));
    expect(actual).toEqual({botToken:field==='botToken'?'issued-token':'***',secret:field==='secret'?'issued-secret':'***',apiKey:'***',nested:{botToken:'***',secret:'***'}});
  });
  it('preserves numeric model usage and limits while masking actual credentials', async () => {
    const payload = {
      usage: { promptTokens: 17, completionTokens: 25, totalTokens: 42, cached_tokens: 8 },
      maxTokens: 2048,
      apiKey: 'private',
      OPENAI_API_KEY: 'private',
      access_token: 'private',
      token: 123456,
      totalTokens: 'not-a-number',
      tls: { key: 'private' },
      attachment: { url: '/api/files/serve?path=image.png' },
    };
    const actual = await firstValueFrom(
      new RedactInterceptor().intercept({} as ExecutionContext, { handle: () => of(payload) }),
    );
    expect(actual).toEqual({
      ...payload,
      apiKey: '***',
      OPENAI_API_KEY: '***',
      access_token: '***',
      token: '***',
      totalTokens: '***',
      tls: { key: '***' },
    });
  });
  it('keeps model context, reserved usage and exact decimal prices through nested responses', async () => {
    const payload = {models: [{maxInputTokens: 1000000, contextWindowTokens: 1000000, maxOutputTokens: 393216,
      inputYuanPerToken: '0.000002000000', outputYuanPerToken: '0.000004',
      tokenPriceTiers: [{minTokens: 128000, maxTokens: null}]}], usage: {reservedTokens: '9007199254740993', estimatedTokens: 200},
      contextToken: 'private', token: '123456', maxInputTokens: 'private', reservedTokens: 'sk-secret'};
    const actual = await firstValueFrom(new RedactInterceptor().intercept({} as ExecutionContext, {handle: () => of(payload)}));
    expect(actual).toEqual({...payload, contextToken: '***', token: '***', maxInputTokens: '***', reservedTokens: '***'});
  });
});
