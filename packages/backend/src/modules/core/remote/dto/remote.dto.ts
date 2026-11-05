import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** POST /remote/nodes（注册节点）请求体 */
export class RegisterNodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  capabilities?: string[];
}

/** POST /remote/dispatch 请求体 */
export class DispatchDto {
  @IsString()
  @MaxLength(128)
  nodeId!: string;

  @IsOptional()
  task?: unknown;
}

/** POST /remote/remove 请求体 */
export class RemoveNodeDto {
  @IsString()
  @MaxLength(128)
  nodeId!: string;
}

/** POST /remote/connect、POST /remote/disconnect 请求体 */
export class NodeActionDto {
  @IsString()
  @MaxLength(128)
  nodeId!: string;
}

/** 节点能力白名单（对齐旧版默认值） */
export const NODE_CAPABILITIES = ['chat', 'tool_use', 'research', 'code', 'media'] as const;
