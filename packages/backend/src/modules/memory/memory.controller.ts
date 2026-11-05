import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { MemoryService } from '../ai/agent/memory.service.js';
import { CronService } from '../channels/cron/cron.service.js';
import { MemoryDataService } from './memory-data.service.js';
import { AddKnowledgeDto } from './dto/knowledge.dto.js';

/** 记忆搜索结果条目（对齐 .cjs /memory/search 响应结构） */
interface MemorySearchItem {
  source: string;
  content: string;
  score: number;
  file?: string;
  id?: string;
}

/** 梦境 cron 任务状态 */
interface DreamCronJob {
  id: string;
  name: string;
  enabled: boolean;
  expression?: string;
  nextRun: number | null;
}

/**
 * Memory REST API（实际路由前缀 /api）
 *
 * 移植自 start.cjs：
 *   GET  /api/memory/search       - 记忆搜索（行 39614-39657）
 *   GET  /api/memory/knowledge    - 知识库列表（行 39658-39666）
 *   POST /api/memory/knowledge    - 写入知识（行 37727-37762）
 *   GET  /api/memory/dream        - 只读状态；POST 执行整理
 *   GET  /api/memory/dream/status - 梦境状态（行 39687-39713）
 */
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly memorySystem: MemoryService,
    private readonly memoryData: MemoryDataService,
    private readonly cron: CronService,
    private readonly logger: LoggerService,
  ) {}

  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('query') query?: string,
    @Query('agentId') agentId?: string,
  ): ApiResponse<{ results: MemorySearchItem[]; total: number }> {
    const keyword = q || query || '';
    const results: MemorySearchItem[] = [];

    // 来源一：MemorySystem（MEMORY.md / 日记 / 工作区记忆）
    try {
      const memResults = this.memorySystem.search(keyword, 10, agentId || 'main');
      for (const r of memResults) {
        results.push({
          source: 'MEMORY.md',
          content: r.content || r.section || '',
          score: r.score || 0.5,
          file: r.path || '',
        });
      }
    } catch (err) {
      this.logger.warn('Memory system search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 来源二：知识库（memory.json）
    for (const k of this.memoryData.searchKnowledge(keyword)) {
      results.push({
        source: '向量知识库',
        content: k.content || '',
        score: k.score || 0.5,
        id: k.id || '',
      });
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return { success: true, data: { results, total: results.length } };
  }

  @Get('knowledge')
  knowledge(): ApiResponse<{
    knowledge: ReturnType<MemoryDataService['listKnowledge']>;
    stats: ReturnType<MemoryDataService['getStats']>;
  }> {
    return {
      success: true,
      data: {
        knowledge: this.memoryData.listKnowledge(),
        stats: this.memoryData.getStats(),
      },
    };
  }

  @Post('knowledge')
  @HttpCode(HttpStatus.CREATED)
  addKnowledge(@Body() dto: AddKnowledgeDto): ApiResponse<unknown> {
    if (!dto?.title && !dto?.content) {
      return { success: false, error: 'title 或 content 至少提供一个' };
    }
    this.memoryData.addKnowledge(dto.title || '', dto.content || '', dto.tags);
    return { success: true, data: { success: true } };
  }

  @Delete('knowledge/:id')
  deleteKnowledge(@Param('id') id: string): ApiResponse<unknown> {
    if (!this.memoryData.deleteKnowledge(id)) {
      return { success: false, error: 'Knowledge not found' };
    }
    return { success: true, data: { deleted: id } };
  }

  @Get('dream')
  @HttpCode(HttpStatus.OK)
  dream(): ApiResponse<unknown> {
    // A status refresh must not promote or rewrite memories.
    return this.dreamStatus();
  }

  @Post('dream')
  @HttpCode(HttpStatus.OK)
  dreamRun(): ApiResponse<unknown> {
    try {
      this.memorySystem.runDreamCycle();
      return {
        success: true,
        data: { success: true, result: { completed: true, ranAt: new Date().toISOString() } },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Get('dream/status')
  dreamStatus(): ApiResponse<{
    enabled: boolean;
    shortTermEntries: number;
    cronJobs: DreamCronJob[];
  }> {
    const cronJobs: DreamCronJob[] = this.cron
      .listJobs()
      .filter((j) => j.id && j.id.startsWith('dream-'))
      .map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        ...(j.expression !== undefined ? { expression: j.expression } : {}),
        nextRun: j.nextRun,
      }));
    return {
      success: true,
      data: {
        enabled: this.memoryData.isDreamEnabled(),
        shortTermEntries: this.memoryData.getShortTermRecallCount(),
        cronJobs,
      },
    };
  }
}
