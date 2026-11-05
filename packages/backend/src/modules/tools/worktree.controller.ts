import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { WorktreeService } from './worktree.service.js';
import { WorktreeCreateDto, WorktreeExecDto, WorktreeRemoveDto } from './dto/worktree.dto.js';

/**
 * Worktree REST API（实际路由前缀 /api/worktrees）
 *
 * 暴露端点：
 *   GET  /api/worktrees             - worktree 列表（git worktree list + 系统登记）
 *   GET  /api/worktrees/stats       - 统计信息
 *   POST /api/worktrees             - 创建 worktree（path 经 PathGuard 校验）
 *   POST /api/worktrees/init-git    - 初始化 git 仓库
 *   POST /api/worktrees/remove      - 移除 worktree
 *   POST /api/worktrees/:id/exec    - 在 worktree 中执行命令（命令经 SecurityManager 校验）
 *   GET  /api/worktrees/:id/diff    - 获取 worktree 的 git diff
 *
 * 移植自 start.cjs /worktrees/* 系列路由。
 */
@Controller('worktrees')
export class WorktreeController {
  constructor(private readonly worktreeService: WorktreeService) {}

  /** GET /api/worktrees — worktree 列表 */
  @Get()
  list(): ApiResponse<unknown> {
    const result = this.worktreeService.listWorktrees();
    return { success: true, data: result };
  }

  /** GET /api/worktrees/stats — 统计信息 */
  @Get('stats')
  stats(): ApiResponse<unknown> {
    return { success: true, data: this.worktreeService.getStats() };
  }

  /** POST /api/worktrees — 创建 worktree（path 经 PathGuard 校验） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: WorktreeCreateDto): ApiResponse<unknown> {
    if (!dto?.path || !dto?.branch) {
      return { success: false, error: 'path and branch required' };
    }
    const result = this.worktreeService.createWorktree(dto.path, dto.branch);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to create worktree' };
    }
    return { success: true, data: { worktree: result.worktree } };
  }

  /** POST /api/worktrees/remove — 移除 worktree */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: WorktreeRemoveDto): ApiResponse<unknown> {
    if (!dto?.worktreeId) {
      return { success: false, error: 'worktreeId required' };
    }
    const result = this.worktreeService.removeWorktree(dto.worktreeId);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Worktree not found' };
    }
    return { success: true, data: { removed: dto.worktreeId } };
  }

  @Post('init-git')
  @HttpCode(HttpStatus.OK)
  initGit(): ApiResponse<{ repoPath?: string; detail?: string }> {
    const result = this.worktreeService.initGit();
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'Unknown error',
        ...(result.detail ? { data: { detail: result.detail } } : {}),
      };
    }
    return { success: true, ...(result.repoPath ? { data: { repoPath: result.repoPath } } : {}) };
  }

  @Post(':id/exec')
  @HttpCode(HttpStatus.OK)
  exec(
    @Param('id') id: string,
    @Body() dto: WorktreeExecDto,
  ): ApiResponse<unknown> {
    const result = this.worktreeService.executeInWorktree(id, dto?.command || '');
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'Unknown error',
        ...(result.worktreeId ? { data: { worktreeId: result.worktreeId } } : {}),
      };
    }
    return {
      success: true,
      data: {
        exitCode: result.exitCode,
        output: result.output,
        worktreeId: result.worktreeId,
      },
    };
  }

  @Get(':id/diff')
  diff(@Param('id') id: string): ApiResponse<unknown> {
    const result = this.worktreeService.getWorktreeDiff(id);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Worktree not found' };
    }
    return {
      success: true,
      data: {
        diff: result.diff,
        worktreeId: result.worktreeId,
        ...(result.message ? { message: result.message } : {}),
      },
    };
  }
}
