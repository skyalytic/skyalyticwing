import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** 权限模式（与 AgentLoop 安全闸门读取的 security.yolo 一致：
 * ask 需要审批 / auto 智能安全 / yolo 完全信任） */
export type PermissionMode = 'ask' | 'auto' | 'yolo';

/** 命令规则类型 */
export type CommandRuleType = 'allow' | 'deny';

/** 权限规则类型（含 ask） */
export type PermissionRuleType = 'allow' | 'deny' | 'ask';

// ─── PUT /permissions/mode ─────────────────────────────────────────────────

/** 切换权限模式 DTO */
export class SwitchPermissionModeDto {
  @IsIn(['ask', 'auto', 'yolo'])
  mode!: PermissionMode;
}

// ─── POST /permissions/rules ────────────────────────────────────────────────

/** 创建权限规则 DTO */
export class CreatePermissionRuleDto {
  @IsIn(['allow', 'deny', 'ask'])
  type!: PermissionRuleType;

  @IsString()
  @MaxLength(200)
  tool!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

// ─── DELETE /permissions/rules ──────────────────────────────────────────────

/** 删除权限规则 DTO（按 id 或 tool） */
export class DeletePermissionRuleDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  tool?: string;
}

// ─── POST /permissions/rules/change ─────────────────────────────────────────

/** 修改权限规则 DTO */
export class ChangePermissionRuleDto {
  @IsString()
  @MaxLength(200)
  id!: string;

  @IsIn(['allow', 'deny', 'ask'])
  @IsOptional()
  type?: PermissionRuleType;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  tool?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

// ─── POST /permissions/command-rules ────────────────────────────────────────

/** 创建命令规则 DTO */
export class CreateCommandRuleDto {
  @IsIn(['allow', 'deny'])
  type!: CommandRuleType;

  @IsString()
  @MaxLength(500)
  command!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

// ─── DELETE /permissions/command-rules ──────────────────────────────────────

/** 删除命令规则 DTO（按 id 或 command） */
export class DeleteCommandRuleDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  command?: string;
}

// ─── POST /permissions/classify ─────────────────────────────────────────────

/** 命令分类测试 DTO */
export class ClassifyCommandDto {
  @IsString()
  @MaxLength(2000)
  command!: string;
}

// ─── POST /permissions/audit/delete ────────────────────────────────────────

/** 删除单条审计 DTO */
export class DeleteAuditDto {
  @IsString()
  @MaxLength(200)
  id!: string;
}

// ─── POST /security/sandbox/run ────────────────────────────────────────────

/** 沙箱执行 DTO */
export class SandboxRunDto {
  @IsString()
  @MaxLength(5000)
  command!: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  sandboxId?: string;
}
