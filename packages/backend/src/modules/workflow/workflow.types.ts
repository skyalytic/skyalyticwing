export interface WorkflowStep {
  id: string;
  name: string;
  prompt: string;
  model?: string;
  agentId?: string;
  dependsOn?: string[];
  reviewBefore?: boolean;
}
export type WorkflowRunStatus =
  'running' | 'success' | 'error' | 'interrupted' | 'cancelled' | 'paused';
export type WorkflowLastRunStatus = WorkflowRunStatus | null;
export interface WorkflowBudget {
  maxCalls: number;
  maxDurationMs: number;
}
export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  teamId?: string;
  budget?: WorkflowBudget;
  createdAt: number;
  updatedAt: number;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastRunStatus?: WorkflowLastRunStatus;
}
export interface WorkflowStepResult {
  stepId: string;
  ok: boolean;
  output: string;
  durationMs: number;
  error?: string;
  agentId?: string;
  agentName?: string;
  model?: string;
  calls?: number;
  tokens?: number;
  workspace?: string;
}
export interface WorkflowRunLog {
  identity?: string;
  id: string;
  workflowId: string;
  startedAt: number;
  finishedAt: number | null;
  status: WorkflowRunStatus;
  stepResults: WorkflowStepResult[];
  snapshot: WorkflowDef;
  model?: string;
  activeStepId?: string;
  activeAgentId?: string;
  reviewStepId?: string;
  approvedSteps: string[];
  calls: number;
  elapsedMs: number;
  error?: string;
}
export interface WorkflowCreateInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  enabled?: boolean;
  teamId?: string;
  budget?: WorkflowBudget;
}
