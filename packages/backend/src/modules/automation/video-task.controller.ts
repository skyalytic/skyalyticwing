import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { VideoTaskService } from './video-task.service.js';
import type { VideoGenerateRequest } from './video-provider.service.js';

@Controller('automation/media/video-tasks')
export class VideoTaskController {
  constructor(private readonly tasks: VideoTaskService) {}
  @Post()
  @HttpCode(202)
  create(@Body() request: VideoGenerateRequest, @Headers('idempotency-key') key: string) {
    return { success: true, data: this.tasks.create(request, key) };
  }
  @Get() list() {
    return { success: true, data: this.tasks.list() };
  }
  @Delete() clearFinished() {
    return { success: true, data: this.tasks.archive() };
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return { success: true, data: this.tasks.archive(id) };
  }
  @Get(':id') get(@Param('id') id: string) {
    return { success: true, data: this.tasks.get(id) };
  }
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string) {
    return { success: true, data: this.tasks.pause(id) };
  }
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string, @Body('providerTaskId') taskId?: string) {
    return { success: true, data: this.tasks.resume(id, taskId) };
  }
  @Get(':id/artifact')
  artifact(@Param('id') id: string, @Res() response: Response) {
    response.download(this.tasks.artifact(id), id + '.mp4');
  }
}
