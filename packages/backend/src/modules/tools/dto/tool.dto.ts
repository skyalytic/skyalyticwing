import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// ─── POST /tool/execute ────────────────────────────────────────────────────

/**
 * 执行工具 DTO
 *
 * 兼容旧版前端两种字段名：
 *   - tool     （旧版 data-loader.js 使用）
 *   - toolName （新版约定）
 */
export class ExecuteToolDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  tool?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  toolName?: string;

  @IsObject()
  @IsOptional()
  args?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  sessionId?: string;
}

// ─── POST /tools/permission ────────────────────────────────────────────────

/** 设置工具权限 DTO */
export class SetToolPermissionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  toolId!: string;

  @IsString()
  @IsOptional()
  @IsIn(['auto', 'allow', 'ask', 'disabled'])
  permission?: string;

  @IsBoolean()
  @IsOptional()
  disabled?: boolean;
}
