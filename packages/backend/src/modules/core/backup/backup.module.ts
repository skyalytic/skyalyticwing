import { Module } from '@nestjs/common';
import { BackupService } from './backup.service.js';
import { BackupController } from './backup.controller.js';

/**
 * BackupModule - 备份模块
 *
 * 备份目录：packages/web/data/backups/
 * 依赖 LoggerService / SecurityManagerService（由全局模块提供）。
 */
@Module({
  providers: [BackupService],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
