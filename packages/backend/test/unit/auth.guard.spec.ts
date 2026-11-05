import 'reflect-metadata';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '../../src/modules/core/security/auth.guard.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';
import { issueDesignFrameToken } from '../../src/modules/core/security/design-frame-token.js';

/** 构造 ConfigService mock：security.auth 段可变 */
function makeConfig(auth: Record<string, unknown> | undefined): ConfigService {
  const security: Record<string, unknown> = auth === undefined ? {} : { auth };
  return {
    get: (section: string) => {
      if (section !== 'security') throw new Error(`Section '${section}' not found`);
      return security;
    },
  } as unknown as ConfigService;
}

/** 构造 Nest ExecutionContext mock（switchToHttp().getRequest()） */
function makeContext(
  path: string,
  headers: Record<string, string> = {},
): ExecutionContext {
  const request = { path, url: path, headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('AuthGuard - HTTP REST 可选鉴权', () => {
  it('accepts a scoped frame capability without exposing the API token', () => {
    const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'private-api-secret' }));
    const id = '12345678-1234-1234-1234-123456789abc';
    const token = issueDesignFrameToken(id);
    expect(guard.canActivate(makeContext(`/api/files/design-frame/${id}?renderToken=${token}`))).toBe(true);
    expect(() => guard.canActivate(makeContext(`/api/files/design-frame/12345678-1234-1234-1234-123456789abd?renderToken=${token}`))).toThrow(HttpException);
    expect(() => guard.canActivate(makeContext(`/api/files/read?renderToken=${token}`))).toThrow(HttpException);
  });
  it('未配置鉴权（security 段缺失）→ 直接放行', () => {
    const guard = new AuthGuard(makeConfig(undefined));
    expect(guard.canActivate(makeContext('/api/chat', {}))).toBe(true);
  });

  it('auth.mode=none（默认）→ 放行，与现状一致', () => {
    const guard = new AuthGuard(makeConfig({ mode: 'none', token: 'secret' }));
    expect(guard.canActivate(makeContext('/api/chat', {}))).toBe(true);
  });

  it('auth.mode=none 且无 token → 放行', () => {
    const guard = new AuthGuard(makeConfig({ mode: 'none' }));
    expect(guard.canActivate(makeContext('/api/tools', {}))).toBe(true);
  });

  describe('auth.mode=token（已启用鉴权）', () => {
    it.each(['/API/chat', '/Api/tools', '/API', '/api'])('大小写或根路径 %s 不能绕过鉴权', (path) => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'secret' }));
      expect(() => guard.canActivate(makeContext(path))).toThrow(HttpException);
    });

    it('Authorization: Bearer 正确 token → 放行', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      const ctx = makeContext('/api/chat', { authorization: 'Bearer my-secret-token' });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('X-Auth-Token 正确 token → 放行', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      const ctx = makeContext('/api/chat', { 'x-auth-token': 'my-secret-token' });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('错误 token → 401', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      const ctx = makeContext('/api/chat', { authorization: 'Bearer wrong-token' });
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
      try {
        guard.canActivate(ctx);
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('长度不同的 token → 401（不等长快速失败）', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'abc' }));
      const ctx = makeContext('/api/chat', { authorization: 'Bearer aaaa' });
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    });

    it('缺少 token 头 → 401', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      expect(() => guard.canActivate(makeContext('/api/chat', {}))).toThrow(HttpException);
    });

    it('空 Authorization 头 → 401', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      const ctx = makeContext('/api/chat', { authorization: '' });
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    });

    it('fail-close：mode=token 但未配置 token → 401', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token' }));
      const ctx = makeContext('/api/chat', { authorization: 'Bearer anything' });
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
      try {
        guard.canActivate(ctx);
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('白名单：/health 放行（无需 token）', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      expect(guard.canActivate(makeContext('/health', {}))).toBe(true);
    });

    it('旧本地账号接口也必须通过本机 Token 校验', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      expect(() => guard.canActivate(makeContext('/api/auth/login', {}))).toThrow(HttpException);
    });

    it('白名单：非 /api/ 前缀的静态资源放行（前端页面壳）', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      expect(guard.canActivate(makeContext('/', {}))).toBe(true);
      expect(guard.canActivate(makeContext('/assets/index.js', {}))).toBe(true);
    });

    it('受保护 API：/api/chat 无 token → 401', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'my-secret-token' }));
      expect(() => guard.canActivate(makeContext('/api/chat', {}))).toThrow(HttpException);
    });

    it('大小写不敏感的 Bearer 前缀 → 放行', () => {
      const guard = new AuthGuard(makeConfig({ mode: 'token', token: 'tk' }));
      const ctx = makeContext('/api/chat', { authorization: 'bearer tk' });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});
