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
import { BindingService, type Binding } from './binding.service.js';
import { CreateBindingDto, RemoveBindingDto } from './dto/binding.dto.js';

/**
 * Binding REST API（实际路由前缀 /api/bindings）
 *
 * 暴露端点（与 .cjs 行为对齐）：
 *   GET    /api/bindings           - 列出全部绑定
 *   POST   /api/bindings           - 新增绑定（201）
 *   DELETE /api/bindings/:id       - 按路径参数删除绑定
 *   POST   /api/bindings/remove    - 按 body.id 删除绑定（兼容 .cjs /bindings/remove）
 *
 * 移植自 start.cjs：
 *   - 行 36215-36236  POST /bindings
 *   - 行 36238-36249  DELETE /bindings/:id
 *   - 行 40330-40333  GET  /bindings
 *   - 行 41969-41996  POST/DELETE /bindings/remove
 *   - 行 43108-43118  DELETE /bindings/:id（重复声明，行为一致）
 */
@Controller('bindings')
export class BindingController {
  constructor(private readonly bindingService: BindingService) {}

  @Get()
  list(): ApiResponse<{ bindings: Binding[] }> {
    return { success: true, data: { bindings: this.bindingService.listBindings() } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBindingDto): ApiResponse<{ binding: Binding }> {
    try {
      if (!dto?.agentId) {
        return { success: false, error: 'agentId required' };
      }
      const binding = this.bindingService.addBinding(dto as Partial<Binding>);
      return { success: true, data: { binding } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Delete('remove')
  @HttpCode(HttpStatus.OK)
  removeByBodyDelete(@Body() dto: RemoveBindingDto): ApiResponse<{ success: boolean; result: boolean }> {
    return this.removeByBody(dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  removeByPath(@Param('id') id: string): ApiResponse<{ success: boolean }> {
    this.bindingService.removeBinding(id);
    return { success: true, data: { success: true } };
  }

  /**
   * 兼容 .cjs /bindings/remove：通过 body.id 删除绑定，DELETE 或 POST 均可。
   * 路由顺序：字面量 "remove" 必须在 ":id" 之前声明，否则会被 :id 捕获。
   */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  removeByBody(@Body() dto: RemoveBindingDto): ApiResponse<{ success: boolean; result: boolean }> {
    if (!dto?.id) {
      return { success: false, error: 'Binding id required' };
    }
    const result = this.bindingService.removeBinding(dto.id);
    return { success: true, data: { success: true, result } };
  }

}
