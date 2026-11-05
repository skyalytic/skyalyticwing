import { Module } from '@nestjs/common';
import { CustomToolsService } from './custom-tools.service.js';
import { CustomToolsController } from './custom-tools.controller.js';

/**
 * CustomToolsModule - 自定义工具模块
 *
 * 数据存储：packages/web/data/custom-tools.json
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [CustomToolsService],
  controllers: [CustomToolsController],
  exports: [CustomToolsService],
})
export class CustomToolsModule {}
