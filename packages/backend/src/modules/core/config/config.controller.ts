import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ConfigService } from './config.service.js';
import { ProviderService } from '../../ai/llm/provider.service.js';
import type { ProviderTestResult } from '../../ai/llm/provider.service.js';
import { restoreRedactedConfig } from '../logger/redacted-config.util.js';

/**
 * 配置 REST API
 *
 * 注意：main.ts 已通过 `app.setGlobalPrefix('api', ...)` 设置全局前缀，
 * 因此 @Controller('config') 实际路由为 /api/config。
 *
 * 暴露端点：
 *   GET    /api/config           - 获取全部配置
 *   PUT    /api/config           - 深度合并更新整体配置
 *   GET    /api/config/:section  - 获取指定配置段
 *   PUT    /api/config/:section  - 更新指定配置段（对象则深度合并，否则替换）
 *   GET    /api/config/test-provider?id= - 测试供应商连接（.cjs 行 38739-38741）
 *   POST   /api/config/reload    - 重载配置（.cjs 行 41318-41369）
 *
 * 注意：UpdateConfigDto 仅作为类型文档存在，不在 @Body() 上标注，
 * 避免 ValidationPipe whitelist 模式剥离动态配置字段。
 */
@Controller('config')
export class ConfigController {
  constructor(
    private readonly configService: ConfigService,
    private readonly providerService: ProviderService,
  ) {}

  @Get()
  getAll(): ApiResponse<Record<string, unknown>> {
    return { success: true, data: this.configService.getAll() };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  updateAll(
    @Body() body: Record<string, unknown>,
  ): ApiResponse<{ config: Record<string, unknown> }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { success: false, error: 'Invalid request body: expected object' };
    }
    const merged = this.configService.merge(restoreRedactedConfig(body, this.configService.getAll()) as Record<string, unknown>);
    this.configService.save();
    return { success: true, data: { config: merged } };
  }

  /** 测试供应商连接（结果不含 API Key 等敏感字段） */
  @Get('test-provider')
  async testProvider(@Query('id') id?: string): Promise<ApiResponse<ProviderTestResult>> {
    if (!id) {
      return { success: false, error: 'Provider id required' };
    }
    const result = await this.providerService.testProvider(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  /** 重载配置（从磁盘 config.json 热加载） */
  @Post('reload')
  @HttpCode(HttpStatus.OK)
  reload(): ApiResponse<{ reloadedAt: string }> {
    try {
      this.configService.reload();
      return { success: true, data: { reloadedAt: new Date().toISOString() } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Get(':section')
  getSection(@Param('section') section: string): ApiResponse<{ section: string; value: unknown }> {
    const all = this.configService.getAll();
    if (!(section in all)) {
      return { success: false, error: `Section '${section}' not found`, code: 'NOT_FOUND' };
    }
    return { success: true, data: { section, value: all[section] } };
  }

  @Put(':section')
  @HttpCode(HttpStatus.OK)
  updateSection(
    @Param('section') section: string,
    @Body() body: unknown,
  ): ApiResponse<{ section: string; value: unknown }> {
    if (body === null || body === undefined) {
      return { success: false, error: 'Invalid request body' };
    }
    const value = this.configService.mergeSection(section, restoreRedactedConfig(body, this.configService.getAll()[section], section));
    this.configService.save();
    return { success: true, data: { section, value } };
  }
}
