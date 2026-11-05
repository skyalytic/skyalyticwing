import { Module } from '@nestjs/common';
import { VectorsService } from './vectors.service.js';
import { VectorsController } from './vectors.controller.js';

/**
 * VectorsModule - 向量存储模块
 *
 * LanceDB 可用时使用 LanceDB，否则内存 + vectors.json 持久化降级。
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [VectorsService],
  controllers: [VectorsController],
  exports: [VectorsService],
})
export class VectorsModule {}
