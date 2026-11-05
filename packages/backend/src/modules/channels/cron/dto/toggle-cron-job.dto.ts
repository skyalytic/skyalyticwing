import { IsBoolean, IsString } from 'class-validator';

/**
 * Cron 扩展 DTO
 *
 *   PUT /api/cron/toggle  body { id, enabled }
 */
export class ToggleCronJobDto {
  @IsString()
  id!: string;

  @IsBoolean()
  enabled!: boolean;
}
