import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Memory DTO
 *
 *   POST /api/memory/knowledge  body { title, content, tags? }
 */
export class AddKnowledgeDto {
  @IsString()
  @MaxLength(500)
  title!: string;

  @IsString()
  @MaxLength(100_000)
  content!: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  tags?: string[];
}
