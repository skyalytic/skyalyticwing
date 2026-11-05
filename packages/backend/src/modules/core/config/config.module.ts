import { Global, Module } from '@nestjs/common';
import { LlmModule } from '../../ai/llm/llm.module.js';
import { ConfigService } from './config.service.js';
import { ConfigController } from './config.controller.js';

/**
 * ConfigModule - 全局配置模块
 *
 * 通过 @Global() 装饰，只需在 AppModule 中导入一次，
 * 其它模块即可直接注入 ConfigService。
 *
 * 导入 LlmModule 以获取 ProviderService，实现 /api/config/test-provider 端点
 * （LlmModule 自身不导入本模块，无循环依赖）。
 */
@Global()
@Module({
  imports: [LlmModule],
  providers: [ConfigService],
  controllers: [ConfigController],
  exports: [ConfigService],
})
export class ConfigModule {}
