import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// ─── POST /security/pairing ────────────────────────────────────────────────

/** DM 设备配对 DTO */
export class SecurityPairingDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  senderId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  channel?: string;
}

// ─── POST /security/fix ────────────────────────────────────────────────────

/** 修复单个安全问题 DTO */
export class SecurityFixDto {
  @IsString()
  @MaxLength(200)
  id!: string;
}

// ─── POST /security/audit ──────────────────────────────────────────────────

/** 安全扫描 DTO */
export class SecurityAuditDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  skillName?: string;
}

// ─── POST /security/scan-skill ─────────────────────────────────────────────

/** 技能安全扫描 DTO（扫描 skills 目录下指定技能的 SKILL.md 等文件） */
export class SecurityScanSkillDto {
  @IsString()
  @MaxLength(200)
  skillName!: string;
}

// ─── POST /security/approve ────────────────────────────────────────────────

/** 安全审批 DTO（always 写入全局允许列表；session 写入会话允许列表） */
export class SecurityApproveDto {
  @IsString()
  @IsOptional()
  @MaxLength(20)
  mode?: 'always' | 'session';

  @IsString()
  @IsOptional()
  @MaxLength(500)
  pattern?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  sessionId?: string;
}

// ─── GET /secretref/resolve ────────────────────────────────────────────────

/** 密钥解析查询参数（从 query string 读取） */
export class SecretRefResolveQuery {
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  ref?: string;
}
