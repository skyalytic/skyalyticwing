export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  parameters?: Record<string, { type: string; description: string; required?: boolean }>;
}

export type ToolExecution =
  | { toolId: string; input: Record<string, unknown>; output: unknown; duration?: number; error?: never }
  | { toolId: string; input: Record<string, unknown>; error: string; duration?: number; output?: never };
