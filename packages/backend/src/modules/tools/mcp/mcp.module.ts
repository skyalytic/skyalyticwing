import { Module } from '@nestjs/common';
import { McpService } from './mcp.service.js';
import { McpController, McpCompatController } from './mcp.controller.js';
import { McporterService } from './mcporter.service.js';
import { McporterController } from './mcporter.controller.js';
import { McpServerService } from './mcp-server.service.js';

/**
 * McpModule - MCP (Model Context Protocol) 服务器管理模块
 *
 * 提供以下服务：
 *   - McpService：stdio 传输的 MCP 服务器配置/生命周期/工具调用，
 *     以及回环 MCP 服务器 / MCP 渠道桥 / resources / prompts / probe / doctor
 *   - McpServerService：HTTP/SSE 传输的 MCP 服务器管理（扩展传输支持）
 *   - McporterService：mcporter CLI 管理（钉钉 MCP 广场服务接入）
 *
 * 控制器：
 *   - McpController：MCP 服务器 REST API（/api/mcp/servers/*）
 *   - McpCompatController：MCP 高级功能与旧版兼容 API（/api/mcp/*）
 *
 * 该模块自包含，不依赖 ToolExecutorModule（MCP 工具经 REST API / McpService 调用）。
 */
@Module({
  providers: [McpService, McpServerService, McporterService],
  controllers: [McpController, McpCompatController, McporterController],
  exports: [McpService, McpServerService, McporterService],
})
export class McpModule {}
