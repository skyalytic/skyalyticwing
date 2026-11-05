import { Module } from '@nestjs/common';
import { PluginLoaderService } from './plugin-loader.service.js';
import { PluginService } from './plugin.service.js';
import { PluginController } from './plugin.controller.js';

/**
 * PluginModule - 插件管理模块
 *
 * 提供 PluginService（插件元数据/配置/加载卸载）与 PluginLoaderService（沙箱化加载）。
 * 依赖 ToolRegistryService（由全局 ToolExecutorModule 提供）注册插件工具；
 * SecurityManagerService 由全局 SecurityModule 提供用于源路径校验。
 */
@Module({
  providers: [PluginLoaderService, PluginService],
  controllers: [PluginController],
  exports: [PluginService, PluginLoaderService],
})
export class PluginModule {}
