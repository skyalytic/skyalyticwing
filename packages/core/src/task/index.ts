import { createLogger, type Logger, generateId } from '@skyalyticwing/shared';

export interface Task {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export class TaskManager {
  private logger: Logger;
  private tasks: Map<string, Task> = new Map();
  /** M23: 最大任务数上限，防止 Map 无限增长 */
  private readonly maxTasks = 10000;
  /** M23: 终态任务状态，这些任务优先被清理 */
  private readonly terminalStates = new Set(['completed', 'failed', 'cancelled']);
  private validTransitions: Record<string, string[]> = {
    pending: ['running', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: ['pending'],
    cancelled: ['pending'],
  };

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'task' });
  }

  /** M23: 清理旧的终态任务，保持 Map 在 maxTasks 以内 */
  private evictOldTasks(): void {
    if (this.tasks.size <= this.maxTasks) return;
    // 优先清理最早的终态任务
    for (const [id, task] of this.tasks) {
      if (this.terminalStates.has(task.status)) {
        this.tasks.delete(id);
        if (this.tasks.size <= this.maxTasks * 0.8) return;
      }
    }
    // 如果终态任务清理后仍超限，清理最旧的任务
    if (this.tasks.size > this.maxTasks) {
      const entries = Array.from(this.tasks.entries())
        .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
      const toRemove = entries.slice(0, this.tasks.size - this.maxTasks);
      for (const [id] of toRemove) {
        this.tasks.delete(id);
      }
    }
  }

  create(type: string, input: unknown): Task {
    const task: Task = {
      id: generateId(),
      type,
      status: 'pending',
      input,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    // TS-11 fix: 使用 logger 消除未使用警告
    this.logger.debug({ taskId: task.id, type }, 'Task created');
    this.evictOldTasks();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  update(id: string, update: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const { id: _id, createdAt: _createdAt, ...safeUpdate } = update as Task & { id?: string; createdAt?: string };
    // Validate status transition
    if (safeUpdate.status && safeUpdate.status !== task.status) {
      const allowed = this.validTransitions[task.status];
      if (!allowed || !allowed.includes(safeUpdate.status)) {
        throw new Error(`Invalid task state transition: ${task.status} -> ${safeUpdate.status}`);
      }
    }
    Object.assign(task, safeUpdate);
    if (safeUpdate.status === 'completed' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }
    return task;
  }
}
