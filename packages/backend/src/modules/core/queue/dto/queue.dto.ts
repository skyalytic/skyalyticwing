import { IsIn, IsNotEmpty, IsOptional } from 'class-validator';

/** POST /queue/enqueue 请求体 */
export class EnqueueDto {
  /** 消息载荷（chat / subscribe / tool_execute 等） */
  @IsNotEmpty()
  message!: unknown;

  @IsOptional()
  @IsIn(['normal', 'high'])
  priority?: 'normal' | 'high';
}
