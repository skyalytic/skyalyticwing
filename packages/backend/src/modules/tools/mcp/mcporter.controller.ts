import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { McporterService } from './mcporter.service.js';
import {
  McporterAddServerDto,
  McporterCallToolDto,
  McporterRemoveServerDto,
} from '../dto/mcporter.dto.js';

/**
 * MCPorter REST API（路由前缀 /api/mcporter）
 *
 * 暴露端点（对齐旧版 start.cjs 中 MCPorterManager 路由，通用 URL 接入，无渠道商专用端点）：
 *   GET  /api/mcporter/status              - mcporter 可用性与运行状态
 *   GET  /api/mcporter/version             - mcporter CLI 版本
 *   GET  /api/mcporter/servers             - 列出已配置 MCP 服务器
 *   POST /api/mcporter/servers             - 添加 MCP 服务器
 *   POST /api/mcporter/servers/remove      - 移除 MCP 服务器
 *   GET  /api/mcporter/tools?server=       - 列出指定服务器工具
 *   POST /api/mcporter/call                - 调用 MCP 工具（server.tool）
 */
@Controller('mcporter')
export class McporterController {
  constructor(private readonly mcporter: McporterService) {}

  /** GET /mcporter/status — 可用性 + 状态合并（对齐旧版 Object.assign 合并行为） */
  @Get('status')
  async status() {
    try {
      const availability = await this.mcporter.isAvailable();
      const st = this.mcporter.getStatus();
      return { ...availability, ...st };
    } catch (e) {
      return { available: false, error: errMsg(e) };
    }
  }

  /** GET /mcporter/version */
  @Get('version')
  async version() {
    return this.mcporter.version();
  }

  /** GET /mcporter/servers — 列出服务器 */
  @Get('servers')
  async listServers() {
    return this.mcporter.listServers();
  }

  /** POST /mcporter/servers — 添加服务器 */
  @Post('servers')
  @HttpCode(HttpStatus.OK)
  async addServer(@Body() dto: McporterAddServerDto) {
    if (!dto?.name || !dto?.url) {
      return { success: false, error: '需要name和url' };
    }
    return this.mcporter.addServer(dto.name, dto.url, dto.options);
  }

  /** POST /mcporter/servers/remove — 移除服务器 */
  @Post('servers/remove')
  @HttpCode(HttpStatus.OK)
  async removeServer(@Body() dto: McporterRemoveServerDto) {
    return this.mcporter.removeServer(dto?.name || '');
  }

  /** GET /mcporter/tools?server= — 列出指定服务器工具 */
  @Get('tools')
  async listTools(@Query('server') server?: string) {
    if (!server) {
      return { success: false, tools: [], error: '需要server参数' };
    }
    return this.mcporter.listTools(server);
  }

  /** POST /mcporter/call — 调用 MCP 工具（server.tool） */
  @Post('call')
  @HttpCode(HttpStatus.OK)
  async callTool(@Body() dto: McporterCallToolDto) {
    const serverDotTool = dto?.serverDotTool || '';
    if (!serverDotTool) {
      return { success: false, error: '需要serverDotTool参数，格式: server.tool' };
    }
    return this.mcporter.callTool(serverDotTool, dto.args);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
