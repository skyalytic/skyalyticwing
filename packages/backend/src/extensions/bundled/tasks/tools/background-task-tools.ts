import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { BackgroundTaskService } from '../../../../modules/ai/background/background-task.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

/** background_task_submit 工具参数 */
interface BackgroundTaskSubmitArgs {
  /** 后台执行的完整自包含指令 */
  prompt: string;
  /** 任务标题（展示用） */
  title?: string;
  /** 指定模型（可选） */
  model?: string;
}

/**
 * 后台任务域工具：background_task_submit。
 *
 * 超长任务（预计超过 10 分钟：批量生成视频/图片、长时间资料整理与报告撰写等）
 * 提交后台执行——立即返回任务 ID，本对话轮次即刻结束；任务在独立隔离会话中
 * 由完整 AgentLoop harness 驱动执行，完成后结果自动回流当前会话并通知用户。
 *
 * prompt 必须自包含：后台 AI 看不到当前对话历史，任务指令需包含全部背景、
 * 目标、验收标准与产物要求（如视频的主题/风格/时长/数量、图片的构图/风格等）。
 */
export function createBackgroundTaskTools(resolve: ServiceResolver): ToolDefinition[] {
  /** BackgroundTaskService 懒解析（工具域与 BackgroundTaskModule 存在反向依赖） */
  let serviceCache: BackgroundTaskService | undefined;
  let serviceResolved = false;
  const getService = (): BackgroundTaskService | undefined => {
    if (!serviceResolved) {
      try {
        serviceCache = resolve(BackgroundTaskService);
        serviceResolved = true;
      } catch {
        serviceCache = undefined;
      }
    }
    return serviceCache;
  };

  const submitTool: ToolDefinition = {
    name: 'background_task_submit',
    description:
      '提交超长后台任务（后台异步执行，不阻塞当前对话）。当任务预计耗时超过10分钟时使用：如批量生成多个视频（每个15秒视频约需7-8分钟）、批量生成大量图片、长时间资料搜集整理与长报告撰写等。\n' +
      '提交后立即返回任务ID，你应随即告知用户"任务已转后台执行，完成后结果会自动出现在对话中"。\n' +
      '关键要求：prompt 必须完整自包含（后台AI看不到当前对话历史），需写明任务全部背景、目标、分步指令、验收标准与产物要求（例如生成视频时的主题/画风/时长/分辨率/数量、生成后是否需要拼接等）。\n' +
      '任务进度实时推送，用户可随时取消；完成后结果（含视频/图片附件）自动回流当前会话并弹通知。',
    category: 'automation',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '后台执行的完整任务指令（必须自包含：背景/目标/步骤/验收标准/产物要求，后台AI看不到当前对话）',
        },
        title: { type: 'string', description: '任务标题（简短，用于展示），默认"后台任务"' },
        model: { type: 'string', description: '指定执行模型（可选，默认跟随全局默认模型）' },
      },
      required: ['prompt'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as BackgroundTaskSubmitArgs;
      if (!a || typeof a.prompt !== 'string' || a.prompt.trim().length === 0) {
        return {
          success: false,
          error: 'Parameter "prompt" is required and must be a non-empty string',
        };
      }
      const service = getService();
      if (!service) {
        return { success: false, error: '后台任务服务不可用（BackgroundTaskModule 未加载）' };
      }
      try {
        const task = service.submit({
          sessionId: ctx.sessionId,
          prompt: a.prompt,
          ...(typeof a.title === 'string' && a.title.trim() ? { title: a.title.trim() } : {}),
          ...(typeof a.model === 'string' && a.model ? { model: a.model } : {}),
        });
        return {
          success: true,
          output: `后台任务已提交: ${task.id}「${task.title}」，立即告知用户任务已转后台执行，完成后结果自动回流本会话`,
          data: { taskId: task.id, title: task.title, status: task.status },
        };
      } catch (err) {
        return {
          success: false,
          error: `后台任务提交失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };

  return [submitTool];
}
