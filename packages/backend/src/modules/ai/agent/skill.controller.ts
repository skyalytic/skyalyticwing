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
  UseInterceptors, UploadedFile, Res, BadRequestException, HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SKILL_ZIP_MAX_BYTES } from './skill-archive.js';
import type { ApiResponse } from '@skyalyticwing/shared';
import { SkillService } from './skill.service.js';
import type { UpsertSkillDto } from './skill.service.js';

/**
 * Skills 管理 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET    /api/skills           - 技能列表
 *   GET    /api/skill-content?id= - 获取技能内容
 *   POST   /api/skills           - 创建技能
 *   PUT    /api/skills           - 更新技能
 *   DELETE /api/skills/:id       - 删除技能
 *
 * 所有 FS 操作均经 SkillService 内部调用 SecurityManagerService.isPathAllowed 校验白名单。
 */
@Controller()
export class SkillController {
  constructor(private readonly skillService: SkillService) {}

  @Post('skills/import-zip')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SKILL_ZIP_MAX_BYTES, files: 1, fields: 0 } }))
  async importZip(@UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    if (!file || !/\.zip$/i.test(file.originalname)) throw new BadRequestException('请选择 ZIP 技能包');
    try { return { success: true, data: { skill: await this.skillService.importZip(file.buffer, file.originalname) } }; }
    catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(error instanceof Error ? error.message : '技能导入失败'); }
  }

  @Get('skills/:id/export-zip')
  async exportZip(@Param('id') id: string, @Res() response: Response) {
    let bytes: Buffer;
    try { bytes = await this.skillService.exportZip(id); }
    catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(error instanceof Error ? error.message : '技能导出失败'); }
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', "attachment; filename=skill.zip; filename*=UTF-8''" + encodeURIComponent(id + '.zip'));
    response.setHeader('Cache-Control', 'no-store');
    response.send(bytes);
  }

  @Get('skills/catalog')
  async catalog() { return { success: true, data: await this.skillService.catalog() }; }
  @Post('skills/:id/install')
  async install(@Param('id') id: string) { await this.skillService.installBaseline(id); return { success: true }; }

  @Get('skills')
  async list(): Promise<ApiResponse<unknown>> {
    return { success: true, data: await this.skillService.listAvailableSkills() };
  }

  @Get('skill-content')
  async content(@Query('id') id?: string, @Query('name') name?: string): Promise<ApiResponse<unknown>> {
    const n = id || name || '';
    try {
      const result = await this.skillService.getSkillContent(n);
      if (!result) {
        return { success: false, error: '技能文件不存在', code: 'NOT_FOUND' };
      }
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post('skills')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: UpsertSkillDto): ApiResponse<unknown> {
    try {
      return { success: true, data: { skill: this.skillService.createSkill(dto || { name: '' }) } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Put('skills')
  @HttpCode(HttpStatus.OK)
  update(@Body() dto: UpsertSkillDto): ApiResponse<unknown> {
    try {
      return { success: true, data: { skill: this.skillService.updateSkill(dto || { name: '' }) } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Delete('skills/:id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): ApiResponse<{ deleted: boolean }> {
    try {
      return { success: true, data: this.skillService.deleteSkill(id) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), code: 'NOT_FOUND' };
    }
  }
}
