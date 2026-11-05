import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MAX_TASKS } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';

/**
 * TaskManager (任务管理) - NestJS TypeScript 实现
 *
 * start.cjs 中未直接找到 TaskManager 命名实现，本服务按任务规格实现：
 *   - 任务创建 / 更新 / 完成 / 失败
 *   - maxTasks = 10000 淘汰策略（FIFO，超出后丢弃最旧任务）
 *   - 任务状态追踪（pending / running / completed / failed / cancelled）
 *
 * 任务以 Map 存储，按 createdAt 维护插入顺序便于淘汰。
 */

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 任务实体 */
export interface AgentTask {
  id: string;
  /** 所属代理 ID（可为父代理或子代理） */
  agentId: string;
  /** 任务标题 / 简短描述 */
  title: string;
  /** 任务详细描述 / 指令 */
  description?: string;
  status: TaskStatus;
  /** 任务优先级（数字越大优先级越高） */
  priority: number;
  /** 任务结果（成功时填充） */
  result?: string;
  /** 任务错误（失败时填充） */
  error?: string;
  /** 进度（0-100） */
  progress: number;
  /** 标签 */
  tags: string[];
  /** 关联的父任务 ID */
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** 创建任务入参 */
export interface CreateTaskInput {
  agentId: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  parentId?: string;
}

/** 更新任务入参（部分字段） */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  progress?: number;
  tags?: string[];
  result?: string;
  error?: string;
}

/** 任务查询结果 */
export interface TaskListResult {
  tasks: AgentTask[];
  total: number;
}

@Injectable()
export class TaskManagerService {
  /** 任务存储：taskId -> AgentTask */
  private readonly tasks = new Map<string, AgentTask>();
  /** 插入顺序队列（FIFO 淘汰用），仅存 taskId */
  private readonly order: string[] = [];
  /** 状态索引：status -> taskId 集合（便于按状态查询） */
  private readonly statusIndex = new Map<TaskStatus, Set<string>>();
  /** 代理索引：agentId -> taskId 集合（便于按代理查询） */
  private readonly agentIndex = new Map<string, Set<string>>();

  /** 任务最大保留数量 */
  readonly maxTasks = MAX_TASKS;

  constructor(private readonly logger: LoggerService) {}

  /**
   * 创建任务
   * - 生成唯一 ID
   * - 初始状态 pending，进度 0
   * - 维护顺序队列与索引
   * - 超过 maxTasks 时按 FIFO 淘汰最旧任务
   */
  createTask(input: CreateTaskInput): AgentTask {
    if (!input.agentId || !input.title) {
      throw new Error('createTask requires agentId and title');
    }
    const now = Date.now();
    const task: AgentTask = {
      id: randomUUID(),
      agentId: input.agentId,
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      priority: input.priority ?? 0,
      progress: 0,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.parentId !== undefined) task.parentId = input.parentId;
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    this.addToIndex(this.statusIndex, task.status, task.id);
    this.addToIndex(this.agentIndex, task.agentId, task.id);
    this.evictIfNeeded();
    this.logger.debug('task-manager: Task created', { taskId: task.id, agentId: task.agentId });
    return task;
  }

