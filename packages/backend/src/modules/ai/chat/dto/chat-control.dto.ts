import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Chat 控制 DTO（对应 POST /api/chat/stop、/api/compact、/api/micro-compact、/api/steer）
 *
 * 移植自 start.cjs：
 *   - /chat/stop     body { sessionId }（可选，缺省中断全部活跃会话）
 *   - /compact       body { sessionId, model? }
 *   - /micro-compact body { sessionId }
 *   - /steer         body { session, message }
 */

/** POST /api/chat/stop */
export class ChatStopDto {
  @IsString()
  @IsOptional()
  sessionId?: string;

  /** 兼容旧版字段名 session */
  @IsString()
  @IsOptional()
  session?: string;
}

/** POST /api/compact */
export class CompactDto {
  @IsString()
  @IsOptional()
  sessionId?: string;

  /** 兼容旧版字段名 id */
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  model?: string;
}

/** POST /api/micro-compact */
export class MicroCompactDto {
  @IsString()
  @IsOptional()
  sessionId?: string;
}

/** POST /api/steer */
export class SteerDto {
  @IsString()
  session!: string;

  @IsString()
  @MaxLength(100_000)
  message!: string;
}
