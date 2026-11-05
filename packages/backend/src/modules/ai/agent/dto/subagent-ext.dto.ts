import { IsArray, IsOptional, IsString } from 'class-validator';
import type { SubAgentTaskConfig } from '../agent-swarm.service.js';

/**
 * Subagents 扩展 DTO
 *
 *   POST /api/subagents/fork      body { parentSessionId?, task?, prompt?, systemPrompt? }
 *   POST /api/subagents/terminate body { agentId }
 *   POST /api/subagents/swarm     body { parentId?, tasks: string[] | 任务配置[] }
 */

/** POST /api/subagents/fork */
export class SubagentForkDto {
  @IsString()
  @IsOptional()
  parentSessionId?: string;

  @IsString()
  @IsOptional()
  task?: string;

  @IsString()
  @IsOptional()
  prompt?: string;

  @IsString()
  @IsOptional()
  systemPrompt?: string;
}

/** POST /api/subagents/terminate */
export class SubagentTerminateDto {
  @IsString()
  agentId!: string;
}

/** POST /api/subagents/swarm */
export class SubagentSwarmDto {
  @IsString()
  @IsOptional()
  parentId?: string;

  /** 蜂群任务列表：字符串或任务配置对象（与 .cjs 一致，由服务端归一化） */
  @IsArray()
  tasks!: Array<string | SubAgentTaskConfig>;
}
