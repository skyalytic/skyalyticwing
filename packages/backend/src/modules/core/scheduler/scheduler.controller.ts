import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { SchedulerService } from './scheduler.service.js';
import { RevisionConflict } from './scheduler-store.js';

const ruleSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    source: z.enum(['channel', 'interval', 'task']),
    mode: z.enum(['off', 'observe', 'auto']),
    channel: z.string().max(100).default(''),
    peer: z.string().max(500).default(''),
    contains: z.string().max(1000).default(''),
    prompt: z.string().max(20000).default(''),
    agentId: z.string().max(100).default(''),
    intervalMinutes: z.number().int().min(1).max(525600).default(60),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (r) => r.source === 'channel' || r.mode === 'off' || r.prompt.trim(),
    'Task instruction required',
  );
const promptSchema = z
  .object({
    text: z.string().max(100000),
    expectedRevision: z.number().int().positive(),
    merge: z.boolean().optional(),
  })
  .strict();
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

@Controller('scheduler')
export class SchedulerController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly modules: ModuleRef,
  ) {}
  @Get('attention') attention() {
    return { count: this.scheduler.store().attentionCount() };
  }
  @Get() async snapshot() {
    const { AskUserService } = await import('../../tools/executor/ask-user.service.js');
    const { ApprovalService } = await import('../../tools/executor/approval.service.js');
    const snapshot = this.scheduler.snapshot();
    const sessions = new Set(snapshot.tasks.map((t) => t.sessionId));
    return {
      ...snapshot,
      questions: this.modules
        .get(AskUserService, { strict: false })
        .listPending()
        .filter((q) => q.sessionId && sessions.has(q.sessionId)),
      approvals: this.modules
        .get(ApprovalService, { strict: false })
        .getPendingApprovals()
        .filter((q) => q.sessionId && sessions.has(q.sessionId)),
    };
  }
  @Post('notices/read') read() {
    this.scheduler.store().change((d) => {
      for (const notice of d.notices) notice.read = true;
    });
    return { success: true };
  }
  @Post('rules') saveRule(@Body() body: unknown) {
    const { expectedRevision, ...rule } = parse(ruleSchema, body);
    try {
      return this.scheduler.saveRule(rule as Required<typeof rule>, expectedRevision);
    } catch (error) {
      this.rethrow(error);
    }
  }
  @Post('deliveries/:id/:action') delivery(
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    const { confirmed } = parse(z.object({ confirmed: z.boolean().default(false) }).strict(), body);
    if (!['retry', 'sent', 'cancel'].includes(action))
      throw new BadRequestException('Invalid action');
    try {
      this.scheduler.settleDelivery(id, action as 'retry' | 'sent' | 'cancel', confirmed);
      return { success: true };
    } catch (error) {
      this.rethrow(error);
    }
  }
  @Post('tasks/:id/:action') async task(
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    const { confirmReplay } = parse(
      z.object({ confirmReplay: z.boolean().default(false) }).strict(),
      body,
    );
    const task = this.scheduler.store().snapshot().tasks[id];
    if (!task) throw new BadRequestException('Task not found');
    if (!['cancel', 'resume', 'approve'].includes(action))
      throw new BadRequestException('Invalid action');
    if (action !== 'cancel' && task.mandate && !this.scheduler.store().permitted(task.mandate))
      throw new ConflictException('Task rule was changed or disabled');
    if (task.kind === 'workflow') {
      const { WorkflowService } = await import('../../workflow/workflow.service.js');
      const result = this.modules
        .get(WorkflowService, { strict: false })
        .control(
          task.sourceId,
          task.sessionId,
          action as 'cancel' | 'resume' | 'approve',
          confirmReplay,
        );
      if (!result.success) throw new ConflictException(result.error);
      return result;
    }
    if (task.kind === 'background' || task.kind === 'automation') {
      const { BackgroundTaskService } =
        await import('../../ai/background/background-task.service.js');
      const background = this.modules.get(BackgroundTaskService, { strict: false });
      if (action === 'cancel') return background.cancel(task.sourceId);
      if (action === 'resume') return background.resume(task.sourceId);
    }
    if (task.kind === 'chat' && action === 'cancel') {
      const { ChatControlRegistry } = await import('../../ai/chat/chat-control.registry.js');
      ChatControlRegistry.requestAbort(task.sessionId);
      return { success: true };
    }
    throw new BadRequestException('Continue in the original conversation');
  }
  private async agents() {
    const { AgentService } = await import('../../ai/agent/agent.service.js');
    return this.modules.get(AgentService, { strict: false });
  }
  @Get('prompts') async prompts() {
    return (await this.agents()).listAgents().map((a) => ({ id: a.id, name: a.name }));
  }
  @Get('prompts/:id') async prompt(
    @Param('id') id: string,
    @Query('sessionId') sessionId = '',
    @Query('compare') compare = '',
  ) {
    const agent = (await this.agents()).getAgent(id);
    const document = this.scheduler.store().prompt(id, agent.systemPrompt);
    const { AgentLoopService } = await import('../../ai/agent/agent-loop.service.js');
    const effective = await this.modules
      .get(AgentLoopService, { strict: false })
      .previewSystemPrompt(sessionId, id);
    const current = document.revisions.at(-1)!;
    const previous =
      (compare
        ? document.revisions.find((r) => r.revision === Number(compare))
        : document.revisions.at(-2)) ?? current;
    return {
      ...document,
      effective,
      diff: createTwoFilesPatch(
        'v' + previous.revision,
        'v' + current.revision,
        previous.text,
        current.text,
      ),
    };
  }
  @Post('prompts/:id') async savePrompt(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(promptSchema, body);
    const agent = (await this.agents()).getAgent(id);
    this.scheduler.store().prompt(id, agent.systemPrompt);
    try {
      return input.merge
        ? this.scheduler.store().resolveTemplate(id, input.text, input.expectedRevision)
        : this.scheduler.store().savePrompt(id, input.text, input.expectedRevision);
    } catch (error) {
      this.rethrow(error);
    }
  }
  private rethrow(error: unknown): never {
    if (error instanceof RevisionConflict) throw new ConflictException(error.message);
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
}
