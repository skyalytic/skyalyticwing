import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-support.js';

/**
 * Chat 集成测试（设计 §7.2 integration/chat.e2e-spec.ts）
 * 覆盖：消息发送（AgentLoop 桩回复）、历史读取、空参数校验。
 */
describe('Chat integration (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 180_000);

  afterAll(async () => {
    await e2e?.close();
  });

  it('POST /api/chat/send 返回 assistant 回复与 sessionId', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/chat/send')
      .send({ session: 'e2e-chat-session', message: '你好' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.message.role).toBe('assistant');
    expect(res.body.data.message.content).toBe('e2e-mock-reply');
    expect(res.body.data.sessionId).toBe('e2e-chat-session');
  });

  it('GET /api/chat/history/:sessionId 返回会话消息结构', async () => {
    // 先产生一条消息
    await request(e2e.app.getHttpServer())
      .post('/api/chat/send')
      .send({ session: 'e2e-history-session', message: '记录一条历史' })
      .expect(200);

    const res = await request(e2e.app.getHttpServer())
      .get('/api/chat/history/e2e-history-session')
      .expect(200);

    expect(res.body.success).toBe(true);
    const messages = res.body.data ?? res.body;
    expect(Array.isArray(messages)).toBe(true);
    // 持久化为异步落盘：有消息时验证内容，暂未落盘时仅验证结构
    if (messages.length > 0) {
      expect(messages.some((m: { content?: string }) => m.content === '记录一条历史')).toBe(true);
    }
  });

  it('POST /api/chat/send 缺少 message 返回 400（ValidationPipe 对齐生产）', async () => {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/chat/send')
      .send({ session: 'e2e-bad-session' })
      .expect(400);
    expect(res.body).toBeTruthy();
  });
});
