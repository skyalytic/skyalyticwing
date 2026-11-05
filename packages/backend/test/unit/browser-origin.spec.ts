import 'reflect-metadata';
import { browserOriginMiddleware, isTrustedBrowserRequest } from '../../src/modules/core/security/browser-origin.util.js';
import { WebSocketGateway } from '../../src/modules/core/websocket/websocket.gateway.js';
import { ChatGateway } from '../../src/modules/ai/chat/chat.gateway.js';

describe('local server browser boundary', () => {
  it.each(['https://attacker.example', 'null', 'http://localhost.attacker.example:910', 'http://127.0.0.1:9999'])('拒绝来源 %s', (origin) => {
    expect(isTrustedBrowserRequest({ origin, host: '127.0.0.1:910' })).toBe(false);
  });
  it('允许本地界面和不携带 Origin 的 CLI', () => {
    expect(isTrustedBrowserRequest({ origin: 'http://localhost:910', host: '127.0.0.1:910' })).toBe(true);
    expect(isTrustedBrowserRequest({ host: '127.0.0.1:910' })).toBe(true);
  });
  it('开发代理可用，生产需要明确配置额外来源', () => {
    const headers = { origin: 'http://localhost:1420', host: '127.0.0.1:910' };
    expect(isTrustedBrowserRequest(headers, { NODE_ENV: 'development' })).toBe(true);
    expect(isTrustedBrowserRequest(headers, { NODE_ENV: 'production' })).toBe(false);
    expect(isTrustedBrowserRequest(headers, { NODE_ENV: 'production', SKYALYTICWING_ALLOWED_ORIGINS: headers.origin })).toBe(true);
  });
  it('域名解析到本地也不能冒充本地界面', () => {
    expect(isTrustedBrowserRequest({ origin: 'http://attacker.example:910', host: 'attacker.example:910' })).toBe(false);
    expect(isTrustedBrowserRequest({ host: 'attacker.example:910' })).toBe(false);
  });
  it('在路由处理前直接返回 403', () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    browserOriginMiddleware({ headers: { origin: 'https://attacker.example' } } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it.each([WebSocketGateway, ChatGateway])('%p 在注册 WS 客户端前拒绝外站连接', (Gateway) => {
    const ws = { getConnectionCount: () => 0, register: jest.fn() };
    const config = { get: () => ({ auth: { mode: 'none' } }) };
    const gateway = new (Gateway as any)(config, ws, {}, {}, {});
    const socket = { close: jest.fn(), send: jest.fn(), readyState: 1 };
    gateway.handleConnection(socket, { headers: { origin: 'https://attacker.example', host: '127.0.0.1:910' } });
    expect(socket.close).toHaveBeenCalled();
    expect(ws.register).not.toHaveBeenCalled();
  });
});
