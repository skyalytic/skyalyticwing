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
import { SubagentService } from './subagent.service.js';
import type { IsolatedAgentOptions } from './subagent.service.js';
import type { SubAgentTaskConfig } from './agent-swarm.service.js';
import {
  SubagentForkDto,
  SubagentSwarmDto,
  SubagentTerminateDto,
} from './dto/subagent-ext.dto.js';

/**
 * Subagent / 隔离代理 / btw REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET    /api/subagents             - 子代理列表
 *   POST   /api/subagents             - 创建子代理
 *   POST   /api/subagents/dispatch    - 派发子代理任务
 *   GET    /api/subagents/:id         - 子代理详情
 *   POST   /api/subagents/communicate - 子代理间通信
 *   POST   /api/subagents/fork        - 分叉子代理（.cjs 行 40445-40474）
 *   POST   /api/subagents/terminate   - 终止子代理（.cjs 行 40475-40491）
 *   POST   /api/subagents/swarm       - 蜂群任务（.cjs 行 40492-40514）
 *   POST   /api/isolated-agent/execute - 隔离代理执行
 *   GET    /api/isolated-agent/status  - 隔离代理状态
 *   POST   /api/btw                   - 顺便执行（旁路提问）
 */
@Controller()
export class SubagentController {
  constructor(private readonly subagentService: SubagentService) {}

  @Get('subagents')
  list(): ApiResponse<unknown> {
    return { success: true, data: this.subagentService.listSubagents() };
  }

  @Post('subagents')
  @HttpCode(HttpStatus.CREATED)
  create(@Body('parentId') parentId: string, @Body() body: SubAgentTaskConfig): ApiResponse<unknown> {
    const result = this.subagentService.createSubAgent(parentId || 'default', body || {});
    if (!result.success) {
      return { success: false, error: result.error ?? 'Unknown error' };
    }
    return { success: true, data: { agent: result.agent } };
  }

  @Post('subagents/dispatch')
  @HttpCode(HttpStatus.OK)
  dispatch(
    @Body('agentId') agentId: string,
    @Body('task') task: string,
    @Body('background') background?: boolean,
  ): ApiResponse<unknown> {
    try {
      const result = this.subagentService.dispatchTask(agentId, task, background === true);
      return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Get('subagents/history')
  history():ApiResponse<unknown>{return {success:true,data:this.subagentService.history()};}

  @Post('subagents/:id/retry')
  retry(@Param('id') id:string,@Body() body?:{confirmReplay?:boolean}):ApiResponse<unknown>{
    const result=this.subagentService.retryInterrupted(id,body?.confirmReplay===true);
    return {success:result.success,data:result,...(result.error?{error:result.error}:{})};
  }

  @Get('subagents/:id')
  detail(@Param('id') id: string): ApiResponse<unknown> {
    const agent = this.subagentService.getSubagent(id);
    if (!agent) {
      return { success: false, error: 'Agent not found', code: 'NOT_FOUND' };
    }
    return { success: true, data: agent };
  }

  @Post('subagents/communicate')
  @HttpCode(HttpStatus.OK)
  communicate(
    @Body('from') from: string,
    @Body('to') to: string,
    @Body('message') message: string,
  ): ApiResponse<unknown> {
    const result = this.subagentService.communicate(from, to, message);
    return { success: result.success, ...(result.error ? { error: result.error } : {}) };
  }

  /** 分叉子代理（并行子任务，继承父会话上下文） */
  @Post('subagents/fork')
  @HttpCode(HttpStatus.CREATED)
  fork(@Body() dto: SubagentForkDto): ApiResponse<unknown> {
    const config: SubAgentTaskConfig = {
      task: dto?.task || '并行子任务',
      prompt: dto?.prompt || '',
      systemPrompt: dto?.systemPrompt || '',
    };
    const result = this.subagentService.createFork(dto?.parentSessionId || 'default', config);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Fork failed' };
    }
    return { success: true, data: { agent: result.agent } };
  }

  /** 终止子代理 */
  @Post('subagents/terminate')
  @HttpCode(HttpStatus.OK)
  terminate(@Body() dto: SubagentTerminateDto): ApiResponse<unknown> {
    const result = this.subagentService.terminate(dto?.agentId || '');
    return { success: result.success, ...(result.error ? { error: result.error } : {}) };
  }

  /** 蜂群任务（多代理协同并行执行） */
  @Post('subagents/swarm')
  @HttpCode(HttpStatus.OK)
  async swarm(@Body() dto: SubagentSwarmDto): Promise<ApiResponse<unknown>> {
    const tasks = Array.isArray(dto?.tasks) ? dto.tasks : [];
    const result = await this.subagentService.spawnSwarm(dto?.parentId || 'main', tasks);
    return { success: result.success, data: result };
  }

  @Post('isolated-agent/execute')
  @HttpCode(HttpStatus.OK)
  async isolatedExecute(
    @Body('prompt') prompt: string,
    @Body() body: IsolatedAgentOptions,
  ): Promise<ApiResponse<unknown>> {
    const result = await this.subagentService.executeIsolated(prompt || '', body || {});
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  /** GET /api/isolated-agent/status — 隔离代理状态（对齐 .cjs IsolatedAgent.getStatus） */
  @Get('isolated-agent/status')
  isolatedStatus(): ApiResponse<unknown> {
    const status = this.subagentService.getIsolatedStatus();
    return {
      success: true,
      data: {
        running: status.running,
        total: status.running,
        maxIterations: status.maxIterations,
      },
    };
  }

  @Post('btw')
  @HttpCode(HttpStatus.OK)
  async btw(
    @Body('question') question: string,
    @Body('sessionId') sessionId?: string,
  ): Promise<ApiResponse<unknown>> {
    const result = await this.subagentService.handleBtw(question || '', sessionId);
    return { success: true, data: result };
  }
}
