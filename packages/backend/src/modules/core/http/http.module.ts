import { Global, Module } from '@nestjs/common';
import { HttpClientService } from './http-client.service.js';

/**
 * HttpModule - 全局 HTTP 客户端模块
 *
 * 通过 @Global() 装饰，HttpClientService 可在任意模块注入。
 * 依赖 SecurityManagerService（由 SecurityModule 全局提供）进行 SSRF 校验。
 */
@Global()
@Module({
  providers: [HttpClientService],
  exports: [HttpClientService],
})
export class HttpModule {}
