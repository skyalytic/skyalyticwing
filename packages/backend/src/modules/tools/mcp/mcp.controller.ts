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
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import type { ApiResponse, ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import {
  McpService,
  type McpMarketEntry,
  type McpServerConfig,
  type McpServerInfo,
} from './mcp.service.js';

/**
 * MCP REST API（路由前缀 /api/mcp/servers）
 *
 * 暴露端点：
 *   GET    /api/mcp/servers                      - 列出全部 MCP 服务器
 *   POST   /api/mcp/servers                      - 添加服务器配置
 *   PUT    /api/mcp/servers/:id                  - 更新服务器配置
 *   DELETE /api/mcp/servers/:id                  - 删除服务器
 *   POST   /api/mcp/servers/:id/start            - 启动服务器
 *   POST   /api/mcp/servers/:id/stop             - 停止服务器
 *   GET    /api/mcp/servers/:id/tools            - 列出服务器工具
 *   POST   /api/mcp/servers/:id/tools/:toolName  - 调用服务器工具
 *
 * 所有响应均为脱敏信息（不含 env 等敏感字段）。
 */
@ApiTags('MCP')
@Controller('mcp/servers')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Get()
  list(): ApiResponse<McpServerInfo[]> {
    return { success: true, data: this.mcpService.listServers() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(@Body() body: Omit<McpServerConfig, 'id'> & { id?: string }): ApiResponse<McpServerInfo> {
    try {
      const info = this.mcpService.addServer(body ?? {});
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() body: Partial<Omit<McpServerConfig, 'id'>>,
  ): ApiResponse<McpServerInfo> {
    try {
      const info = this.mcpService.updateServer(id, body ?? {});
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: errMsg(err), code: 'NOT_FOUND' };
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): ApiResponse<{ id: string }> {
    try {
      this.mcpService.removeServer(id);
      return { success: true, data: { id } };
    } catch (err) {
      return { success: false, error: errMsg(err), code: 'NOT_FOUND' };
    }
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async start(@Param('id') id: string): Promise<ApiResponse<{ id: string; status: string }>> {
    try {
      await this.mcpService.startServer(id);
      return { success: true, data: { id, status: 'running' } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  stop(@Param('id') id: string): ApiResponse<{ id: string; status: string }> {
    try {
      this.mcpService.stopServer(id);
      return { success: true, data: { id, status: 'stopped' } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Get(':id/tools')
  async listTools(@Param('id') id: string): Promise<ApiResponse<ToolDefinition[]>> {
    try {
      const tools = await this.mcpService.listTools(id);
      return { success: true, data: tools };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post(':id/tools/:toolName')
  @HttpCode(HttpStatus.OK)
  async callTool(
    @Param('id') id: string,
    @Param('toolName') toolName: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<ToolResult>> {
    try {
      const result = await this.mcpService.callTool(id, toolName, body);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
}

// ════════════════════════════════════════════════════════════════
// MCP 高级功能 / 旧版兼容路由（前缀 /api/mcp）
// ════════════════════════════════════════════════════════════════

/** 启动回环请求体 */
class LoopbackStartDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  port?: number;
}

/** 更新回环配置请求体 */
class LoopbackConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  port?: number;
}

/** 读取渠道消息请求体 */
class ChannelMessagesDto {
  @IsOptional()
  @IsString()
  sessionKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

/** 发送渠道消息请求体 */
class ChannelSendDto {
  @IsString()
  @IsNotEmpty()
  sessionKey!: string;

  @IsString()
  @IsNotEmpty()
  text!: string;
}

/** 兼容路由：body 传 serverId */
class ServerIdBodyDto {
  @IsOptional()
  @IsString()
  serverId?: string;
}

/** 兼容路由：调用工具 */
class CallToolCompatDto {
  @IsOptional()
  @IsString()
  serverId?: string;

  @IsOptional()
  @IsString()
  toolName?: string;

  @IsOptional()
  args?: unknown;

  @IsOptional()
  id?: string | number | null;
}

/** 读取资源请求体 */
class ResourceReadDto {
  @IsString()
  @IsNotEmpty()
  serverId!: string;

  @IsString()
  @IsNotEmpty()
  uri!: string;
}

/** 获取提示请求体 */
class PromptGetDto {
  @IsString()
  @IsNotEmpty()
  serverId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  args?: Record<string, unknown>;
}

/** 探测 / 诊断请求体 */
class ServerIdRequiredDto {
  @IsString()
  @IsNotEmpty()
  serverId!: string;
}

/** 测试端点调用请求体 */
class TestEndpointCallDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  toolName?: string;

  @IsOptional()
  arguments?: Record<string, unknown>;

  @IsOptional()
  args?: Record<string, unknown>;

  @IsOptional()
  id?: string | number | null;
}

/** MCP 市场一键安装请求体（POST /mcp/market/install） */
class MarketInstallDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;
}

/** 渠道会话列表查询参数 */
class ChannelConversationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

/** 渠道事件查询参数 */
class ChannelEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  after_cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

/** serverId 查询参数 */
class ServerIdQueryDto {
  @IsOptional()
  @IsString()
  serverId?: string;
}

/**
 * MCP 高级功能与旧版兼容 REST API（路由前缀 /api/mcp）
 *
 * 端点（对齐旧版 start.cjs）：
 *   POST /api/mcp/expose                 - 暴露内部工具为 MCP 服务器
 *   POST /api/mcp/loopback/start         - 启动回环 MCP 服务器
 *   POST /api/mcp/loopback/stop          - 停止回环
 *   GET  /api/mcp/loopback/status        - 回环状态（token 脱敏）
 *   GET  /api/mcp/loopback/config        - 回环配置（Claude Desktop 格式）
 *   PUT  /api/mcp/loopback/config        - 更新回环配置（偏好端口）
 *   GET  /api/mcp/channel/conversations  - MCP 渠道会话列表
 *   GET/POST /api/mcp/channel/messages   - 读取 MCP 渠道消息
 *   POST /api/mcp/channel/send           - 发送消息到 MCP 渠道（别名）
 *   GET  /api/mcp/channel/events         - MCP 渠道事件轮询
 *   GET/POST /api/mcp/test-endpoint      - 测试 MCP 端点连通性
 *   GET  /api/mcp/resources              - 资源列表（resources/list）
 *   POST /api/mcp/resource/read          - 读取资源（resources/read）
 *   GET  /api/mcp/prompts                - 提示模板列表（prompts/list）
 *   POST /api/mcp/prompt/get             - 获取提示（prompts/get）
 *   POST /api/mcp/probe                  - 探测服务器能力
 *   POST /api/mcp/doctor                 - MCP 诊断
 *   GET  /api/mcp/market                 - MCP 市场目录（预置官方连接器）
 *   POST /api/mcp/market/install         - 从市场一键添加连接器
 *   兼容：POST /api/mcp/start|stop|remove、GET /api/mcp/tools、POST /api/mcp/call
 */
@ApiTags('MCP')
@Controller('mcp')
export class McpCompatController {
  constructor(private readonly mcpService: McpService) {}

  @Post('expose')
  @HttpCode(HttpStatus.OK)
  async expose(): Promise<ApiResponse<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>> {
    try {
      const tools = await this.mcpService.exposeInternalTools();
      return { success: true, data: tools };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** GET /mcp/market — MCP 市场目录（预置官方连接器，通用市场） */
  @Get('market')
  market(): ApiResponse<McpMarketEntry[]> {
    return { success: true, data: this.mcpService.getMarketCatalog() };
  }

  /** POST /mcp/market/install — 从市场一键添加连接器（按 key） */
  @Post('market/install')
  @HttpCode(HttpStatus.OK)
  marketInstall(@Body() body: MarketInstallDto): ApiResponse<McpServerInfo> {
    try {
      const info = this.mcpService.installFromMarket(body?.key ?? '', body?.env);
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post('loopback/start')
  @HttpCode(HttpStatus.OK)
  async loopbackStart(@Body() body: LoopbackStartDto): Promise<unknown> {
    try {
      const result = await this.mcpService.startLoopback(body?.port ?? 0);
      return result;
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post('loopback/stop')
  @HttpCode(HttpStatus.OK)
  loopbackStop(): { success: boolean } {
    return this.mcpService.stopLoopback();
  }

  @Get('loopback/status')
  loopbackStatus(): unknown {
    return this.mcpService.getLoopbackStatus();
  }

  @Get('loopback/config')
  loopbackConfig(): unknown {
    const st = this.mcpService.getLoopbackStatus();
    return { success: true, config: st.config, claudeDesktopConfig: st.config };
  }

  @Put('loopback/config')
  @HttpCode(HttpStatus.OK)
  updateLoopbackConfig(@Body() body: LoopbackConfigDto): unknown {
    return this.mcpService.updateLoopbackConfig(body ?? {});
  }

  @Get('channel/conversations')
  channelConversations(@Query() query: ChannelConversationsQueryDto): { conversations: Array<Record<string, unknown>> } {
    return {
      conversations: this.mcpService.listConversations({
        limit: query?.limit || 50,
        channel: query?.channel || '',
        search: query?.search || '',
      }),
    };
  }

  @Get('channel/messages')
  channelMessagesGet(
    @Query('sessionKey') sessionKey: string,
    @Query('limit') limit: string,
  ): { messages: Array<{ role: string; content: string; timestamp: number; id: string }> } {
    const n = parseInt(limit, 10);
    return { messages: this.mcpService.readChannelMessages(sessionKey || '', Number.isFinite(n) && n > 0 ? n : 20) };
  }

  @Post('channel/messages')
  @HttpCode(HttpStatus.OK)
  channelMessagesPost(@Body() body: ChannelMessagesDto): { messages: Array<{ role: string; content: string; timestamp: number; id: string }> } {
    return { messages: this.mcpService.readChannelMessages(body?.sessionKey ?? '', body?.limit || 20) };
  }

  @Post('channel/send')
  @HttpCode(HttpStatus.OK)
  async channelSend(@Body() body: ChannelSendDto): Promise<unknown> {
    if (!body?.sessionKey || !body?.text) {
      return { success: false, error: 'sessionKey and text are required' };
    }
    return this.mcpService.sendChannelMessage(body.sessionKey, body.text);
  }

  @Get('channel/events')
  channelEvents(@Query() query: ChannelEventsQueryDto): { events: unknown[]; nextCursor: number } {
    return this.mcpService.pollChannelEvents(query?.after_cursor || 0, query?.limit || 20);
  }

  @Get('channel/stream')
  channelStream(@Res() res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', server: 'SkyalyticWing-MCP-Channel' })}\n\n`);
    res.on('close', () => {
      /* 客户端断开，连接由 HTTP 服务器回收 */
    });
  }

  @Get('test-endpoint')
  testEndpointTools(): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
    return { tools: this.mcpService.getTestEndpointTools() };
  }

  @Post('test-endpoint')
  @HttpCode(HttpStatus.OK)
  testEndpointCall(@Body() body: TestEndpointCallDto, @Res() res: Response): void {
    const name = body?.name || body?.toolName || '';
    const args = body?.arguments ?? body?.args ?? {};
    if (!name) {
      res.status(400).json({ error: 'Tool name is required' });
      return;
    }
    const result = this.mcpService.callTestEndpointTool(name, args);
    if ('__unknown__' in result) {
      res.status(404).json({ error: `Unknown tool: ${name}` });
      return;
    }
    res.status(200).json({ jsonrpc: '2.0', id: body?.id ?? null, result });
  }

  @Get('resources')
  async resources(@Query() query: ServerIdQueryDto, @Res() res: Response): Promise<void> {
    const sid = query?.serverId;
    if (!sid) {
      res.status(400).json({ error: 'serverId query parameter required' });
      return;
    }
    const result = await this.mcpService.listResources(sid);
    res.status(200).json(result);
  }

  @Post('resource/read')
  @HttpCode(HttpStatus.OK)
  async resourceRead(@Body() body: ResourceReadDto): Promise<unknown> {
    return this.mcpService.readResource(body.serverId, body.uri);
  }

  @Get('prompts')
  async prompts(@Query() query: ServerIdQueryDto, @Res() res: Response): Promise<void> {
    const sid = query?.serverId;
    if (!sid) {
      res.status(400).json({ error: 'serverId query parameter required' });
      return;
    }
    const result = await this.mcpService.listPrompts(sid);
    res.status(200).json(result);
  }

  @Post('prompt/get')
  @HttpCode(HttpStatus.OK)
  async promptGet(@Body() body: PromptGetDto): Promise<unknown> {
    return this.mcpService.getPrompt(body.serverId, body.name, body.args ?? {});
  }

  @Post('probe')
  @HttpCode(HttpStatus.OK)
  async probe(@Body() body: ServerIdRequiredDto): Promise<unknown> {
    return this.mcpService.probe(body.serverId);
  }

  @Post('doctor')
  @HttpCode(HttpStatus.OK)
  doctor(@Body() body: ServerIdRequiredDto): unknown {
    return this.mcpService.doctor(body.serverId);
  }

  // ── 旧版兼容路由（body/query 传 serverId） ──

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async compatStart(@Body() body: ServerIdBodyDto): Promise<unknown> {
    if (!body?.serverId) return { success: false, error: 'serverId is required' };
    try {
      await this.mcpService.startServer(body.serverId);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  compatStop(@Body() body: ServerIdBodyDto): unknown {
    if (!body?.serverId) return { success: false, error: 'serverId is required' };
    try {
      this.mcpService.stopServer(body.serverId);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Post('remove')
  @HttpCode(HttpStatus.OK)
  compatRemove(@Body() body: ServerIdBodyDto): unknown {
    if (!body?.serverId) return { success: false, error: 'serverId is required' };
    try {
      this.mcpService.removeServer(body.serverId);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Get('tools')
  async compatTools(@Query() query: ServerIdQueryDto, @Res() res: Response): Promise<void> {
    const sid = query?.serverId;
    if (!sid) {
      res.status(400).json({ error: 'serverId query parameter required' });
      return;
    }
    try {
      const tools = await this.mcpService.listTools(sid);
      res.status(200).json({ tools });
    } catch (err) {
      res.status(500).json({ error: errMsg(err) });
    }
  }

  @Post('call')
  @HttpCode(HttpStatus.OK)
  async compatCall(@Body() body: CallToolCompatDto): Promise<unknown> {
    if (!body?.serverId || !body?.toolName) {
      return { success: false, error: 'serverId and toolName are required' };
    }
    return this.mcpService.callTool(body.serverId, body.toolName, body.args ?? {});
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
