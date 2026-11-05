import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 对端匹配条件（嵌套于 CreateBindingDto.match.peer）
 */
export class PeerMatchDto {
  @IsString()
  @MaxLength(200)
  @IsOptional()
  id?: string;

  @IsString()
  @MaxLength(50)
  @IsOptional()
  kind?: string;
}

/**
 * binding.match 子结构（嵌套于 CreateBindingDto.match）
 */
export class BindingMatchDto {
  @IsString()
  @MaxLength(100)
  @IsOptional()
  channel?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  accountId?: string;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => PeerMatchDto)
  peer?: PeerMatchDto;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  guildId?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  teamId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsOptional()
  roles?: string[];
}

/**
 * 创建绑定 DTO（对应 POST /api/bindings）
 *
 * 兼容 .cjs 两种入参形式：
 *   1. 嵌套：{ agentId, match: { channel, accountId, peer, guildId, teamId, roles } }
 *   2. 扁平：{ agentId, matchChannel, matchAccountId, matchPeerId, matchPeerKind,
 *             matchGuildId, matchTeamId, matchRoles }
 *
 * BindingService.addBinding 会将扁平字段折叠到 match。
 */
export class CreateBindingDto {
  @IsString()
  @MaxLength(200)
  @IsOptional()
  id?: string;

  @IsString()
  @MaxLength(200)
  agentId!: string;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => BindingMatchDto)
  match?: BindingMatchDto;

  // ─── 兼容扁平字段（.cjs 旧版风格） ───────────────────────────────────

  @IsString()
  @MaxLength(100)
  @IsOptional()
  matchChannel?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  matchAccountId?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  matchPeerId?: string;

  @IsString()
  @MaxLength(50)
  @IsOptional()
  matchPeerKind?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  matchGuildId?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  matchTeamId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsOptional()
  matchRoles?: string[];
}

/**
 * 通过 body.id 删除绑定 DTO（对应 POST /api/bindings/remove）
 *
 * 兼容 .cjs /bindings/remove 路由（DELETE 或 POST 均可）。
 */
export class RemoveBindingDto {
  @IsString()
  @MaxLength(200)
  id!: string;
}
