import { IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** POST /vectors/add 请求体 */
export class AddVectorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50000)
  content!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/** 相似搜索选项 */
export class VectorSearchOptionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  topK?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number;
}

/** POST /vectors/search 请求体 */
export class SearchVectorDto {
  @IsString()
  @MaxLength(10000)
  query!: string;

  @IsOptional()
  @IsObject()
  options?: VectorSearchOptionsDto;
}

/** POST /vectors/delete 请求体 */
export class DeleteVectorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  id!: string;
}
