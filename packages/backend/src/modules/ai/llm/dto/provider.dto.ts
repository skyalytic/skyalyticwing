import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// ─── PUT /providers/:id ────────────────────────────────────────────────────

/**
 * 更新供应商 DTO
 *
 * 对应 PUT /api/providers/:id，支持部分更新：
 *   - apiKey: API 密钥（生产环境可用 ${ENV_VAR} 引用环境变量）
 *   - baseUrl: 基础 URL（经 SSRF 校验）
 *   - models: 模型列表
 *   - displayName: 自定义显示名
 *   - temperature: 温度参数
 *   - maxTokens: 最大 token 数
 */
export class UpdateProviderDto {
  @IsArray() @IsOptional() visionModels?: string[];
  @IsArray() @IsOptional() imageModels?: string[];
  @IsArray() @IsOptional() videoModels?: string[];
  @IsString() @IsOptional() imageProtocol?: string;
  @IsString() @IsOptional() videoProtocol?: string;
  @IsString() @IsOptional() @MaxLength(2000) imageBaseUrl?: string;
  @IsString() @IsOptional() @MaxLength(2000) videoBaseUrl?: string;
  @IsString()
  @IsOptional()
  @MaxLength(500)
  apiKey?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  baseUrl?: string;

  @IsArray()
  @IsOptional()
  models?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(200)
  displayName?: string;

  @IsNumber()
  @IsOptional()
  temperature?: number;

  @IsNumber()
  @IsOptional()
  maxTokens?: number;

  /** 供应商协议类型（openai/anthropic/local/custom）——多实例 ID（如 anthropic_2）
   *  无法从 ID 本身推断协议，必须显式携带供 LLM 路由使用 */
  @IsString()
  @IsOptional()
  @MaxLength(20)
  type?: string;

  /** 多实例的所属注册表厂商 ID（如 openai_2 → openai），列表页据此归并品牌与类型 */
  @IsString()
  @IsOptional()
  @MaxLength(50)
  baseProvider?: string;
}
