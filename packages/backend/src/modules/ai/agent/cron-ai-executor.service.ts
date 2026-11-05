import { ChatControlRegistry } from '../chat/chat-control.registry.js';
import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { visualObservation } from './visual-observation.js';
import { TaskVerification, TASK_VERIFY, VERIFICATION_PROMPT } from './task-verification.js';
import type { ToolResult } from '@skyalyticwing/shared';
import {
  CronService,
  type InternalCronJob,
  type LongRunningPatch,
} from '../../channels/cron/cron.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import { resolveEffectiveWorkspace } from '../../core/config/effective-workspace.util.js';
import { LLMClientService } from '../llm/llm-client.service.js';
import {
  TOOL_EXECUTOR_SERVICE,
  type IToolExecutorService,
  type LlmMessage,
} from '../types.js';

/**
 * CronAiExecutorService - 定时任务 AI 执行器（长期任务 7×24 自动执行核心）
 *
 * 此前 taskType='ai' 的定时任务创建后执行时无处理器（No handler registered 被跳过）。
 * 本服务在启动时向 CronService 注册全局 'ai' 处理器，打通 AI 任务执行链路：
 *
 *   1. 长期任务上下文注入：总目标 + 当前进度 + 最近执行历史（每轮告知 AI 之前做了什么）
 *   2. 工具循环执行：LLMClientService.chatSync + ToolExecutorService（无人值守模式，
 *      ask 审批的工具直接拒绝并告知 AI 换路，不阻塞流程）
 *   3. 跨轮次线程：每个任务保留独立对话历史（内存环形），重启后由进度摘要重建
 *   4. 续排协议解析：AI 每轮末尾输出 [STATUS]/[PROGRESS]/[NEXT]/[SCHEDULE] 标记，
 *      本服务解析后提交 CronService.applyLongRunningUpdate 完成收尾/改期/进度推进
 *
 * 协议示例（AI 回复末尾）：
 *   [STATUS: running]
 *   [PROGRESS: 已完成 3/10 个文件的分析]
 *   [NEXT: continue]
 */

/** 单轮最大工具迭代次数 */

/** 跨轮线程保留的最大消息条数（环形截断） */
const MAX_THREAD_MESSAGES = 60;
/** 工具结果注入上下文的最大字符数（对齐子代理） */
const TOOL_RESULT_MAX_CHARS = 2000;
/** 连续 blocked 自动暂停阈值（防止无人值守死循环空转） */
const MAX_CONSECUTIVE_BLOCKED = 3;

@Injectable()
export class CronAiExecutorService implements OnModuleInit {
  /** 长期任务线程：jobId → 最近对话（跨轮次上下文；内存态） */
  private readonly jobThreads = new Map<string, LlmMessage[]>();
  /** 连续 blocked 计数：jobId → 次数 */
  private readonly blockedCounts = new Map<string, number>();

  constructor(
    private readonly logger: LoggerService,
    private readonly llm: LLMClientService,
    private readonly cron: CronService,
    @Optional() @Inject(TOOL_EXECUTOR_SERVICE) private readonly toolExecutor?: IToolExecutorService,
  ) {}

  /** 启动时向 CronService 注册全局 'ai' 处理器（打通 AI 定时任务执行链路） */
  onModuleInit(): void {
    const r = this.cron.registerGlobalHandler('ai', (job, target) =>
      this.executeAiJob(job, target),
    );
    if (r.success) {
      this.logger.info('[cron-ai] AI 任务执行器已就绪（长期任务 7×24 执行链路已接线）');
    } else {
      this.logger.warn('[cron-ai] AI 任务执行器注册失败: ' + (r.error || ''));
    }
  }

