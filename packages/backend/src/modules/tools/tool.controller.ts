import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ConfigService } from '../core/config/config.service.js';
import { resolveEffectiveWorkspace } from '../core/config/effective-workspace.util.js';
import { LoggerService } from '../core/logger/logger.service.js';
import { isTokenMetric } from '../core/logger/token-metric.util.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import { ToolExecutorService } from './executor/tool-executor.service.js';
import { ApiTags } from '../core/swagger/swagger-decorators.js';
import { ToolRegistryService } from './executor/tool-registry.service.js';
import { ExternalToolLoaderService } from './executor/external-tool-loader.service.js';
import { ExecuteToolDto, SetToolPermissionDto } from './dto/tool.dto.js';
import { ApprovalService } from './executor/approval.service.js';
import { randomUUID } from 'node:crypto';

/**
 * ToolController - 工具列表/执行 REST API（路由前缀 /api）
 *
 * 全量对齐旧版 start.cjs 中 /tools 与 /tool 路由：
 *   GET  /api/tools         - 工具列表（含 loaded/dangerous/disabled/permission 字段）
 *   POST /api/tool/execute  - 执行工具（body: {tool/toolName, args}）
 *   GET  /api/tool-groups   - 工具分组（按 category 聚合）
 *   GET  /api/tool-profiles - 工具配置档案（从 config 读取）
 *   POST /api/tools/reload  - 热重载 @skyalyticwing/tools 包外部工具（设计文档 4.4）
 *
 * 返回结果经 sanitizeToolOutput 脱敏敏感字段（authToken/tls.key/apiKey 等）。
 * 响应亦经全局 RedactInterceptor 二次脱敏。
 */
