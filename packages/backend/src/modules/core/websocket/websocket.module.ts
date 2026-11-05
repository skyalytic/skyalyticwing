import { Global, Module } from '@nestjs/common';
import { WebSocketGateway } from './websocket.gateway.js';
import { WebSocketService } from './websocket.service.js';

/**
 * WebSocketModule - 全局 WebSocket 模块
 *
 * 通过 @Global() 装饰，WebSocketService 可在任意业务模块注入以广播事件。
 * WebSocketGateway 由 NestJS 自动装配到 HTTP 服务器（路径 /ws）。
 *
 * 依赖：
 *   - @nestjs/platform-ws 已在 AppModule 中通过 useWebSocketAdapter 启用
 *   - ConfigService 用于读取 security.auth.mode / token
 */
@Global()
@Module({
  providers: [WebSocketGateway, WebSocketService],
  exports: [WebSocketService],
})
export class WebSocketModule {}
