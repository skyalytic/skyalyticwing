import { NativeOfficeService, NativeOfficeController } from './native-office.service.js';
import { DocumentHistoryController } from './document-history.controller.js';
import { Module } from '@nestjs/common';
import { FilesService } from './files.service.js';
import { FilesController } from './files.controller.js';
import { OfficeService, OfficeController } from './office.service.js';
import { OfficeEngineService, OfficeEngineController } from './office-engine.service.js';
import { DatabaseService, DatabaseController } from './database.service.js';
import { LocalOfficeService, LocalOfficeController } from './local-office.service.js';

/**
 * FilesModule - 文件服务模块
 *
 * 依赖 SecurityManagerService（全局模块提供）。
 *
 * Controllers:
 *   - FilesController: /api/files/serve、/api/files/read、/api/files/list、/api/exec/command
 */
@Module({
  providers: [NativeOfficeService, FilesService, OfficeService, OfficeEngineService, DatabaseService, LocalOfficeService],
  controllers: [DocumentHistoryController, NativeOfficeController, FilesController, OfficeController, OfficeEngineController, DatabaseController, LocalOfficeController],
  exports: [FilesService, NativeOfficeService],
})
export class FilesModule {}
