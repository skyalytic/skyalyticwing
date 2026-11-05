import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-support.js';
import { ConfigService } from '../../src/modules/core/config/config.service.js';

/**
 * 应用基础集成测试（健康检查 / 前缀豁免 / 404 兜底）。
 * chat / tools / websocket 三类链路用例见对应独立 spec（设计 §7.2）：
 *   chat.e2e-spec.ts / tools.e2e-spec.ts / websocket.e2e-spec.ts
 */
describe('App (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 180_000);

  afterAll(async () => {
    await e2e?.close();
  });

  it('GET /health 返回 200（SystemController，前缀豁免）', () =>
    request(e2e.app.getHttpServer()).get('/health').expect(200));

  it('GET /api/health 返回 404（/health 被 exclude 豁免全局前缀，仅注册为 /health）', () =>
    request(e2e.app.getHttpServer()).get('/api/health').expect(404));

  it('未知 API 路由返回 404', () =>
    request(e2e.app.getHttpServer()).get('/api/this-route-does-not-exist').expect(404));

  it('外部网页对本地 API 的请求直接被拒绝', () =>
    request(e2e.app.getHttpServer()).get('/api/tools').set('Origin', 'https://attacker.example').expect(403));

  it('Token 鉴权保护大小写等价的实际 HTTP 路由', async () => {
    const config = e2e.app.get(ConfigService);
    const previous = config.get('security');
    config.set('security', { auth: { mode: 'token', token: 'audit-test-token' } });
    try {
      await request(e2e.app.getHttpServer()).get('/API/tools').expect(401);
      await request(e2e.app.getHttpServer()).get('/API/tools').set('Authorization', 'Bearer audit-test-token').expect(200);
    } finally {
      config.set('security', previous);
    }
  });
});
