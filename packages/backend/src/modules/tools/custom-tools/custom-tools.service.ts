import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { loadJsonFile, resolveWebDataDir, saveJsonFile } from '../../core/utils/web-data.util.js';
import type { CreateCustomToolDto } from './dto/custom-tools.dto.js';

/**
 * CustomToolsService - 自定义工具管理
 *
 * 移植自 start.cjs /tools/custom 路由：
 *   - 列表 / 创建（id 唯一，重复返回 409 语义错误）/ 删除
 *   - 持久化 packages/web/data/custom-tools.json
 */

/** 自定义工具条目 */
export interface CustomTool {
  id: string;
  name: string;
  category: string;
  description: string;
  dangerous: boolean;
  permission: string;
  endpoint: string;
  method: string;
}

@Injectable()
export class CustomToolsService {
  private readonly storePath = join(resolveWebDataDir(), 'custom-tools.json');

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  /** 自定义工具列表 */
  list(): { tools: CustomTool[]; total: number } {
    const tools = loadJsonFile<CustomTool[]>(this.storePath, []);
    return { tools: Array.isArray(tools) ? tools : [], total: Array.isArray(tools) ? tools.length : 0 };
  }

  /** 创建自定义工具（id 重复时报错） */
  create(dto: CreateCustomToolDto): { success: true } | { success: false; error: string; conflict?: boolean } {
    if (!dto.id) return { success: false, error: 'tool id required' };
    const tools = loadJsonFile<CustomTool[]>(this.storePath, []);
    const list = Array.isArray(tools) ? tools : [];
    if (list.some((t) => t.id === dto.id)) {
      return { success: false, error: 'tool already exists', conflict: true };
    }
    const tool: CustomTool = {
      id: dto.id,
      name: dto.name && dto.name.length > 0 ? dto.name : dto.id,
      category: dto.category ?? 'system',
      description: dto.description ?? '',
      dangerous: dto.dangerous === true,
      permission: dto.permission ?? 'ask',
      endpoint: dto.endpoint ?? '',
      method: dto.method ?? 'POST',
    };
    list.push(tool);
    if (!this.persist(list)) return { success: false, error: '写入被路径安全策略拒绝' };
    this.logger.info(`custom-tools: 工具已创建 ${tool.id}`);
    return { success: true };
  }

  /** 删除自定义工具 */
  remove(id: string): { success: true } | { success: false; error: string } {
    const tools = loadJsonFile<CustomTool[]>(this.storePath, []);
    const list = (Array.isArray(tools) ? tools : []).filter((t) => t.id !== id);
    if (!this.persist(list)) return { success: false, error: '写入被路径安全策略拒绝' };
    return { success: true };
  }

  /** 持久化 */
  private persist(tools: CustomTool[]): boolean {
    if (!this.security.isPathAllowed(this.storePath, 'write')) {
      this.logger.warn('custom-tools: 写入被路径安全策略拒绝');
      return false;
    }
    saveJsonFile(this.storePath, tools);
    return true;
  }
}
