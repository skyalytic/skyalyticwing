import { IsString } from 'class-validator';

/**
 * Sessions 扩展 DTO
 *
 *   POST /api/sessions/restore  body { sessionId }
 */
export class RestoreSessionDto {
  @IsString()
  sessionId!: string;
}
