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
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import {
  CronService,
  type CronJobConfig,
  type CronJobInfo,
  type CronJobDetail,
  type CronJobPage,
  type CronStatus,
  type OpResult,
} from './cron.service.js';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import { ToggleCronJobDto } from './dto/toggle-cron-job.dto.js';

/**
 * 定时任务 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('cron') 实际路由为 /api/cron。
 *
 * 暴露端点：
 *   GET    /api/cron               - 列出定时任务（支持分页 offset/limit）
 *   POST   /api/cron               - 创建定时任务
 *   GET    /api/cron/:id           - 获取定时任务详情
 *   PUT    /api/cron/:id           - 更新定时任务
 *   DELETE /api/cron/:id           - 删除定时任务
 *   POST   /api/cron/:id/start     - 启动定时任务
 *   POST   /api/cron/:id/stop      - 停止定时任务
 *   POST   /api/cron/:id/run       - 立即执行定时任务
 *   POST   /api/cron/:id/enqueue   - 入队立即执行
 *   GET    /api/cron/status        - 获取服务状态
 *   GET    /api/cron/history       - 获取任务历史
 *   GET    /api/cron/:id/logs      - 获取任务运行日志
 *   POST   /api/cron/wake          - 唤醒调度引擎
 *   GET    /api/cron/enhanced      - 增强任务列表（含下次执行时间，.cjs 行 41286-41307）
 *   PUT    /api/cron/toggle        - 切换任务启用状态（.cjs 行 36522-36570）
 */
@ApiTags('Cron')
@Controller('cron')
export class CronController {
  constructor(private readonly cronService: CronService) {}

  @Get()
  list(
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): ApiResponse<CronJobInfo[] | CronJobPage> {
    if (offset !== undefined || limit !== undefined) {
      const o = parseInt(offset || '0', 10) || 0;
      const l = parseInt(limit || '20', 10) || 20;
      return { success: true, data: this.cronService.listPage(o, l) };
    }
    return { success: true, data: this.cronService.listJobs() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() config: CronJobConfig): ApiResponse<OpResult> {
    const result = this.cronService.addJob(config);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Get('status')
  status(): ApiResponse<CronStatus> {
    return { success: true, data: this.cronService.getStatus() };
  }

  @Get('history')
  history(): ApiResponse<ReturnType<CronService['getJobHistory']>> {
    return { success: true, data: this.cronService.getJobHistory() };
  }

  @Post('wake')
  @HttpCode(HttpStatus.OK)
  wake(): ApiResponse<OpResult> {
    return { success: true, data: this.cronService.wake() };
  }

  /** 增强任务列表：服务状态 + 每个任务的下次执行时间 */
  @Get('enhanced')
  enhanced(): ApiResponse<CronStatus & { jobs: Array<CronJobInfo & { nextRunAt: string | null }> }> {
    const status = this.cronService.getStatus();
    const jobs = this.cronService.listJobs().map((j) => ({
      ...j,
      nextRunAt: j.nextRun ? new Date(j.nextRun).toISOString() : null,
    }));
    return { success: true, data: { ...status, jobs } };
  }

  /** 切换任务启用状态 */
  @Put('toggle')
  @HttpCode(HttpStatus.OK)
  toggle(@Body() dto: ToggleCronJobDto): ApiResponse<unknown> {
    if (!dto?.id) {
      return { success: false, error: 'Job not found' };
    }
    const result = this.cronService.toggleJob(dto.id, dto.enabled === true);
    if (!result.success) {
      return { success: false, error: result.error ?? 'Toggle failed' };
    }
    return { success: true, data: { success: true, enabled: dto.enabled } };
  }

  @Get(':id')
  detail(@Param('id') id: string): ApiResponse<CronJobDetail | null> {
    return { success: true, data: this.cronService.readJob(id) };
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() config: Partial<CronJobConfig>,
  ): ApiResponse<OpResult> {
    const result = this.cronService.updateJob(id, config);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  delete(@Param('id') id: string): ApiResponse<OpResult> {
    const result = this.cronService.deleteJob(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  start(@Param('id') id: string): ApiResponse<OpResult> {
    const result = this.cronService.startJob(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  stop(@Param('id') id: string): ApiResponse<OpResult> {
    const result = this.cronService.stopJob(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(@Param('id') id: string): Promise<ApiResponse<OpResult>> {
    const result = await this.cronService.runJob(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Post(':id/enqueue')
  @HttpCode(HttpStatus.OK)
  enqueue(@Param('id') id: string): ApiResponse<OpResult> {
    const result = this.cronService.enqueueRun(id);
    return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
  }

  @Get(':id/logs')
  logs(@Param('id') id: string): ApiResponse<ReturnType<CronService['getRunLogs']>> {
    return { success: true, data: this.cronService.getRunLogs(id) };
  }
}
