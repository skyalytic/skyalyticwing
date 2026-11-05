import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-support.js';

/**
 * Tools 集成测试（设计 §7.2 integration/tools.e2e-spec.ts）
 * 覆盖：内置工具执行、未知工具失败、参数缺失校验。
 */
describe('Tools integration (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 180_000);

  afterAll(async () => {
    await e2e?.close();
  });

  it('POST /api/tool/execute 执行内置工具（show_message）', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/tool/execute')
      .send({ tool: 'show_message', args: { message: 'hi from tools e2e' }, sessionId: 'e2e-tool-session' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.output).toContain('Message shown');
  });

  it('POST /api/tool/execute 未知工具返回失败（不抛 5xx）', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/tool/execute')
      .send({ tool: '__no_such_tool__', args: {}, sessionId: 'e2e-tool-session' })
      .expect(200);

    expect(res.body.success).toBe(false);
  });

  it('POST /api/tool/execute 缺少 tool 字段返回 400（ValidationPipe 对齐生产）', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/tool/execute')
      .send({ args: {} })
      .expect(400);
    expect(res.body).toBeTruthy();
  });

  it('GET /api/tools 返回内置工具清单（含 show_message）', async () => {
    const res = await request(e2e.app.getHttpServer()).get('/api/tools').expect(200);
    const list = res.body.data ?? res.body;
    const names = Array.isArray(list)
      ? list.map((t: { name?: string }) => t.name)
      : Object.values(list).map((t: unknown) => (t as { name?: string })?.name);
    expect(names).toContain('show_message');
  });
});
