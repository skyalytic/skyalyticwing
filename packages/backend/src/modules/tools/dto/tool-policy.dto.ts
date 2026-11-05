import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 创建工具策略 DTO（POST /api/tool-policies）
 *
 * 对应 start.cjs ToolPolicyPipeline.registerPolicy(name, policy)。
 * policy 形如 { allow: ["bash", "file_*"], deny: ["desktop_*"] }。
 */
export class CreateToolPolicyDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @IsOptional()
  allow?: string[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @IsOptional()
  deny?: string[];
}
