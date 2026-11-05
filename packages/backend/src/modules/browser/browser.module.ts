import { Module } from '@nestjs/common';
import { BuiltInBrowserService } from './browser.service.js';
import { BrowserController } from './browser.controller.js';

/**
 * 内置浏览器模块：自托管 headless 浏览器（playwright-core 驱动系统 Edge/Chrome），
 * 提供页面内元素标记引擎、截图流快照、元素点选与 AI 可驱动操作。
 * 导出 BuiltInBrowserService 供 AI 工具执行器（ModuleRef 懒解析）使用。
 */
@Module({
  controllers: [BrowserController],
  providers: [BuiltInBrowserService],
  exports: [BuiltInBrowserService],
})
export class BrowserModule {}
