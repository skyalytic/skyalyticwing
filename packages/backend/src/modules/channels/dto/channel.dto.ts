import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 创建渠道 DTO（对应 POST /api/channels）
 *
 * credentials 为敏感字段，控制器响应中会被脱敏（不返回）。
 */
export class CreateChannelDto {
  @IsString()
  @MaxLength(100)
  id!: string;

  @IsString()
  @MaxLength(50)
  type!: string;

  @IsString()
  @MaxLength(100)
  name!: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsObject()
  @IsOptional()
  credentials?: Record<string, string>;

  @IsObject()
  @IsOptional()
  options?: Record<string, unknown>;
}

/** 更新渠道 DTO（对应 PUT /api/channels/:id） */
export class UpdateChannelDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsObject()
  @IsOptional()
  credentials?: Record<string, string>;

  @IsObject()
  @IsOptional()
  options?: Record<string, unknown>;
}

/** 发送渠道消息 DTO（对应 POST /api/channels/:id/send） */
export class SendChannelMessageDto {
  @IsString()
  target!: string;

  @IsString()
  content!: string;
}
