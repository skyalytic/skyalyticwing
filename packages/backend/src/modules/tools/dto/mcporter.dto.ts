import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** 添加 MCP 服务器 DTO（POST /mcporter/servers） */
export class McporterAddServerDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsObject()
  options?: {
    transport?: string;
    scope?: string;
    header?: string | string[];
  };
}

/** 移除 MCP 服务器 DTO（POST /mcporter/servers/remove） */
export class McporterRemoveServerDto {
  @IsString()
  @MaxLength(128)
  name!: string;
}

/** 调用 MCP 工具 DTO（POST /mcporter/call） */
export class McporterCallToolDto {
  /** 格式：server.tool（兼容 tool 字段名，对齐旧版） */
  @IsString()
  @MaxLength(256)
  serverDotTool!: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

/** 熔断器重置 DTO（POST /breaker-reset） */
export class BreakerResetDto {
  @IsString()
  @IsOptional()
  @MaxLength(128)
  tool?: string;
}

/** 审批兼容路径 DTO（POST /approvals/resolve） */
export class ApprovalResolveCompatDto {
  /** 审批 ID（兼容 id / approvalId 两种字段名） */
  @IsString()
  @IsOptional()
  @MaxLength(128)
  id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(128)
  approvalId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  decision?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
