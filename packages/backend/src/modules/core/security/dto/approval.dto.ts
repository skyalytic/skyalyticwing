import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** 审批决策类型（4 种，对齐旧版） */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'denied' | 'deny-always';

// ─── POST /approvals/:id ────────────────────────────────────────────────────

/** 处理审批 DTO */
export class ProcessApprovalDto {
  @IsIn(['allow-once', 'allow-always', 'denied', 'deny-always'])
  decision!: ApprovalDecision;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
