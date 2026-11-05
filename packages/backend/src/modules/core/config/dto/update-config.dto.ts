import { IsObject, IsString, IsOptional } from 'class-validator';

/**
 * 配置更新 DTO - 用于 PUT /api/config 与 PUT /api/config/:section
 *
 * 由于配置结构为动态键值，这里仅做最小化校验：
 * - 整体更新 (PUT /api/config) 接受任意对象
 * - 段更新 (PUT /api/config/:section) 接受任意值，section 路径参数由控制器校验
 */
export class UpdateConfigDto {
  @IsObject()
  @IsOptional()
  body?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  section?: string;
}
