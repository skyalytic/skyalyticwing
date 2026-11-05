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
  Query,
  Res,
} from '@nestjs/common';
import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import { PluginService, type PluginInfo } from './plugin.service.js';

/**
 * Plugin REST API（路由前缀 /api/plugins）
 *
 * 暴露端点：
 *   GET    /api/plugins                - 列出全部已安装插件
 *   POST   /api/plugins                - 安装插件（body: { source }）
 *   DELETE /api/plugins/:id            - 卸载插件
 *   POST   /api/plugins/:id/load       - 加载插件到内存
 *   POST   /api/plugins/:id/unload     - 从内存卸载插件
 *   GET    /api/plugins/:id/config     - 获取插件配置（脱敏）
 *   PUT    /api/plugins/:id/config     - 设置插件配置
 *
 * 扩展端点（对齐旧版 start.cjs）：
 *   GET    /api/plugins/tools          - 插件提供的工具列表
 *   POST   /api/plugins/call           - 调用插件工具
 *   POST   /api/plugins/reload         - 重载全部插件
 *   GET    /api/plugins/hooks          - 钩子列表（?hook= 执行指定钩子）
 *   PUT/POST /api/plugins/toggle       - 启用/禁用插件
 *   POST   /api/plugins/unload         - 卸载（body 传 id，旧版）
 *   POST   /api/plugins/install        - 以文件内容安装插件（旧版）
 */

/** 调用插件工具请求体 */
class PluginCallDto {
  @IsString()
  @IsNotEmpty()
  pluginId!: string;

  @IsString()
  @IsNotEmpty()
  toolName!: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

/** 启用/禁用插件请求体（对齐旧版 { id, enabled }） */
class PluginToggleDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** 旧版卸载请求体（body 传 id / pluginId） */
class PluginUnloadDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  pluginId?: string;
}

/** 旧版安装请求体（filename + content） */
class PluginInstallDto {
  @IsString()
  @IsNotEmpty()
  filename!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;
}

@ApiTags('Plugins')
@Controller('plugins')
export class PluginController {
  constructor(private readonly pluginService: PluginService) {}

  @Get()
  list(): ApiResponse<PluginInfo[]> {
    return { success: true, data: this.pluginService.listPlugins() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async install(@Body() body: { source?: string }): Promise<ApiResponse<PluginInfo>> {
    try {
      const info = await this.pluginService.installPlugin(body?.source ?? '');
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string): Promise<ApiResponse<{ id: string }>> {
    try {
      await this.pluginService.uninstallPlugin(id);
      return { success: true, data: { id } };
    } catch (err) {
      return { success: false, error: errMsg(err), code: 'NOT_FOUND' };
    }
  }

  @Post(':id/load')
  @HttpCode(HttpStatus.OK)
  async load(@Param('id') id: string): Promise<ApiResponse<{ id: string; loaded: boolean }>> {
    try {
      await this.pluginService.loadPlugin(id);
      return { success: true, data: { id, loaded: true } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post(':id/unload')
  @HttpCode(HttpStatus.OK)
  async unload(@Param('id') id: string): Promise<ApiResponse<{ id: string; loaded: boolean }>> {
    try {
      await this.pluginService.unloadPlugin(id);
      return { success: true, data: { id, loaded: false } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Get(':id/config')
  getConfig(@Param('id') id: string): ApiResponse<Record<string, unknown>> {
    try {
      return { success: true, data: this.pluginService.getPluginConfigForController(id) };
    } catch (err) {
      return { success: false, error: errMsg(err), code: 'NOT_FOUND' };
    }
  }

  @Put(':id/config')
  @HttpCode(HttpStatus.OK)
  setConfig(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): ApiResponse<Record<string, unknown>> {
    try {
      this.pluginService.setPluginConfig(id, body ?? {});
      return {
        success: true,
        data: this.pluginService.getPluginConfigForController(id),
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ════════════════════════════════════════════════════════════════
  @Get(':id/configuration')
  configuration(@Param('id') id: string) {
    return {success:true,data:{config:this.pluginService.getPluginConfigForController(id),schema:this.pluginService.getPluginSchema(id)}};
  }
  @Delete(':id/config')
  clearConfiguration(@Param('id') id: string) {
    this.pluginService.clearPluginConfig(id);
    return {success:true};
  }

  // ════════════════════════════════════════════════════════════════
  // 扩展端点（对齐旧版 start.cjs）
  // ════════════════════════════════════════════════════════════════

  @Get('tools')
  tools(): { tools: Array<{ name: string; description: string; parameters?: unknown; pluginId: string; pluginName: string }> } {
    return { tools: this.pluginService.getPluginTools() };
  }

  @Post('call')
  @HttpCode(HttpStatus.OK)
  async call(@Body() body: PluginCallDto): Promise<unknown> {
    if (!body?.pluginId || !body?.toolName) {
      return { success: false, error: 'pluginId and toolName are required' };
    }
    return this.pluginService.callPluginTool(body.pluginId, body.toolName, body.args ?? {});
  }

  @Post('reload')
  @HttpCode(HttpStatus.OK)
  async reload(): Promise<unknown> {
    return this.pluginService.reloadAllPlugins();
  }

  @Get('hooks')
  async hooks(@Query('hook') hook: string): Promise<unknown> {
    if (hook) {
      return this.pluginService.executeHookByName(hook, {});
    }
    const definitions = this.pluginService.getHookDefinitions();
    return {
      availableHooks: definitions.map((d) => d.name),
      definitions,
    };
  }

  @Put('toggle')
  @HttpCode(HttpStatus.OK)
  async toggle(@Body() body: PluginToggleDto, @Res() res: Response): Promise<void> {
    await this.handleToggle(body, res);
  }

  @Post('toggle')
  @HttpCode(HttpStatus.OK)
  async togglePost(@Body() body: PluginToggleDto, @Res() res: Response): Promise<void> {
    await this.handleToggle(body, res);
  }

  private async handleToggle(body: PluginToggleDto, res: Response): Promise<void> {
    if (!body?.id || typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'Fields "id" and "enabled" are required' });
      return;
    }
    const enabled = await this.pluginService.togglePluginById(body.id, body.enabled);
    if (enabled === null) {
      res.status(404).json({ error: `Plugin not found: ${body.id}` });
      return;
    }
    res.status(200).json({ success: true, enabled });
  }

  @Post('unload')
  @HttpCode(HttpStatus.OK)
  async unloadCompat(@Body() body: PluginUnloadDto): Promise<unknown> {
    const id = body?.id ?? body?.pluginId;
    if (!id) return { success: false, error: 'id (or pluginId) is required' };
    try {
      await this.pluginService.unloadPlugin(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post('install')
  @HttpCode(HttpStatus.CREATED)
  async installCompat(@Body() body: PluginInstallDto, @Res() res: Response): Promise<void> {
    const result = await this.pluginService.installPluginFile(body?.filename ?? '', body?.content ?? '');
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'Install failed' });
      return;
    }
    res.status(201).json(result);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
