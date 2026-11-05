import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 创建会话 DTO（对应 POST /api/sessions）
 *
 * ValidationPipe（whitelist + transform）会基于本类装饰器校验并过滤字段。
 */
export class CreateSessionDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;
}
