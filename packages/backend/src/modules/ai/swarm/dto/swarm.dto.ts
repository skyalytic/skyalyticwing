import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** 蜂群成员配置 */
export class SwarmMemberDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  agentId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['leader', 'worker', 'reviewer', 'researcher', 'coder', 'tester'])
  role?: string;
}

/** POST /swarm/create 请求体 */
export class CreateSwarmDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['collaborate', 'compete', 'hierarchical', 'pipeline'])
  mode?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SwarmMemberDto)
  members?: SwarmMemberDto[];
}

/** POST /swarm/send 请求体 */
export class SwarmSendDto {
  @IsString()
  @MaxLength(128)
  teamId!: string;

  @IsString()
  @MaxLength(128)
  fromId!: string;

  @IsString()
  @MaxLength(10000)
  message!: string;
}

/** POST /swarm/broadcast 请求体 */
export class SwarmBroadcastDto {
  @IsString()
  @MaxLength(128)
  teamId!: string;

  @IsString()
  @MaxLength(10000)
  message!: string;
}

/** POST /swarm/delete 请求体 */
export class SwarmDeleteDto {
  @IsString()
  @MaxLength(128)
  teamId!: string;
}