@ApiTags('Tools')
@Controller()
export class ToolController {
  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly externalToolLoader: ExternalToolLoaderService,
    private readonly security: SecurityManagerService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly approvals: ApprovalService,
  ) {}

  /** GET /tools — 工具列表（含 loaded/dangerous/disabled/permission 字段） */
  @Get('tools')
  listTools(): ApiResponse<Record<string, unknown>[]> {
    const tools = this.toolExecutor.listTools();
    const disabledTools = this.getDisabledTools();
    const toolPermissions = this.getToolPermissions();

    const result = tools.map((t) => {
      const id = t.name;
      const disabled = disabledTools.includes(id);
      const permission = toolPermissions[id] ?? (t.dangerous ? 'ask' : 'allow');
      return {
        id,
        name: t.name,
        description: t.description,
        category: t.category,
        dangerous: t.dangerous,
        loaded: t.loaded,
        disabled,
        permission,
      };
    });

    return { success: true, data: result };
  }

  /** POST /tool/execute — 执行工具 */
  @Get('tools/catalog')
  async toolCatalog(): Promise<ApiResponse<Record<string, unknown>[]>> {
    const tools = await this.toolExecutor.getToolCatalog(), disabled = this.getDisabledTools(), permissions = this.getToolPermissions();
    return { success: true, data: tools.map(t => ({ ...t, id: t.name, disabled: disabled.includes(t.name), permission: permissions[t.name] ?? (t.dangerous ? 'ask' : 'allow') })) };
  }
  @Post('tools/install')
  @HttpCode(HttpStatus.OK)
  async installTool(@Body() body: { name?: unknown }) { return this.changeTool(body, true); }
  @Post('tools/uninstall')
  @HttpCode(HttpStatus.OK)
  async uninstallTool(@Body() body: { name?: unknown }) { return this.changeTool(body, false); }
  private async changeTool(body: { name?: unknown }, installed: boolean) {
    if (typeof body?.name !== 'string' || !body.name.trim()) throw new BadRequestException('Tool name required');
    await this.toolExecutor.setToolInstalled(body.name, installed);
    return { success: true };
  }

  @Post('tool/execute')
  @HttpCode(HttpStatus.OK)
  async executeTool(@Body() dto: ExecuteToolDto): Promise<ApiResponse<unknown>> {
    const toolName = dto.tool ?? dto.toolName;
    if (!toolName) {
      throw new BadRequestException('Missing required field: tool or toolName');
    }

    // 检查工具是否被禁用
    const disabledTools = this.getDisabledTools();
    if (disabledTools.includes(toolName)) {
      return { success: false, error: `Tool '${toolName}' is disabled`, code: 'TOOL_DISABLED' };
    }

    // 检查工具是否存在
    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      return { success: false, error: `Tool not found: ${toolName}`, code: 'NOT_FOUND' };
    }

    // 路径安全校验：若参数中包含路径字段，调用 SecurityManager.isPathAllowed
    if (dto.args) {
      const pathFields = ['path', 'filePath', 'file', 'directory', 'dir', 'cwd', 'workingDir', 'script', 'repoPath', 'source'];
      for (const field of pathFields) {
        const val = (dto.args as Record<string, unknown>)[field];
        if (typeof val === 'string' && val.length > 0) {
          if (!this.security.isPathAllowed(val, 'readwrite')) {
            return { success: false, error: `Path blocked by security guard: ${val}`, code: 'PATH_BLOCKED' };
          }
        }
      }
    }

    // 命令安全校验：若参数中包含 command/cmd 字段，调用 SecurityManager.isCommandAllowed
    if (dto.args) {
      const cmdFields = ['command', 'cmd', 'script'];
      for (const field of cmdFields) {
        const val = (dto.args as Record<string, unknown>)[field];
        if (typeof val === 'string' && val.length > 0) {
          if (!this.security.isCommandAllowed(val)) {
            return { success: false, error: `Command blocked by security guard: ${val}`, code: 'CMD_BLOCKED' };
          }
        }
      }
    }

    const ctx = {
      sessionId: dto.sessionId ?? 'api',
      workspace: resolveEffectiveWorkspace(undefined, dto.sessionId),
      config: this.config.getAll(),
      log: (level: string, message: string): void => {
        this.logger.info(`[tool:${toolName}] ${message}`, { level, scope: 'tool' });
      },
      broadcast: (event: string, _data: unknown): void => {
        this.logger.debug(`[tool:${toolName}] broadcast: ${event}`, { scope: 'tool' });
      },
    };

    try {
      let result = await this.toolExecutor.execute(toolName, dto.args ?? {}, ctx);
      if (result.approvalRequired) {
        const approved = await this.approvals.requestApproval({
          id: randomUUID(), toolName, args: dto.args ?? {}, sessionId: ctx.sessionId,
          reason: result.error ?? `Tool '${toolName}' requires approval`, timestamp: Date.now(),
        });
        result = approved
          ? await this.toolExecutor.execute(toolName, dto.args ?? {}, ctx, { approvalGranted: true })
          : { success: false, error: 'Tool call rejected by user', blocked: true };
      }
      // 脱敏输出中的敏感字段
      const sanitized = sanitizeToolOutput(result);
      return { success: result.success, data: sanitized, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      this.logger.error('Tool execution failed', {
        toolName,
        error: err instanceof Error ? err.message : String(err),
        scope: 'tool',
      });
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GET /tool-groups — 工具分组（按 category 聚合） */
  @Get('tool-groups')
  listToolGroups(): ApiResponse<Record<string, unknown>[]> {
    const tools = this.toolExecutor.listTools();
    const groups = new Map<string, { id: string; name: string; tools: Record<string, unknown>[][] }>();

    for (const t of tools) {
      const category = t.category || 'other';
      if (!groups.has(category)) {
        groups.set(category, { id: category, name: category, tools: [] });
      }
      groups.get(category)!.tools.push([
        { id: t.name, name: t.name, description: t.description, dangerous: t.dangerous },
      ]);
    }

    return { success: true, data: Array.from(groups.values()) };
  }

  /** GET /tool-profiles — 工具配置档案 */
  @Get('tool-profiles')
  listToolProfiles(): ApiResponse<Record<string, unknown>> {
    try {
      const tools = this.config.get<Record<string, unknown>>('tools');
      return { success: true, data: tools };
    } catch {
      return { success: true, data: { profiles: [] } };
    }
  }

  /**
   * POST /tools/reload — 热重载 @skyalyticwing/tools 包外部工具。
   *
   * 先注销上次加载的外部工具，再以 cache-busting 方式重新 import tools 包
   * 产物并注册（内置工具同名冲突时跳过，内置优先）。
   */
  @Post('tools/reload')
  @HttpCode(HttpStatus.OK)
  async reloadExternalTools(): Promise<
    ApiResponse<{ loaded: number; skippedConflicts: string[]; total: number }>
  > {
    try {
      const result = await this.externalToolLoader.reloadExternalTools();
      this.logger.info('External tools reloaded', {
        loaded: result.loaded,
        skipped: result.skippedConflicts.length,
        total: result.total,
        scope: 'tool',
      });
      return { success: true, data: result };
    } catch (err) {
      this.logger.error('External tools reload failed', {
        error: err instanceof Error ? err.message : String(err),
        scope: 'tool',
      });
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** POST /tools/permission — 设置工具权限（对齐旧版 config.js） */
  @Post('tools/permission')
  @HttpCode(HttpStatus.OK)
  setToolPermission(@Body() dto: SetToolPermissionDto): ApiResponse<{ toolId: string }> {
    try {
      if (!dto.toolId?.trim() || ['__proto__', 'constructor', 'prototype'].includes(dto.toolId) ||
          (dto.permission !== undefined && !['auto', 'allow', 'ask', 'disabled'].includes(dto.permission)))
        throw new BadRequestException('Invalid tool permission');
      const previous = this.safeGetToolsConfig();
      const tools = { ...previous };
      const toolSettings = { ...((tools['toolSettings'] ?? {}) as Record<string, unknown>) };
      const toolConfig = { ...((toolSettings[dto.toolId] ?? {}) as Record<string, unknown>) };

      if (dto.disabled !== undefined) {
        toolConfig['disabled'] = dto.disabled;
      }
      if (dto.permission !== undefined) {
        if (dto.permission === 'disabled') toolConfig['disabled'] = true;
        else toolConfig['permission'] = dto.permission === 'allow' ? 'auto' : dto.permission;
      }

      toolSettings[dto.toolId] = toolConfig;
      tools['toolSettings'] = toolSettings;
      this.config.set('tools', tools);
      try { this.config.save(); }
      catch (error) { this.config.set('tools', previous); throw error; }
      this.approvals?.notifyPermissionsChanged();

      this.logger.info('Tool permission updated', {
        toolId: dto.toolId,
        permission: dto.permission,
        disabled: dto.disabled,
        scope: 'tool',
      });

      return { success: true, data: { toolId: dto.toolId } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── 内部辅助方法 ──────────────────────────────────────────────────────────

  /** 读取已禁用工具列表 */
  private getDisabledTools(): string[] {
    try {
      const tools = this.safeGetToolsConfig();
      const toolSettings = (tools['toolSettings'] ?? {}) as Record<string, unknown>;
      const disabled: string[] = [];
      for (const [id, cfg] of Object.entries(toolSettings)) {
        if (cfg && typeof cfg === 'object' && ((cfg as Record<string, unknown>)['disabled'] === true || (cfg as Record<string, unknown>)['permission'] === 'disabled')) {
          disabled.push(id);
        }
      }
      return disabled;
    } catch {
      return [];
    }
  }

  /** 读取工具权限映射 */
  private getToolPermissions(): Record<string, string> {
    try {
      const tools = this.safeGetToolsConfig();
      const toolSettings = (tools['toolSettings'] ?? {}) as Record<string, unknown>;
      const perms: Record<string, string> = {};
      for (const [id, cfg] of Object.entries(toolSettings)) {
        if (cfg && typeof cfg === 'object') {
          const p = (cfg as Record<string, unknown>)['permission'];
          if (typeof p === 'string') perms[id] = p;
        }
      }
      return perms;
    } catch {
      return {};
    }
  }

  /** 安全读取 tools 配置段 */
  private safeGetToolsConfig(): Record<string, unknown> {
    try {
      const v = this.config.get<Record<string, unknown>>('tools');
      if (v !== null && typeof v === 'object') return v;
    } catch {}
    return {};
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 工具输出中需要脱敏的字段名（小写匹配） */
const SENSITIVE_OUTPUT_KEYS = [
  'authtoken',
  'apikey',
  'api_key',
  'tls.key',
  'password',
  'secret',
  'token',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
];

/** 递归脱敏工具输出中的敏感字段 */
export function sanitizeToolOutput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sanitizeToolOutput);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!isTokenMetric(k, v) && isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number')) {
        result[k] = maskSecretValue(String(v));
      } else {
        result[k] = sanitizeToolOutput(v);
      }
    }
    return result;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_OUTPUT_KEYS.some((s) => lower === s || lower.includes(s));
}

/** 脱敏密钥值（只显示前 4 位 + ****） */
function maskSecretValue(value: string): string {
  if (!value || value.length <= 4) return '****';
  return value.substring(0, 4) + '****';
}
