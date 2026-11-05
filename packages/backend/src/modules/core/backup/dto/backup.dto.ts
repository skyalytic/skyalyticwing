import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /backup/create 请求体 */
export class CreateBackupDto {
  @IsOptional()
  @IsBoolean()
  includeConfig?: boolean;

  @IsOptional()
  @IsBoolean()
  includeSessions?: boolean;

  @IsOptional()
  @IsBoolean()
  includeMemory?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAgents?: boolean;

  @IsOptional()
  @IsBoolean()
  includePermissions?: boolean;

  @IsOptional()
  @IsBoolean()
  includeCron?: boolean;

  @IsOptional()
  @IsBoolean()
  includeSubAgents?: boolean;

  @IsOptional()
  @IsBoolean()
  includeWorkspace?: boolean;

  @IsOptional()
  @IsBoolean()
  includeMemoryFiles?: boolean;

  @IsOptional()
  @IsBoolean()
  includeDreams?: boolean;
}

/** POST /backup/verify + /backup/restore + /backup/delete 请求体 */
export class BackupNameDto {
  @IsString()
  @MaxLength(200)
  name!: string;
}
