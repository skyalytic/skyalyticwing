import { SchedulerService } from '../../core/scheduler/scheduler.service.js';
import {
  Inject,
  Injectable,
  OnModuleInit,
  OnApplicationBootstrap,
  Optional,
  ConflictException,
} from '@nestjs/common';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import type { Attachment, ChatMessage } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { AgentLoopService } from '../agent/agent-loop.service.js';
import { ChatControlRegistry } from '../chat/chat-control.registry.js';
import { SESSION_SERVICE, type ISessionService } from '../types.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';

/**
 * BackgroundTaskService - 超长任务后台执行服务
 *
 * 解决"单轮对话 HTTP 15 分钟超时无法覆盖小时级任务"的问题：
 *   提交任务 → 立即返回任务 ID（AI 随即回复用户"已转后台"）→
 *   后台以独立隔离会话（bg-task-<id>）驱动 AgentLoop 完整 harness 循环 →
 *   WS background_task 事件实时推送进度 → 完成后结果（含视频等附件）
 *   回流原会话（chat_message）并弹通知。
 *
 * 设计要点：
 *   - 任务执行会话与原会话隔离：后台 AI 从零开始，prompt 必须自包含
 *     （background_task_submit 工具描述中已强制要求）
 *   - 审批复用 ApprovalService：approval_request 全局广播，后台任务的
 *     危险工具审批卡照常出现在前端对话页，用户批准/拒绝经 POST
 *     /approvals/:id 解除 AgentLoop 等待（120s 超时视为拒绝，任务继续）
 *   - 取消：ChatControlRegistry.requestAbort(taskSessionId)，
 *     AgentLoop 迭代边界消费标志后以 error 事件结束 → 本服务按
 *     cancelling 标记区分"用户取消"与"真失败"
 *   - 持久化：background-tasks.json（writeLock 串行化写，防并发损坏）；
 *     服务重启时未完结任务（pending/running）标记 interrupted——
 *     AgentLoop 生成过程无法跨进程恢复，诚实标记而非静默丢弃
 *   - 进度推送节流：tool_call/tool_result 每次都推（频率天然受 LLM/
 *     工具执行节奏限制，无需额外节流）
 */
export type BackgroundTaskStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 后台任务记录（持久化形态：background-tasks.json） */
export interface BackgroundTask {
  memoryIdentity?: string;
  id: string;
  title: string;
  /** 后台执行的完整自包含指令 */
  prompt: string;
  /** 发起会话（结果回流目标） */
  sessionId: string;
  /** 隔离执行会话（bg-task-<id>） */
  taskSessionId: string;
  status: BackgroundTaskStatus;
  /** 当前进度描述（最近一次工具调用） */
  step: string;
  /** 完成时的最终 assistant 内容 */
  result: string | null;
  error: string | null;
  /** 完成时的附件（生成的视频/图片等，回流原会话展示） */
  attachments: Attachment[];
  model?: string;
  agentId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  attempts?: number;
}

/** 持久化条目（精简形态：prompt 截断防文件膨胀，attachments 不落盘——文件本体在 media/generated） */
interface PersistedTask {
  memoryIdentity?: string;
  id: string;
  title: string;
  prompt: string;
  sessionId: string;
  taskSessionId: string;
  status: BackgroundTaskStatus;
  step: string;
  result: string | null;
  error: string | null;
  model?: string;
  agentId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  attachments?: Attachment[];
  attempts?: number;
}

/** 历史任务保留上限（防 JSON 无限膨胀） */
const MAX_PERSISTED_TASKS = 100;
/** 持久化的 prompt/result 截断长度 */

@Injectable()
export class BackgroundTaskService implements OnModuleInit, OnApplicationBootstrap {
  private readonly tasks = new Map<string, BackgroundTask>();
  /** 用户已请求取消、等待 AgentLoop 结束的任务（区分取消与失败） */
  private readonly cancellingIds = new Set<string>();
  private storePath = '';
  /** 写入锁：Promise 链串行化（并发 persist 防半写损坏 JSON） */

  private readonly active = new Set<string>();
  private readonly queue: string[] = [];

  constructor(
    private readonly agentLoop: AgentLoopService,
    private readonly ws: WebSocketService,
    private readonly logger: LoggerService,
    @Optional() @Inject(SESSION_SERVICE) private readonly session?: ISessionService,
    @Optional() private readonly memoryPolicy?: LocalResourcePolicy,
    @Optional() private readonly scheduler?: SchedulerService,
  ) {}

