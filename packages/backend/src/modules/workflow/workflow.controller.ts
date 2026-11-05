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
import { WorkflowService } from './workflow.service.js';
import type {
  WorkflowCreateInput,
  WorkflowDef,
  WorkflowRunLog,
} from './workflow.types.js';
import { ApiTags } from '../core/swagger/swagger-decorators.js';

/**
 * 工作流 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('workflow') 实际路由为 /api/workflow。
 *
 * 暴露端点：
 *   GET    /api/workflow            - 列出工作流
 *   POST   /api/workflow            - 创建工作流
 *   GET    /api/workflow/:id        - 读取工作流
 *   PUT    /api/workflow/:id        - 更新工作流
 *   DELETE /api/workflow/:id        - 删除工作流
 *   POST   /api/workflow/:id/run    - 触发运行（立即返回，异步执行）
 *   GET    /api/workflow/:id/logs   - 获取运行日志（前端轮询直到最新一条 status != running）
 */
@ApiTags('Workflow')
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get()
  list(): ApiResponse<WorkflowDef[]> {
    return { success: true, data: this.workflowService.listWorkflows() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() input: WorkflowCreateInput): ApiResponse<WorkflowDef> {
    const result = this.workflowService.createWorkflow(input);
    if (!result.success || !result.workflow) {
      return { success: false, ...(result.error ? { error: result.error } : {}) };
    }
    return { success: true, data: result.workflow };
  }

  @Get(':id')
  detail(@Param('id') id: string): ApiResponse<WorkflowDef | null> {
    return { success: true, data: this.workflowService.readWorkflow(id) };
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() patch: Partial<WorkflowCreateInput>,
  ): ApiResponse<WorkflowDef> {
    const result = this.workflowService.updateWorkflow(id, patch);
    if (!result.success || !result.workflow) {
      return { success: false, ...(result.error ? { error: result.error } : {}) };
    }
    return { success: true, data: result.workflow };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  delete(@Param('id') id: string): ApiResponse<{ success: boolean }> {
    const result = this.workflowService.deleteWorkflow(id);
    return {
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  run(
    @Param('id') id: string,
    @Body() body?: { model?: string },
  ): ApiResponse<WorkflowRunLog> {
    const result = this.workflowService.runWorkflow(
      id,
      body?.model ? { model: body.model } : undefined,
    );
    if (!result.success || !result.run) {
      return { success: false, ...(result.error ? { error: result.error } : {}) };
    }
    return { success: true, data: result.run };
  }

  @Get(':id/logs')
  logs(@Param('id') id: string): ApiResponse<WorkflowRunLog[]> {
    return { success: true, data: this.workflowService.getRunLogs(id) };
  }

  @Post(':id/runs/:runId/:action')
  control(@Param('id') id: string, @Param('runId') runId: string,
    @Param('action') action: string, @Body() body?: { confirmReplay?: boolean }): ApiResponse<WorkflowRunLog> {
    if (!['cancel', 'resume', 'approve'].includes(action)) return { success: false, error: '操作无效' };
    const result = this.workflowService.control(id, runId, action as 'cancel'|'resume'|'approve', body?.confirmReplay === true);
    return result.success && result.run ? { success:true,data:result.run } : { success:false,error:result.error || '操作失败' };
  }
}
