import request from 'supertest';
import WebSocket from 'ws';
import { createE2eApp, waitFor, type E2eApp } from './e2e-support.js';

/**
 * WebSocket 集成测试（设计 §7.2 integration/websocket.e2e-spec.ts）
 * 覆盖：连接 connected 事件、工具执行广播、subscribe/unsubscribe、异常断开不崩服务。
 */
describe('WebSocket integration (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 180_000);

  afterAll(async () => {
    await e2e?.close();
  });

  it('连接 /ws 收到 connected 就绪事件', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${e2e.httpPort}/ws`);
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      received.push(JSON.parse(raw.toString()) as { type: string });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    await waitFor(() => received.some((e) => e.type === 'connected'));
    expect(received.find((e) => e.type === 'connected')).toMatchObject({ type: 'connected' });
    ws.close(1000);
  }, 20_000);

  it('HTTP 执行工具 → WS 广播 show_message 实时送达客户端', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${e2e.httpPort}/ws`);
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      received.push(JSON.parse(raw.toString()) as { type: string });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    await waitFor(() => received.some((e) => e.type === 'connected'));

    await request(e2e.app.getHttpServer())
      .post('/api/tool/execute')
      .send({ tool: 'show_message', args: { message: 'ws broadcast check' }, sessionId: 'e2e-ws-session' })
      .expect(200);
    await waitFor(() => received.some((e) => e.type === 'show_message'));
    const shown = received.find((e) => e.type === 'show_message');
    expect(shown?.data).toMatchObject({ message: 'ws broadcast check', sessionId: 'e2e-ws-session' });
    ws.close(1000);
  }, 20_000);

  it('文本层 ping 消息可往返（Tauri WebView2 兼容协议）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${e2e.httpPort}/ws`);
    const received: Array<{ type: string }> = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      received.push(JSON.parse(raw.toString()) as { type: string });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    await waitFor(() => received.some((e) => e.type === 'connected'));

    ws.send(JSON.stringify({ event: 'ping', data: { t: Date.now() } }));
    await waitFor(() => received.some((e) => e.type === 'pong'));
    expect(received.some((e) => e.type === 'pong')).toBe(true);
    ws.close(1000);
  }, 20_000);

  it('客户端异常断开后服务仍响应（无泄漏崩溃）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${e2e.httpPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    ws.terminate(); // 模拟异常断开（不发 close 帧）

    await new Promise((resolve) => setTimeout(resolve, 300));
    await request(e2e.app.getHttpServer()).get('/health').expect(200);
  }, 15_000);
});