  /**
   * 执行一个 AI 定时任务（CronService 全局处理器入口）
   * 返回最终文本（由 executeJob 记录摘要并走 delivery 投递）
   */
  async executeAiJob(job: InternalCronJob, _target: string): Promise<string> {
    const jobId = job.id;
    const instruction = (job.prompt || job.command || '').trim();
    if (!instruction) {
      throw new Error('AI 任务缺少执行指令（prompt/command 均为空）');
    }

    // ── 1. 组装长期任务上下文 + 本轮指令 ──
    const lr = job.longRunning;
    const round = (lr?.round || 0) + 1;
    const goal = (lr?.goal || instruction).trim();
    const userPrompt = buildUserPrompt(job, goal, instruction, round);

    // ── 2. 线程消息：跨轮历史 + 本轮指令 ──
    const thread = this.jobThreads.get(jobId) || [];
    thread.push({ role: 'user', content: userPrompt });
    if (thread.length > MAX_THREAD_MESSAGES) {
      thread.splice(0, thread.length - MAX_THREAD_MESSAGES);
    }

    // ── 3. 工具循环 ──
    const model = job.model && job.model !== 'inherit' ? job.model : this.llm.getDefaultModel();
    const verification = new TaskVerification(instruction, resolveEffectiveWorkspace());
    const tools = verification.tools(this.getToolDefinitions());
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(job) + '\n' + VERIFICATION_PROMPT },
      ...thread,
    ];

    let output = '';
    let iterError = '';
    let completed = false;
    let previousObservation: LlmMessage | undefined;
    const loopAbort = new AbortController();
    const unsubscribeAbort = ChatControlRegistry.onAbort(id => { if (!id || id === 'cron-ai-' + jobId) loopAbort.abort(); });
    try {
      for (;;) {
        if (loopAbort.signal.aborted) throw new Error('任务已由用户停止');
        const chatParams: Parameters<LLMClientService['chatSync']>[0] = {
          messages,
          signal: loopAbort.signal,
          model,
          stream: false,
        };
        if (tools && tools.length > 0) chatParams.tools = tools;

        const result = await this.llm.chatSync(chatParams);

        if (result.toolCalls && result.toolCalls.length > 0) {
          const assistantContent = result.content || '';
          if (assistantContent) output = assistantContent;
          messages.push({
            role: 'assistant',
            content: assistantContent,
            ...(result.reasoningContent !== undefined ? { reasoningContent: result.reasoningContent } : {}),
            toolCalls: result.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          let observation: LlmMessage | undefined;
          for (const tc of result.toolCalls) {
            if (loopAbort.signal.aborted) throw new Error('任务已由用户停止');
            let toolResult: ToolResult;
            if (tc.name === TASK_VERIFY) {
              try { toolResult = verification.submit(JSON.parse(tc.arguments)); }
              catch { toolResult = {success: false, error: '验收参数必须是有效 JSON'}; }
            } else {
              toolResult = await this.executeTool(tc.name, tc.arguments, jobId, model, message => { observation = message; }, loopAbort.signal);
              verification.record(tc.id, tc.name, tc.arguments, toolResult);
            }
            messages.push({
              role: 'tool',
              content: JSON.stringify(toolResult).substring(0, TOOL_RESULT_MAX_CHARS),
              toolCallId: tc.id,
            });
          }
          if (observation) {
            if (previousObservation) { const index = messages.indexOf(previousObservation); if (index >= 0) messages.splice(index, 1); }
            previousObservation = observation; messages.push(observation);
          }
          // 上下文过长时截断（保留 system 之后最近一段）
          if (messages.length > MAX_THREAD_MESSAGES + 20) {
            const excess = messages.length - MAX_THREAD_MESSAGES;
            messages.splice(1, excess);
            while (messages[1]?.role === 'tool') messages.splice(1, 1);
          }
          continue;
        }

        if (verification.continueIfNeeded(messages, result.content)) continue;
        output = verification.finalText(result.content || '');
        if (verification.blocked) output += '\n[STATUS: blocked]\n[NEXT: continue]';
        completed = true;
        break;
      }
    } catch (err) {
      iterError = err instanceof Error ? err.message : String(err);
      this.logger.warn('[cron-ai] 任务 ' + job.name + ' 执行异常: ' + iterError);
    }
    unsubscribeAbort();
    if (!iterError && !completed) iterError = '任务尚未完成';
    if (!iterError && !output.trim()) iterError = '模型返回空结果，本轮未完成';

    // 本轮对话写回线程（跨轮上下文）
    if (output) {
      thread.push({ role: 'assistant', content: output.substring(0, 8000) });
      if (thread.length > MAX_THREAD_MESSAGES) {
        thread.splice(0, thread.length - MAX_THREAD_MESSAGES);
      }
    }
    this.jobThreads.set(jobId, thread);

    // ── 4. 解析续排协议并提交状态 ──
    if (iterError) {
      // 执行失败：记录失败历史（不推进进度），抛出让 executeJob 走重试/告警
      this.cron.applyLongRunningUpdate(jobId, {
        error: true,
        summary: '执行异常: ' + iterError.substring(0, 300),
      });
      throw new Error(iterError);
    }

    const { patch, cleanText } = parseProtocol(output, job);
    this.cron.applyLongRunningUpdate(jobId, patch);

    // blocked 连续计数与自动暂停
    if (patch.status === 'blocked') {
      const n = (this.blockedCounts.get(jobId) || 0) + 1;
      this.blockedCounts.set(jobId, n);
      if (n >= MAX_CONSECUTIVE_BLOCKED) {
        this.logger.warn(
          '[cron-ai] 任务 ' + job.name + ' 连续 ' + n + ' 轮 blocked，自动暂停（需人工介入后手动启用）',
        );
        this.cron.applyLongRunningUpdate(jobId, {
          finish: true,
          summary: '连续 ' + n + ' 轮受阻自动暂停',
        });
        this.blockedCounts.delete(jobId);
      }
    } else {
      this.blockedCounts.delete(jobId);
    }

    this.logger.info(
      '[cron-ai] 任务 ' + job.name + ' 第 ' + round + ' 轮完成: status=' + (patch.status || 'running'),
    );
    return cleanText || output;
  }

  /** 获取工具清单（无人值守场景禁用交互式工具） */
  private getToolDefinitions(): ReturnType<IToolExecutorService['getToolDefinitions']> | undefined {
    if (!this.toolExecutor) return undefined;
    try {
      return this.toolExecutor
        .getToolDefinitions()
        .filter((t) => t.name !== 'ask_user');
    } catch {
      return undefined;
    }
  }

  /**
   * 无人值守工具执行：审批类工具（ask 模式返回 approvalRequired）直接转为错误说明，
   * 让 AI 下轮换路，绝不阻塞等待（没有人会点批准）
   */
  private async executeTool(
    toolName: string,
    rawArgs: string,
    jobId: string,
    model = '',
    observe?: (message: LlmMessage) => void,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
    } catch {
      return { success: false, error: '工具参数必须是有效 JSON 对象，本次未执行' };
    }
    if (!this.toolExecutor) {
      return { success: false, error: 'Tool executor not available' };
    }
    try {
      const ctx = {
        sessionId: 'cron-ai-' + jobId,
        ...(signal ? {signal} : {}),
        workspace: resolveEffectiveWorkspace(),
        config: {},
        log: (level: string, msg: string) =>
          this.logger.debug(`[cron-ai-tool:${level}] ${msg}`),
        broadcast: (event: string) =>
          this.logger.debug(`[cron-ai-tool broadcast] ${event}`),
      };
      const raw = await this.toolExecutor.execute(toolName, args, ctx);
      const provider = this.llm.resolveProviderForModel?.(model);
      const observation = visualObservation(raw, provider?.model || model, provider?.id || '');
      if (observation.message) observe?.(observation.message);
      const result = observation.result as typeof raw;
      if (result && result.approvalRequired) {
        return { success: false, blocked: true,
          error:
            '工具 ' + toolName + ' 需要用户审批，本次未执行。请报告 blocked 并等待授权，不得绕过审批。',
        };
      }
      return result ?? { success: false, error: '工具没有返回执行结果' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

// ============================================================
// Prompt 构建
// ============================================================

/** 系统提示：定时任务执行者身份 + 续排协议说明 */
function buildSystemPrompt(job: InternalCronJob): string {
  const maxRounds = job.longRunning?.maxRounds || 0;
  return (
    '你是一个定时任务的无人值守执行者（7×24 自动运行）。\n' +
    '要求：\n' +
    '1. 高效完成本轮指令，需要外部信息/文件/桌面操作时直接调用工具\n' +
    '2. 需要审批时报告 blocked 并等待授权，不得换工具绕过审批\n' +
    '3. 回复务必精炼：先给本轮工作摘要（3-6 行），再在最后输出协议标记\n' +
    '\n' +
    '【续排协议】（回复末尾必须输出，每行一个）\n' +
    '[STATUS: running|done|blocked]  ← running=任务进行中；done=总目标已达成；blocked=受阻需人介入\n' +
    '[PROGRESS: 一句话进度摘要]      ← 汇报总体进度（下一轮会注入给你）\n' +
    '[NEXT: continue|adjust|finish]  ← continue=按当前计划继续；adjust=需要调整执行计划；finish=收尾\n' +
    '[SCHEDULE: <计划>]              ← 仅 NEXT=adjust 时输出：cron 表达式（如 0 9 * * *）或间隔（如 30min、2h）\n' +
    '\n' +
    (maxRounds > 0
      ? '本任务最大轮次为 ' + maxRounds + '，达到后自动收尾，请合理规划每轮工作量。\n'
      : '') +
    '示例：\n[STATUS: running]\n[PROGRESS: 已扫描 40% 商品链接，发现 3 个异常价格]\n[NEXT: continue]'
  );
}

/** 用户提示：长期任务上下文（目标/进度/历史）+ 本轮指令 */
function buildUserPrompt(
  job: InternalCronJob,
  goal: string,
  instruction: string,
  round: number,
): string {
  const lr = job.longRunning;
  const lines: string[] = [];
  if (lr) {
    lines.push('【长期任务 第 ' + round + ' 轮】');
    lines.push('总目标: ' + goal);
    if (lr.progress) lines.push('当前进度: ' + lr.progress);
    const history = (lr.history || []).slice(-10);
    if (history.length > 0) {
      lines.push('最近执行记录:');
      for (const h of history) {
        const t = new Date(h.at).toLocaleString('zh-CN');
        lines.push('- [' + t + '] (' + (h.status || h.outcome) + ') ' + h.summary);
      }
    }
  } else {
    lines.push('【定时 AI 任务】');
  }
  lines.push('');
  lines.push('本轮指令:');
  lines.push(instruction);
  return lines.join('\n');
}

// ============================================================
// 续排协议解析
// ============================================================

/** 从 AI 输出解析 [STATUS]/[PROGRESS]/[NEXT]/[SCHEDULE] 标记 */
export function parseProtocol(
  text: string,
  job: InternalCronJob,
): { patch: LongRunningPatch; cleanText: string } {
  const patch: LongRunningPatch = { summary: firstMeaningfulLine(text) };
  const statusM = text.match(/\[STATUS:\s*(running|done|blocked)\s*\]/i);
  const progressM = text.match(/\[PROGRESS:\s*([^\]]*)\]/i);
  const nextM = text.match(/\[NEXT:\s*(continue|adjust|finish)\s*\]/i);
  const scheduleM = text.match(/\[SCHEDULE:\s*([^\]]+)\]/i);

  if (statusM) patch.status = statusM[1] as 'running' | 'done' | 'blocked';
  if (progressM && progressM[1]?.trim()) patch.progress = progressM[1]!.trim();
  if (nextM && nextM[1] === 'finish') patch.finish = true;
  if (nextM && nextM[1] === 'adjust' && scheduleM) {
    const raw = (scheduleM[1] || '').trim();
    const every = parseEveryMinutes(raw);
    if (every > 0) {
      patch.reschedule = { everyMinutes: every };
    } else {
      patch.reschedule = { expression: raw };
    }
  }

  // 长期任务但未输出协议标记：缺省按 running 继续（宽容处理）
  if (job.longRunning && !statusM && !nextM) {
    patch.status = 'running';
  }

  // 清理协议标记行后作为投递文本
  const cleanText = text
    .replace(/^\s*\[(STATUS|PROGRESS|NEXT|SCHEDULE):\s*[^\]]*\]\s*$/gim, '')
    .trim();

  return { patch, cleanText };
}

/** 解析 "30min" / "2h" / "90s" 形式的间隔为分钟（非间隔形式返回 0） */
function parseEveryMinutes(raw: string): number {
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]!);
  const unit = (m[2] || '').toLowerCase();
  if (['s', 'sec', 'secs'].includes(unit)) return Math.max(v / 60, 1);
  if (['h', 'hr', 'hrs'].includes(unit)) return v * 60;
  return v; // m/min/mins
}

/** 取首个有意义的文本行作为摘要 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !/^\[(STATUS|PROGRESS|NEXT|SCHEDULE):/i.test(t)) {
      return t.substring(0, 300);
    }
  }
  return '';
}
