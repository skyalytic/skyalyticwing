import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /tools/custom 请求体 */
export class CreateCustomToolDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['system', 'network', 'files', 'data', 'automation', 'media', 'other'])
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  dangerous?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['ask', 'auto', 'deny'])
  permission?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  endpoint?: string;

  @IsOptional()
  @IsString()
  @IsIn(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  method?: string;
}

/** DELETE /tools/custom 请求体 */
export class DeleteCustomToolDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  id!: string;
}
