import { IsArray, IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import type { Attachment } from '@skyalyticwing/shared';

/**
 * 发送消息 DTO（对应 ChatRequest）
 *
 *   POST /api/chat/send
 * ValidationPipe（whitelist + transform）会基于本类的装饰器进行校验与字段过滤。
 */
export class SendMessageDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,100}$/)
  turnId?: string;

  @IsString()
  session!: string;

  @IsString()
  message!: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  agent?: string;

  @IsBoolean()
  @IsOptional()
  stream?: boolean;

  @IsArray()
  @IsOptional()
  attachments?: Attachment[];
}
