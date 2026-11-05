import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ToolPolicyService, type PolicySummary } from './tool-policy.service.js';
import { CreateToolPolicyDto } from './dto/tool-policy.dto.js';

/**
 * ToolPolicy REST API（实际路由前缀 /api/tool-policies）
 *
 * 暴露端点：
 *   POST   /api/tool-policies       - 创建/覆盖策略
 *   DELETE /api/tool-policies/:name - 删除策略
 *   GET    /api/tool-policies       - 列出策略摘要
 *
 * 移植自 start.cjs /tool-policies 路由（行 36251-36286, 40334-40337）。
 */
@Controller('tool-policies')
export class ToolPolicyController {
  constructor(private readonly toolPolicyService: ToolPolicyService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateToolPolicyDto): ApiResponse<{ name: string }> {
    try {
      if (!dto.name) {
        return { success: false, error: 'name and policy required' };
      }
      this.toolPolicyService.registerPolicy(dto.name, {
        ...(dto.allow ? { allow: dto.allow } : {}),
        ...(dto.deny ? { deny: dto.deny } : {}),
      });
      return { success: true, data: { name: dto.name } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Delete(':name')
  @HttpCode(HttpStatus.OK)
  remove(@Param('name') name: string): ApiResponse<{ success: boolean }> {
    this.toolPolicyService.removePolicy(name);
    return { success: true, data: { success: true } };
  }

  @Get()
  list(): ApiResponse<{ policies: PolicySummary[] }> {
    return { success: true, data: { policies: this.toolPolicyService.listPolicies() } };
  }
}
