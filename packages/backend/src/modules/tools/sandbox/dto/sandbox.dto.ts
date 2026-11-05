import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 沙箱执行选项 */
export class SandboxExecOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cwd?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeout?: number;
}

/** POST /sandbox/execute 请求体 */
export class SandboxExecuteDto {
  @IsString()
  @MaxLength(10000)
  command!: string;

  @IsOptional()
  @IsObject()
  options?: SandboxExecOptionsDto;
}

/** POST /sandbox/validate 请求体 */
export class SandboxValidateDto {
  @IsString()
  @MaxLength(10000)
  command!: string;
}

/** PUT /sandbox-enhanced 请求体（配置更新） */
export class UpdateSandboxEnhancedDto {
  @IsOptional()
  @IsIn(['off', 'non-main', 'all'])
  mode?: 'off' | 'non-main' | 'all';

  @IsOptional()
  @IsIn(['docker', 'ssh'])
  backend?: 'docker' | 'ssh';

  @IsOptional()
  @IsIn(['session', 'global'])
  scope?: 'session' | 'global';

  @IsOptional()
  @IsIn(['none', 'ro', 'rw'])
  workspaceAccess?: 'none' | 'ro' | 'rw';

  @IsOptional()
  @IsObject()
  docker?: { image?: string; workdir?: string; workspaceRoot?: string };

  @IsOptional()
  @IsObject()
  ssh?: { host?: string; port?: number; username?: string };
}

/** POST /sandbox-enhanced/create 请求体 */
export class CreateSandboxContainerDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionKey?: string;
}

/** POST /sandbox-enhanced/exec 请求体 */
export class ExecSandboxContainerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  containerName!: string;

  @IsString()
  @MaxLength(10000)
  command!: string;
}

/** POST /sandbox-enhanced/destroy 请求体 */
export class DestroySandboxContainerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  containerName!: string;
}