  /**
   * 更新任务
   * - 部分字段更新
   * - 状态变更时维护索引与时间戳（startedAt / completedAt）
   */
  updateTask(taskId: string, patch: UpdateTaskInput): AgentTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const prevStatus = task.status;
    const now = Date.now();

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.progress !== undefined) task.progress = patch.progress;
    if (patch.tags !== undefined) task.tags = patch.tags;
    if (patch.result !== undefined) task.result = patch.result;
    if (patch.error !== undefined) task.error = patch.error;

    if (patch.status !== undefined && patch.status !== prevStatus) {
      task.status = patch.status;
      // 维护状态索引
      this.removeFromIndex(this.statusIndex, prevStatus, task.id);
      this.addToIndex(this.statusIndex, task.status, task.id);
      // 状态时间戳
      if (patch.status === 'running' && !task.startedAt) {
        task.startedAt = now;
      }
      if (
        patch.status === 'completed' ||
        patch.status === 'failed' ||
        patch.status === 'cancelled'
      ) {
        task.completedAt = now;
      }
    }
    task.updatedAt = now;
    return task;
  }

  /** 标记任务完成（状态 completed + 结果） */
  completeTask(taskId: string, result?: string): AgentTask {
    return this.updateTask(taskId, {
      status: 'completed',
      progress: 100,
      ...(result !== undefined ? { result } : {}),
    });
  }

  /** 标记任务失败（状态 failed + 错误信息） */
  failTask(taskId: string, error: string): AgentTask {
    return this.updateTask(taskId, { status: 'failed', error });
  }

  /** 取消任务 */
  cancelTask(taskId: string, reason?: string): AgentTask {
    return this.updateTask(taskId, {
      status: 'cancelled',
      ...(reason !== undefined ? { error: reason } : {}),
    });
  }

  /** 开始执行任务（状态 running） */
  startTask(taskId: string): AgentTask {
    return this.updateTask(taskId, { status: 'running', progress: 0 });
  }

  /** 更新任务进度 */
  setProgress(taskId: string, progress: number): AgentTask {
    return this.updateTask(taskId, { progress: Math.max(0, Math.min(100, progress)) });
  }

  /** 获取单个任务 */
  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 列出全部任务（可按状态/代理过滤） */
  listTasks(filter?: { status?: TaskStatus; agentId?: string }): TaskListResult {
    let tasks: AgentTask[];
    if (filter?.status && filter?.agentId) {
      const byStatus = this.statusIndex.get(filter.status) || new Set<string>();
      const byAgent = this.agentIndex.get(filter.agentId) || new Set<string>();
      tasks = Array.from(byStatus)
        .filter((id) => byAgent.has(id))
        .map((id) => this.tasks.get(id)!)
        .filter(Boolean);
    } else if (filter?.status) {
      tasks = Array.from(this.statusIndex.get(filter.status) || new Set<string>())
        .map((id) => this.tasks.get(id)!)
        .filter(Boolean);
    } else if (filter?.agentId) {
      tasks = Array.from(this.agentIndex.get(filter.agentId) || new Set<string>())
        .map((id) => this.tasks.get(id)!)
        .filter(Boolean);
    } else {
      tasks = Array.from(this.tasks.values());
    }
    // 按 createdAt 升序
    tasks.sort((a, b) => a.createdAt - b.createdAt);
    return { tasks, total: tasks.length };
  }

  /** 删除任务 */
  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.tasks.delete(taskId);
    this.removeFromIndex(this.statusIndex, task.status, taskId);
    this.removeFromIndex(this.agentIndex, task.agentId, taskId);
    const idx = this.order.indexOf(taskId);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  /** 清理指定代理的所有任务 */
  clearTasksByAgent(agentId: string): number {
    const ids = this.agentIndex.get(agentId);
    if (!ids) return 0;
    let count = 0;
    for (const id of Array.from(ids)) {
      if (this.deleteTask(id)) count++;
    }
    return count;
  }

  /** 当前任务总数 */
  getTaskCount(): number {
    return this.tasks.size;
  }

  /** 按状态统计任务数 */
  getStatusCounts(): Record<TaskStatus, number> {
    return {
      pending: this.statusIndex.get('pending')?.size || 0,
      running: this.statusIndex.get('running')?.size || 0,
      completed: this.statusIndex.get('completed')?.size || 0,
      failed: this.statusIndex.get('failed')?.size || 0,
      cancelled: this.statusIndex.get('cancelled')?.size || 0,
    };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /**
   * 淘汰策略：任务数超过 maxTasks 时，按 FIFO 移除最旧的（仅移除已终结任务；
   * 若已终结任务不足，则移除最旧的 pending/cancelled 任务，避免误删 running 任务）
   */
  private evictIfNeeded(): void {
    while (this.order.length > this.maxTasks) {
      const oldestId = this.order[0];
      const oldest = this.tasks.get(oldestId);
      if (!oldest) {
        this.order.shift();
        continue;
      }
      // 优先淘汰已终结任务
      if (['completed', 'failed', 'cancelled'].includes(oldest.status)) {
        this.deleteTask(oldestId);
        continue;
      }
      // 找下一个可安全淘汰的（跳过 running）
      let evicted = false;
      for (let i = 0; i < this.order.length; i++) {
        const id = this.order[i];
        const t = this.tasks.get(id);
        if (!t) {
          this.order.splice(i, 1);
          i--;
          evicted = true;
          break;
        }
        if (t.status === 'running') continue;
        this.deleteTask(id);
        evicted = true;
        break;
      }
      if (!evicted) {
        // 全部 running，强制淘汰最旧的（极端情况）
        this.deleteTask(oldestId);
      }
    }
  }

  private addToIndex(
    index: Map<string, Set<string>>,
    key: string,
    taskId: string,
  ): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(taskId);
  }

  private removeFromIndex(
    index: Map<string, Set<string>>,
    key: string,
    taskId: string,
  ): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(taskId);
    if (set.size === 0) index.delete(key);
  }
}
