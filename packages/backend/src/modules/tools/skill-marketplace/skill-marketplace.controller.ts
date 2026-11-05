import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  SkillMarketplaceService,
  type MarketplaceItem,
  type MarketplaceSource,
} from './skill-marketplace.service.js';
import { SkillInstallDto } from '../dto/misc.dto.js';

/**
 * 技能市场 REST API（路由前缀 /api/skill-marketplace）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET  /api/skill-marketplace/search?q=&source=&refresh= - 搜索技能
 *   POST /api/skill-marketplace/install                     - 安装技能到 skills 目录
 *   GET  /api/skill-marketplace/sources                     - 市场源列表
 */
@Controller('skill-marketplace')
export class SkillMarketplaceController {
  constructor(private readonly marketplace: SkillMarketplaceService) {}

  /** GET /skill-marketplace/search — 搜索（本地 + 远程源 + 内置回退） */
  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('source') source?: string,
    @Query('refresh') refresh?: string,
  ): Promise<{ results: MarketplaceItem[]; total: number; sources: Array<{ name: string; type: string }> }> {
    const results = await this.marketplace.search(q || '', source || 'all', refresh === '1');
    return {
      results,
      total: results.length,
      sources: this.marketplace.getSources().map((s) => ({ name: s.name, type: s.type })),
    };
  }

  /** POST /skill-marketplace/install — 安装技能 */
  @Post('install')
  @HttpCode(HttpStatus.OK)
  async install(@Body() dto: SkillInstallDto) {
    if (!dto?.name) {
      return { success: false, error: 'name required' };
    }
    return this.marketplace.install(dto.name, dto.source || 'skyalytic');
  }

  /** GET /skill-marketplace/sources — 市场源列表 */
  @Get('sources')
  sources(): { sources: MarketplaceSource[] } {
    return { sources: this.marketplace.getSources() };
  }
}