  onModuleInit(): void {
    this.storePath = this.resolveDataFilePath('background-tasks.json');
    this.load();
    // Only never-started work is safe to automatically dispatch after restart.
    for (const task of this.tasks.values()) if (task.status === 'pending') this.queue.push(task.id);
  }
  onApplicationBootstrap(): void {
    this.scheduler?.registerDispatcher((input) => {
      const task = this.submit(input);
      this.scheduler?.background(task);
      return task;
    });
    for (const task of this.tasks.values()) this.scheduler?.background(task);
    this.drain();
  }

  /**
   * 提交后台任务：立即返回任务记录，执行异步进行。
   * 调用方（background_task_submit 工具）拿到 ID 后即刻回复用户，
   * 不阻塞当前对话轮次。
   */
  submit(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    title?: string;
    model?: string;
    agentId?: string;
  }): BackgroundTask {
    if (!input.prompt.trim()) throw new ConflictException('任务指令不能为空');
    const id = input.id || 'bgt-' + randomUUID();
    const existing = this.tasks.get(id);
    if (existing) {
      if (
        existing.memoryIdentity !== this.memoryPolicy?.credentialIdentity() ||
        existing.prompt !== input.prompt ||
        existing.sessionId !== input.sessionId
      )
        throw new ConflictException('Task identity conflict');
      return existing;
    }
    const task: BackgroundTask = {
      ...(this.memoryPolicy ? { memoryIdentity: this.memoryPolicy.credentialIdentity() } : {}),
      id,
      title: (input.title || '后台任务').slice(0, 120),
      prompt: input.prompt,
      sessionId: input.sessionId,
      taskSessionId: `bg-task-${id}`,
      status: 'pending',
      step: '排队中',
      result: null,
      error: null,
      attachments: [],
      ...(input.model ? { model: input.model } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      createdAt: Date.now(),
      attempts: 0,
    };
    this.tasks.set(id, task);
    this.persist();
    this.emitTaskEvent(task);
    this.logger.info('Background task submitted', {
      taskId: id,
      sessionId: input.sessionId,
      title: task.title,
    });
    // 异步执行：不 await——submit 必须立即返回
    this.queue.push(id);
    this.drain();
    return task;
  }

  /** 查询任务（不存在返回 null） */
  get(id: string): BackgroundTask | null {
    return this.tasks.get(id) ?? null;
  }

  /** 任务列表（按创建时间倒序） */
  list(): BackgroundTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 请求取消任务：置 abort 标志，AgentLoop 迭代边界消费后以取消态收尾 */
  cancel(id: string): BackgroundTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.status !== 'pending' && task.status !== 'running') return task;
    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.error = '任务已被用户取消';
      task.endedAt = Date.now();
      task.step = '';
      this.persist();
      this.emitTaskEvent(task);
      return task;
    }
    this.cancellingIds.add(id);
    task.step = '正在取消';
    ChatControlRegistry.requestAbort(task.taskSessionId);
    this.emitTaskEvent(task);
    this.logger.info('Background task cancel requested', { taskId: id });
    return task;
  }

  /** 删除历史任务记录（运行中任务不可删） */
  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'pending' || task.status === 'running') return false;
    this.tasks.delete(id);
    this.persist();
    return true;
  }

  /**
   * 恢复中断/失败/取消的任务：用原 prompt 重新提交一个新任务并执行。
   * 对齐旧版 _pausedTask 断点续传语义——服务重启后生成过程无法跨进程恢复，
   * 但保留的任务上下文（自包含 prompt）允许"重新发起继续执行"：
   * 新任务在独立隔离会话中从 prompt 起点重跑（prompt 自包含，含全部任务要求），
   * 结果照常回流原会话。
   */
  resume(id: string): BackgroundTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.status === 'pending' || task.status === 'running' || task.status === 'completed')
      return task;
    if (!task.prompt) return null;
    const history = this.session?.getMessages(task.taskSessionId) ?? [];
    if ((task.attempts ?? 0) > 0 && !history.length) {
      throw new ConflictException('执行历史不可用，无法安全续接；请核对已有结果后重新提交任务');
    }
    // Complete interrupted tool protocol pairs without replaying their side effects.
    const resolved = new Set(history.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    for (const message of history)
      for (const call of message.toolCalls ?? []) {
        if (resolved.has(call.id)) continue;
        this.session?.addMessage(task.taskSessionId, {
          id: randomUUID(),
          role: 'tool',
          toolCallId: call.id,
          timestamp: Date.now(),
          content:
            '执行因进程中断而结果未知。必须先检查外部状态；不得盲目重复发送、付款、提交或删除等副作用。',
        });
      }
    task.status = 'pending';
    task.error = null;
    task.step = '等待续接';
    delete task.endedAt;
    this.persist();
    this.emitTaskEvent(task);
    this.queue.push(id);
    this.drain();
    return task;
  }

  private drain(): void {
    while (this.active.size < 2 && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.status !== 'pending' || this.active.has(id)) continue;
      this.active.add(id);
      void this.execute(task)
        .catch((error) => {
          task.status = 'failed';
          task.error = String(error);
          task.endedAt = Date.now();
          this.logger.warn('Background task dispatch failed', { taskId: id, error: String(error) });
          this.emitTaskEvent(task);
        })
        .finally(() => {
          this.active.delete(id);
          this.drain();
        });
    }
  }

  /**
   * 后台执行：独立隔离会话驱动完整 AgentLoop harness 循环。
   * 事件消费：
   *   - tool_call → 更新进度描述并推送（前端任务卡实时显示当前步骤）
   *   - assistant_message → 记录最终内容与附件（每轮覆盖，最终为末轮）
   *   - error → cancelling 标记区分取消/失败
   *   - done → 正常完成
   */
  private async execute(task: BackgroundTask): Promise<void> {
    task.status = 'running';
    task.step = '任务启动';
    task.startedAt = Date.now();
    const continuation = (task.attempts ?? 0) > 0;
    task.attempts = (task.attempts ?? 0) + 1;
    this.persist(); // Persist running before the first externally visible side effect.
    this.emitTaskEvent(task);

    let finalContent = '';
    let finalAttachments: Attachment[] | undefined;
    let failure: string | null = null;

    try {
      const loopOptions: {
        model?: string;
        agentId?: string;
      } = {};
      if (task.memoryIdentity && this.memoryPolicy?.credentialIdentity() !== task.memoryIdentity)
        throw new Error('后台任务所属账号或企业身份已切换，请切回原身份后恢复');
      if (task.model) loopOptions.model = task.model;
      if (task.agentId) loopOptions.agentId = task.agentId;

      const prompt = continuation
        ? '继续完成原任务。先核对已完成步骤及结果未知的工具调用，仅执行尚未完成的部分；不要重复已有副作用。原任务：\n' +
          task.prompt
        : task.prompt;
      for await (const event of this.agentLoop.run(task.taskSessionId, prompt, loopOptions)) {
        switch (event.type) {
          case 'assistant_message':
            if (event.message?.phase === 'progress' || event.message?.phase === 'status') break;
            finalContent = event.content || '';
            if (event.attachments && event.attachments.length > 0) {
              finalAttachments = event.attachments;
            }
            break;
          case 'tool_call':
            task.step = `正在执行 ${event.toolName}...`;
            this.persist();
            this.emitTaskEvent(task);
            break;
          case 'error':
            failure = event.error;
            break;
          case 'done':
            break;
          case 'tool_result':
            await this.session?.flush?.();
            this.persist();
            break;
          case 'approval_request':
            break;
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // 状态收尾：cancelling 标记优先（用户主动取消），其次失败，否则完成
    if (this.cancellingIds.has(task.id)) {
      this.cancellingIds.delete(task.id);
      task.status = 'cancelled';
      task.error = '任务已被用户取消';
    } else if (failure) {
      task.status = 'failed';
      task.error = failure;
    } else {
      task.status = 'completed';
      task.result = finalContent;
      task.attachments = finalAttachments ?? [];
    }
    task.step = '';
    task.endedAt = Date.now();
    this.emitTaskEvent(task);
    this.finalize(task);
  }

  /**
   * 收尾回流：结果/失败/取消都以 assistant 消息写回原会话
   * （session.addMessage 持久化 + chat_message 广播），并弹通知。
   * 附件（视频/图片）随消息返回，前端附件渲染链路直接可用。
   */
  private finalize(task: BackgroundTask): void {
    this.persist();
    this.logger.info('Background task finished', {
      taskId: task.id,
      status: task.status,
      durationMs: task.endedAt ? task.endedAt - task.createdAt : undefined,
    });

    let content: string;
    let level: 'info' | 'warn' | 'error';
    if (task.status === 'completed') {
      content =
        `**后台任务「${task.title}」已完成**（${formatDuration(task.createdAt, task.endedAt)}）\n\n` +
        (task.result || '（任务无文本输出）');
      level = 'info';
    } else if (task.status === 'cancelled') {
      content = `后台任务「${task.title}」已取消。`;
      level = 'warn';
    } else {
      content = `**后台任务「${task.title}」失败**：${task.error ?? '未知错误'}`;
      level = 'error';
    }

    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      // 会话归属标记：前端按 sessionId 过滤跨会话事件
      sessionId: task.sessionId,
    };
    if (task.status === 'completed' && task.attachments.length > 0) {
      message.attachments = task.attachments;
    }
    // 持久化到原会话 + 广播（已订阅该会话的前端实时渲染）
    try {
      this.session?.addMessage(task.sessionId, message);
    } catch (err) {
      this.logger.warn('Background task result persist failed', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.ws.broadcastToSession(task.sessionId, { type: 'chat_message', data: message });
    this.ws.broadcast({
      type: 'notification',
      data: {
        title: `后台任务${task.status === 'completed' ? '完成' : task.status === 'cancelled' ? '已取消' : '失败'}`,
        message:
          task.status === 'completed'
            ? `「${task.title}」已完成，结果已发送到会话`
            : `「${task.title}」：${task.error ?? task.status}`,
        level,
        sessionId: task.sessionId,
      },
    });
  }

  /** 推送 background_task 事件到任务归属会话（订阅该会话的前端实时更新任务卡） */
  private emitTaskEvent(task: BackgroundTask): void {
    this.scheduler?.background(task);
    this.ws.broadcastToSession(task.sessionId, {
      type: 'background_task',
      data: {
        taskId: task.id,
        sessionId: task.sessionId,
        title: task.title,
        status: task.status,
        ...(task.step ? { step: task.step } : {}),
        ...(task.result !== null ? { content: task.result.slice(0, 200) } : {}),
        ...(task.error ? { error: task.error.slice(0, 200) } : {}),
        createdAt: task.createdAt,
        ...(task.endedAt ? { endedAt: task.endedAt } : {}),
      },
    });
  }

  // ============================================================
  // 持久化（background-tasks.json，writeLock 串行化写）
  // ============================================================

  private persist(): void {
    if (!this.storePath) return;
    const tasks = this.list();
    const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
    const history = tasks
      .filter((t) => t.status !== 'pending' && t.status !== 'running')
      .slice(0, MAX_PERSISTED_TASKS);
    writeJsonAtomicSync(this.storePath, { tasks: [...active, ...history] });
  }

  private load(): void {
    try {
      const raw = readJsonRecover<{ tasks?: PersistedTask[] }>(this.storePath, {});
      const items = Array.isArray(raw.tasks) ? raw.tasks : [];
      for (const p of items) {
        if (!p || typeof p.id !== 'string' || typeof p.taskSessionId !== 'string') continue;
        // 未完结任务：服务重启导致 AgentLoop 生成中断（无法跨进程恢复），
        // 诚实标记 interrupted 而非静默丢弃——用户可在历史中看到任务未完成
        const status: BackgroundTaskStatus = p.status === 'running' ? 'interrupted' : p.status;
        this.tasks.set(p.id, {
          ...(p.memoryIdentity ? { memoryIdentity: p.memoryIdentity } : {}),
          id: p.id,
          title: p.title || '后台任务',
          prompt: p.prompt || '',
          sessionId: p.sessionId || '',
          taskSessionId: p.taskSessionId,
          status,
          step: status === 'interrupted' ? '' : p.step || '',
          result: p.result ?? null,
          error: status === 'interrupted' ? '服务重启导致任务中断' : (p.error ?? null),
          attachments: p.attachments ?? [],
          attempts: p.attempts ?? (p.status === 'pending' ? 0 : 1),
          ...(p.model ? { model: p.model } : {}),
          ...(p.agentId ? { agentId: p.agentId } : {}),
          createdAt: p.createdAt || Date.now(),
          ...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}),
          ...(p.endedAt !== undefined ? { endedAt: p.endedAt } : {}),
        });
      }
      if (items.length > 0) {
        this.logger.info('Background tasks loaded', { count: items.length });
      }
    } catch (err) {
      this.logger.warn('Background tasks load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 数据目录解析（对齐 session-store：SKYALYTICWING_DATA_DIR 优先，平台默认兜底） */
  private resolveDataFilePath(filename: string): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    const dir =
      envDir && envDir.trim().length > 0
        ? envDir
        : platform() === 'win32'
          ? join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'SkyalyticWing')
          : join(homedir(), '.skyalyticwing');
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      // 目录创建失败时交由 persist 报错兜底
    }
    return join(dir, filename);
  }
}

function formatDuration(start: number, end?: number): string {
  if (!end) return '';
  const sec = Math.max(1, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}分${rem}秒` : `${min}分钟`;
}
