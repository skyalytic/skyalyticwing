import { IsString, MaxLength } from 'class-validator';

/**
 * 在 worktree 中执行命令的 DTO（POST /api/worktrees/:id/exec）
 */
export class WorktreeExecDto {
  @IsString()
  @MaxLength(2000)
  command!: string;
}

/**
 * 移除 worktree 的 DTO（POST /api/worktrees/remove）
 */
export class WorktreeRemoveDto {
  @IsString()
  @MaxLength(200)
  worktreeId!: string;
}

/**
 * 创建 worktree 的 DTO（POST /api/worktrees）
 */
export class WorktreeCreateDto {
  @IsString()
  @MaxLength(500)
  path!: string;

  @IsString()
  @MaxLength(200)
  branch!: string;
}
