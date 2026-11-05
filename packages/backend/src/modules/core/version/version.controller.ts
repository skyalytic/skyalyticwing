import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import {
  MandatoryUpdateService,
  type MandatoryUpdateConfig,
  type MandatoryUpdateState,
} from './mandatory-update.service.js';

/** 强制更新配置更新 DTO（PUT /version/mandatory-config） */
class MandatoryUpdateConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  manifestUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(60_000)
  intervalMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(120_000)
  timeoutMs?: number;
}

/**
 * Version REST API（路由前缀 /api/version）
 *
 * 暴露端点：
 *   GET  /api/version/mandatory-status  - 强制更新策略状态（前端遮罩轮询）
 *   POST /api/version/mandatory-check   - 手动立即检查（绕过退避间隔）
 *   GET  /api/version/mandatory-config  - 查看本地配置（含运行版本）
 *   PUT  /api/version/mandatory-config  - 更新本地配置并立即检查
 */
@ApiTags('Version')
@Controller('version')
export class VersionController {
  constructor(private readonly mandatoryUpdate: MandatoryUpdateService) {}

  /** GET /version/mandatory-status — 当前策略状态 */
  @Get('mandatory-status')
  status(): ApiResponse<MandatoryUpdateState> {
    return { success: true, data: this.mandatoryUpdate.getStatus() };
  }

  /** POST /version/mandatory-check — 手动检查（并发合并） */
  @Post('mandatory-check')
  @HttpCode(HttpStatus.OK)
  async check(): Promise<ApiResponse<MandatoryUpdateState>> {
    const state = await this.mandatoryUpdate.checkNow(true);
    return { success: true, data: state };
  }

  /** GET /version/mandatory-config — 本地配置 */
  @Get('mandatory-config')
  config(): ApiResponse<MandatoryUpdateConfig & { currentVersion: string }> {
    return { success: true, data: this.mandatoryUpdate.getConfig() };
  }

  /** PUT /version/mandatory-config — 更新配置并立即检查 */
  @Put('mandatory-config')
  @HttpCode(HttpStatus.OK)
  updateConfig(@Body() dto: MandatoryUpdateConfigDto): ApiResponse<MandatoryUpdateConfig & { currentVersion: string }> {
    return { success: true, data: this.mandatoryUpdate.updateConfig(dto ?? {}) };
  }
}
