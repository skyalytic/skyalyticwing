import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { VectorsService } from './vectors.service.js';
import { AddVectorDto, DeleteVectorDto, SearchVectorDto } from './dto/vectors.dto.js';

/**
 * Vectors 向量存储 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   POST /api/vectors/add    - 添加向量
 *   POST /api/vectors/search - 相似搜索
 *   GET  /api/vectors/stats  - 统计
 *   GET  /api/vectors/list   - 列表
 *   POST /api/vectors/delete - 删除
 */
@Controller()
export class VectorsController {
  constructor(private readonly vectorsService: VectorsService) {}

  @Post('vectors/add')
  @HttpCode(HttpStatus.CREATED)
  add(@Body() dto: AddVectorDto): Record<string, unknown> {
    return { success: true, embedding: this.vectorsService.addEmbedding(dto.content, dto.metadata ?? {}) };
  }

  @Post('vectors/search')
  @HttpCode(HttpStatus.OK)
  search(@Body() dto: SearchVectorDto): Record<string, unknown> {
    return { results: this.vectorsService.search(dto.query ?? '', dto.options) };
  }

  @Get('vectors/stats')
  stats(): Record<string, unknown> {
    return this.vectorsService.getStats() as unknown as Record<string, unknown>;
  }

  @Get('vectors/list')
  list(): Record<string, unknown> {
    return this.vectorsService.list();
  }

  @Post('vectors/delete')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: DeleteVectorDto): Record<string, unknown> {
    return this.vectorsService.deleteEmbedding(dto.id);
  }
}
