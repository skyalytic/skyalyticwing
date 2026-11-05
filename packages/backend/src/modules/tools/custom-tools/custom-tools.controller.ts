import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CustomToolsService } from './custom-tools.service.js';
import { CreateCustomToolDto, DeleteCustomToolDto } from './dto/custom-tools.dto.js';

/**
 * CustomTools 自定义工具 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET    /api/tools/custom - 自定义工具列表
 *   POST   /api/tools/custom - 创建自定义工具
 *   DELETE /api/tools/custom - 删除自定义工具
 */
@Controller()
export class CustomToolsController {
  constructor(private readonly customToolsService: CustomToolsService) {}

  @Get('tools/custom')
  list(): Record<string, unknown> {
    const { tools, total } = this.customToolsService.list();
    return { tools, total };
  }

  @Post('tools/custom')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCustomToolDto): Record<string, unknown> {
    return this.customToolsService.create(dto) as Record<string, unknown>;
  }

  @Delete('tools/custom')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: DeleteCustomToolDto): Record<string, unknown> {
    return this.customToolsService.remove(dto.id) as Record<string, unknown>;
  }
}
