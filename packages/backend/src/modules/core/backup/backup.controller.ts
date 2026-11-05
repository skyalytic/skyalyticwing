import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { BackupService } from './backup.service.js';
import { BackupNameDto, CreateBackupDto } from './dto/backup.dto.js';

/**
 * Backup 备份 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   POST /api/backup/create  - 创建备份（打包 data 目录）
 *   GET  /api/backup/list    - 备份列表
 *   POST /api/backup/verify  - 验证备份完整性（兼容 GET ?name=）
 *   POST /api/backup/restore - 恢复备份
 *   POST /api/backup/delete  - 删除备份
 */
@Controller()
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post('backup/create')
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateBackupDto): Record<string, unknown> {
    return this.backupService.create(dto ?? {}) as Record<string, unknown>;
  }

  @Get('backup/list')
  list(): Record<string, unknown> {
    return { backups: this.backupService.list() };
  }

  @Post('backup/verify')
  @HttpCode(HttpStatus.OK)
  verifyPost(@Body() dto: BackupNameDto): Record<string, unknown> {
    return this.backupService.verify(dto.name);
  }

  @Get('backup/verify')
  verifyGet(@Query('name') name: string): Record<string, unknown> {
    return this.backupService.verify(name ?? '');
  }

  @Post('backup/restore')
  @HttpCode(HttpStatus.OK)
  restore(@Body() dto: BackupNameDto): Record<string, unknown> {
    return this.backupService.restore(dto.name) as Record<string, unknown>;
  }

  @Post('backup/delete')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: BackupNameDto): Record<string, unknown> {
    return this.backupService.delete(dto.name) as Record<string, unknown>;
  }
}
