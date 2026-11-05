import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { BackgroundTaskService, type BackgroundTask } from './background-task.service.js';

/**
 * 后台任务 REST API（路由前缀 /api/background-tasks，全局前缀由 main.ts 设置）
 *
 * 暴露端点：
 *   GET    /api/background-tasks            - 任务列表（创建时间倒序）
 *   GET    /api/background-tasks/:id        - 任务详情（含实时进度）
 *   POST   /api/background-tasks/:id/cancel - 取消运行中任务
 *   POST   /api/background-tasks/:id/resume - 恢复中断/失败/取消的任务（重新提交执行）
 *   DELETE /api/background-tasks/:id        - 删除历史任务记录
 */
@Controller('background-tasks')
export class BackgroundTaskController {
  constructor(private readonly tasks: BackgroundTaskService) {}

  @Get()
  list(): ApiResponse<BackgroundTask[]> {
    return { success: true, data: this.tasks.list() };
  }

  @Get(':id')
  get(@Param('id') id: string): ApiResponse<BackgroundTask> {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, error: `Task not found: ${id}` };
    }
    return { success: true, data: task };
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string): ApiResponse<BackgroundTask> {
    const task = this.tasks.cancel(id);
    if (!task) {
      return { success: false, error: `Task not found: ${id}` };
    }
    return { success: true, data: task };
  }

  @Post(':id/resume')
  resume(@Param('id') id: string): ApiResponse<BackgroundTask> {
    const task = this.tasks.resume(id);
    if (!task) {
      return { success: false, error: `Task not found or not resumable: ${id}` };
    }
    return { success: true, data: task };
  }

  @Delete(':id')
  remove(@Param('id') id: string): ApiResponse<{ deleted: boolean }> {
    const deleted = this.tasks.remove(id);
    if (!deleted) {
      return { success: false, error: 'Task not found or still running' };
    }
    return { success: true, data: { deleted } };
  }
}
