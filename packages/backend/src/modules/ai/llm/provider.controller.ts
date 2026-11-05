import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ConfigService } from '../../core/config/config.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import { ProviderService, PROVIDERS_REGISTRY, providerCapabilityDefaults } from './provider.service.js';
import { UpdateProviderDto } from './dto/provider.dto.js';

/**
 * Provider / 模型管理 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET    /api/providers       - 供应商列表（含 configured 状态、maskedApiKey、models 数组）
 *   PUT    /api/providers/:id   - 更新供应商配置（apiKey/baseUrl/models）
 *   DELETE /api/providers/:id   - 删除供应商
 *   POST   /api/providers/:id/test - 测试供应商连通性（返回 success/latency/model）
 *   GET    /api/models          - 所有可用模型（聚合各 provider 的 models）
 *
 * 安全：
 *   - apiKey 在响应中脱敏（只显示前 4 位 + ****）
 *   - 生产环境敏感字段使用环境变量引用（如 "${AUTH_TOKEN}"）
 *   - baseUrl 经 SecurityManagerService SSRF 校验（在 ProviderService 内完成）
 *   - 响应亦经全局 RedactInterceptor 二次脱敏
 */
@ApiTags('Providers')
@Controller()
export class ProviderController {
  constructor(
    private readonly providerService: ProviderService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  @Get('providers')
  list(): ApiResponse<unknown> {
    const result = this.providerService.listProviders();
    // 为每个供应商附加 maskedApiKey（前 4 位 + ****）
    const providers = result.providers.map((p) => {
      const rawApiKey = this.getRawApiKey(p.id);
      const configured = (this.config.get<Record<string, any>>('providers') || {})[p.id] || {};
      const capabilities = Object.fromEntries(['visionModels','imageModels','videoModels','imageProtocol','videoProtocol','imageBaseUrl','videoBaseUrl'].filter(k=>configured[k] !== undefined).map(k=>[k,configured[k]]));
      const reg = PROVIDERS_REGISTRY.find(r=>r.id===(p.baseProvider || p.id));
      const defaults = providerCapabilityDefaults(reg);
      // A saved proxy stays the destination for all capabilities unless the user
      // explicitly saved a separate media endpoint. Never replace it with a vendor host.
      const customRoot = configured.baseUrl && configured.baseUrl.replace(/\/$/, '') !== reg?.baseUrl.replace(/\/$/, '');
      const effectiveDefaults = customRoot ? { ...defaults, imageBaseUrl: configured.baseUrl, videoBaseUrl: configured.baseUrl } : defaults;
      return {
        ...p,
        ...effectiveDefaults,
        ...capabilities,
        catalog: reg?.catalog,
        preset: reg ? { baseUrl: reg.baseUrl, models: [...reg.models], ...defaults } : undefined,
        maskedApiKey: rawApiKey ? maskApiKey(rawApiKey) : undefined,
        hasApiKey: !!rawApiKey,
      };
    });
    return { success: true, data: { providers } };
  }

  @Put('providers/:id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProviderDto,
  ): ApiResponse<{ updated: boolean }> {
    try {
      // 将 DTO 转为 plain object 传递给 service（过滤 undefined 字段）
      const partial: Record<string, unknown> = {};
      for (const key of ['visionModels','imageModels','videoModels','imageProtocol','videoProtocol','imageBaseUrl','videoBaseUrl'] as const) if(dto[key]!==undefined) partial[key]=dto[key];
      if (dto.apiKey !== undefined) partial['apiKey'] = dto.apiKey;
      if (dto.baseUrl !== undefined) partial['baseUrl'] = dto.baseUrl;
      if (dto.models !== undefined) partial['models'] = dto.models;
      if (dto.displayName !== undefined) partial['displayName'] = dto.displayName;
      if (dto.temperature !== undefined) partial['temperature'] = dto.temperature;
      if (dto.maxTokens !== undefined) partial['maxTokens'] = dto.maxTokens;
      if (dto.type !== undefined) partial['type'] = dto.type;
      if (dto.baseProvider !== undefined) partial['baseProvider'] = dto.baseProvider;

      const result = this.providerService.updateProvider(id, partial);
      this.logger.info('Provider updated', { providerId: id, scope: 'provider' });
      return { success: true, data: result };
    } catch (err) {
      this.logger.error('Provider update failed', {
        providerId: id,
        error: err instanceof Error ? err.message : String(err),
        scope: 'provider',
      });
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Delete('providers/:id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): ApiResponse<{ deleted: string }> {
    try {
      const result = this.providerService.deleteProvider(id);
      this.logger.info('Provider deleted', { providerId: id, scope: 'provider' });
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'NOT_FOUND',
      };
    }
  }

  @Post('providers/:id/test')
  @HttpCode(HttpStatus.OK)
  async test(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    this.logger.info('Testing provider connection', { providerId: id, scope: 'provider' });
    const result = await this.providerService.testProvider(id);
    // 对齐旧版语义（start.cjs /providers/:id/test）：HTTP 恒为 200，测试结果直达。
    // 顶层 success 表示"请求本身成功"，测试成败与错误原因完整放 data；
    // 若把测试失败映射为顶层 success=false，前端 apiFetch 会当作请求异常抛出
    // 且顶层无 error 字段，导致真实失败原因（如"未配置API密钥"）被丢弃。
    return {
      success: true,
      data: {
        success: result.success,
        latency: result.latency,
        latencyMs: result.latencyMs,
        model: result.model,
        message: result.message,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }

  @Get('models')
  models(): ApiResponse<unknown> {
    return { success: true, data: this.providerService.listModels() };
  }

  // ─── 内部辅助方法 ──────────────────────────────────────────────────────────

  /** 从配置中读取供应商的原始 apiKey（用于生成 maskedApiKey） */
  private getRawApiKey(providerId: string): string | undefined {
    try {
      const providers = this.config.get<Record<string, unknown>>('providers');
      const cfg = providers[providerId] as Record<string, unknown> | undefined;
      const apiKey = cfg?.['apiKey'];
      if (typeof apiKey === 'string' && apiKey.length > 0) {
        // 环境变量引用（${VAR}）保留原样，不解析
        return apiKey;
      }
    } catch {}
    return undefined;
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 脱敏 API Key（只显示前 4 位 + ****） */
function maskApiKey(value: string): string {
  if (!value || value.length <= 4) return '****';
  // 环境变量引用格式 ${VAR} 不脱敏，直接显示
  if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) return value;
  return value.substring(0, 4) + '****';
}
