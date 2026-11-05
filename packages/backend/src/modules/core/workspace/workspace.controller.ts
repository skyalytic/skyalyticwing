import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { WriteWorkspaceFileDto } from './dto/workspace.dto.js';

/**
 * Workspace 工作区 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET  /api/workspace - 工作区文件列表（含 AGENTS.md / SOUL.md 等）
 *   POST /api/workspace - 写入工作区文件
 */
@Controller()
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get('workspace')
  list(): Record<string, unknown> {
    return this.workspaceService.listFiles();
  }

  @Post('workspace')
  @HttpCode(HttpStatus.OK)
  write(@Body() dto: WriteWorkspaceFileDto): Record<string, unknown> {
    return this.workspaceService.writeFile(dto.file, dto.content) as Record<string, unknown>;
  }
}
