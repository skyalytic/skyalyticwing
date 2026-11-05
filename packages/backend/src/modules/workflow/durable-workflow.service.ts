import { RunJournal } from '../ai/agent/run-journal.js';
import { LocalResourcePolicy } from '../core/security/local-resource-policy.service.js';
import { updateMaintenance } from '../core/system/update-maintenance.js';
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoggerService } from '../core/logger/logger.service.js';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { LLMClientService } from '../ai/llm/llm-client.service.js';
import { AgentService } from '../ai/agent/agent.service.js';
import { AgentSwarmService } from '../ai/agent/agent-swarm.service.js';
import type {
  WorkflowCreateInput,
  WorkflowDef,
  WorkflowRunLog,
  WorkflowStep,
} from './workflow.types.js';

export interface WorkflowMutationResult {
  success: boolean;
  workflow?: WorkflowDef;
  error?: string;
}
export interface WorkflowDeleteResult {
  success: boolean;
  error?: string;
}
export interface WorkflowRunTriggerResult {
  success: boolean;
  run?: WorkflowRunLog;
  error?: string;
}
const DEFAULT_BUDGET = { maxCalls: 100, maxDurationMs: 30 * 60_000 };

/** Durable deterministic DAG executor. Unknown effects after a crash require replay consent. */
@Injectable()
export class WorkflowService implements OnModuleInit, OnModuleDestroy {
  private readonly workflows = new Map<string, WorkflowDef>();
  private readonly runLogs = new Map<string, WorkflowRunLog[]>();
  private readonly controllers = new Map<string, AbortController>();
  private filePath = '';
  constructor(
    private readonly logger: LoggerService,
    private readonly llm: LLMClientService,

    @Optional() private readonly agents?: AgentService,
    @Optional() private readonly swarm?: AgentSwarmService,
    @Optional() private readonly resources?: LocalResourcePolicy,
  ) {}

  onModuleInit(): void {
    this.filePath = join(getDefaultDataDir(), 'workflows.json');
    const data = readJsonRecover<{
      workflows?: Record<string, WorkflowDef>;
      runs?: Record<string, WorkflowRunLog[]>;
    }>(this.filePath, {});
    for (const [id, wf] of Object.entries(data.workflows || {})) {
      if (!wf || !Array.isArray(wf.steps)) throw new Error('工作流存储结构损坏');
      if (wf.lastRunStatus === 'running') wf.lastRunStatus = 'interrupted';
      this.workflows.set(id, wf);
    }
    for (const [id, logs] of Object.entries(data.runs || {})) {
      for (const run of logs)
        if (run.status === 'running') {
          run.status = 'interrupted';
          run.error = '服务重启；已完成步骤保留，执行中的步骤需要确认后重试';
        }
      this.runLogs.set(id, logs);
    }
    this.save();
  }
  onModuleDestroy(): void {
    for (const logs of this.runLogs.values())
      for (const run of logs)
        if (run.status === 'running') {
          run.status = 'interrupted';
          this.abort(run);
          this.syncStatus(run);
        }
    this.save();
  }
  private save(): void {
    if (this.filePath)
      writeJsonAtomicSync(this.filePath, {
        workflows: Object.fromEntries(this.workflows),
        runs: Object.fromEntries(this.runLogs),
      });
  }
  listWorkflows(): WorkflowDef[] {
    return structuredClone([...this.workflows.values()].sort((a, b) => b.createdAt - a.createdAt));
  }
  readWorkflow(id: string): WorkflowDef | null {
    return structuredClone(this.workflows.get(id) || null);
  }
  createWorkflow(input: WorkflowCreateInput): WorkflowMutationResult {
    try {
      const normalized = this.normalize(input);
      const now = Date.now();
      const wf: WorkflowDef = {
        ...normalized,
        id: 'wf-' + randomUUID(),
        createdAt: now,
        updatedAt: now,
        lastRunStatus: null,
      };
      this.workflows.set(wf.id, wf);
      try {
        this.save();
      } catch (e) {
        this.workflows.delete(wf.id);
        throw e;
      }
      return { success: true, workflow: structuredClone(wf) };
    } catch (e) {
      return { success: false, error: this.message(e) };
    }
  }
  updateWorkflow(id: string, patch: Partial<WorkflowCreateInput>): WorkflowMutationResult {
    const old = this.workflows.get(id);
    if (!old) return { success: false, error: '工作流不存在' };
    try {
      const wf = { ...old, ...this.normalize({ ...old, ...patch }), updatedAt: Date.now() };
      this.workflows.set(id, wf);
      try {
        this.save();
      } catch (e) {
        this.workflows.set(id, old);
        throw e;
      }
      return { success: true, workflow: structuredClone(wf) };
    } catch (e) {
      return { success: false, error: this.message(e) };
    }
  }
  deleteWorkflow(id: string): WorkflowDeleteResult {
    const wf = this.workflows.get(id);
    if (!wf) return { success: false, error: '工作流不存在' };
    if (
      (this.runLogs.get(id) || []).some((r) =>
        ['running', 'paused', 'interrupted'].includes(r.status) || this.controllers.has(r.id),
      )
    )
      return { success: false, error: '请先取消尚未结束的运行' };
    const logs = this.runLogs.get(id);
    this.workflows.delete(id);
    this.runLogs.delete(id);
    try {
      this.save();
    } catch (e) {
      this.workflows.set(id, wf);
      if (logs) this.runLogs.set(id, logs);
      return { success: false, error: this.message(e) };
    }
    return { success: true };
  }
  runWorkflow(id: string, opts?: { model?: string }): WorkflowRunTriggerResult {
    const wf = this.workflows.get(id);
    if (!wf) return { success: false, error: '工作流不存在' };
    if (wf.enabled === false) return { success: false, error: '工作流已停用' };
    if (
      (this.runLogs.get(id) || []).some((r) =>
        ['running', 'paused', 'interrupted'].includes(r.status) || this.controllers.has(r.id),
      )
    )
      return { success: false, error: '请先完成或取消已有运行' };
    try {
      this.normalize(wf);
    } catch (e) {
      return { success: false, error: this.message(e) };
    }
    const run: WorkflowRunLog = {
      id: randomUUID(),
      workflowId: id,
      snapshot: structuredClone(wf),
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      stepResults: [],
      approvedSteps: [],
      calls: 0,
      elapsedMs: 0,
      ...(opts?.model ? { model: opts.model } : {}),
    };
    const previous = this.runLogs.get(id) || [];
    this.runLogs.set(id, [...previous.slice(-19), run]);
    const old = { ...wf };
    this.syncStatus(run);
    try {
      this.save();
    } catch (e) {
      this.runLogs.set(id, previous);
      this.workflows.set(id, old);
      return { success: false, error: this.message(e) };
    }
    this.launch(run);
    return { success: true, run: structuredClone(run) };
  }
  getRunLogs(id: string): WorkflowRunLog[] {
    return structuredClone(this.runLogs.get(id) || []);
  }
  control(
    id: string,
    runId: string,
    action: 'cancel' | 'resume' | 'approve',
    confirmReplay = false,
  ): WorkflowRunTriggerResult {
    const run = this.runLogs.get(id)?.find((r) => r.id === runId);
    if (!run) return { success: false, error: '运行不存在' };
    if (action === 'cancel') {
      if (run.status === 'success') return { success: false, error: '运行已完成' };
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      this.abort(run);
      this.syncStatus(run);
      this.save();
    } else {
      if (
        (this.runLogs.get(id) || []).some(
          (other) =>
            other.id !== run.id &&
            (['running', 'paused', 'interrupted'].includes(other.status) ||
              this.controllers.has(other.id)),
        )
      )
        return { success: false, error: '请先完成或取消已有运行' };
      if (!['paused', 'interrupted', 'error', 'cancelled'].includes(run.status))
        return { success: false, error: '当前运行不可恢复' };
      if (this.controllers.has(run.id))
        return { success: false, error: '执行器正在停止，请稍后重试' };
      if (run.activeStepId && !confirmReplay)
        return {
          success: false,
          error: '未完成步骤可能已产生外部操作，请确认重试后提交 confirmReplay=true',
        };
      if (run.status === 'paused' && action !== 'approve')
        return { success: false, error: '请先审核前序产物并批准继续' };
      if (action === 'approve' && (run.status !== 'paused' || !run.reviewStepId))
        return { success: false, error: '当前没有待审批步骤' };
      try {
        this.normalize(run.snapshot);
      } catch (e) {
        return { success: false, error: this.message(e) };
      }
      if (
        run.calls >= (run.snapshot.budget || DEFAULT_BUDGET).maxCalls ||
        run.elapsedMs >= (run.snapshot.budget || DEFAULT_BUDGET).maxDurationMs
      )
        return { success: false, error: '运行预算已耗尽，请调整工作流预算后新建运行' };
      if (run.reviewStepId) run.approvedSteps.push(run.reviewStepId);
      delete run.reviewStepId;
      delete run.error;
      delete run.activeAgentId;
      run.status = 'running';
      run.finishedAt = null;
      this.syncStatus(run);
      this.save();
      this.launch(run);
    }
    return { success: true, run: structuredClone(run) };
  }
  private abort(run: WorkflowRunLog): void {
    this.controllers.get(run.id)?.abort();
    if (run.activeAgentId) this.swarm?.destroyAgent(run.activeAgentId);
  }
  private syncStatus(run: WorkflowRunLog): void {
    const logs = this.runLogs.get(run.workflowId);
    if (logs?.[logs.length - 1]?.id !== run.id) return;
    const wf = this.workflows.get(run.workflowId);
    if (wf) {
      wf.lastRunAt = run.startedAt;
      wf.lastRunStatus = run.status;
    }
  }
  private launch(run: WorkflowRunLog): void {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    void updateMaintenance.run('工作流', () => this.execute(run, controller))
      .catch((e) => {
        run.status = 'error';
        run.error = this.message(e);
        this.syncStatus(run);
        this.logger.error('工作流执行/持久化失败', { runId: run.id });
        try {
          this.save();
        } catch {
          /* Never continue side effects when persistence fails. */
        }
      })
      .finally(() => this.controllers.delete(run.id));
  }
  private async execute(run: WorkflowRunLog, controller: AbortController): Promise<void> {
    const identity=this.resources?.credentialIdentity()??'local';
    const journal=new RunJournal(identity,'workflow-'+run.id,run.snapshot.name);
    const sliceStarted = Date.now();
    const budget = run.snapshot.budget || DEFAULT_BUDGET;
    const timer = setTimeout(
      () => {
        run.error = '达到运行时间预算';
        this.abort(run);
      },
      Math.max(1, budget.maxDurationMs - run.elapsedMs),
    );
    try {
      while (run.status === 'running') {
        if((this.resources?.credentialIdentity()??'local')!==identity)throw new Error('账号或企业身份已切换，工作流已停止');
        if (controller.signal.aborted) throw new Error(run.error || '执行已停止');
        const done = new Set(run.stepResults.filter((r) => r.ok).map((r) => r.stepId));
        if (done.size === run.snapshot.steps.length) {
          run.status = 'success';
          delete run.activeStepId;
          break;
        }
        const step = run.snapshot.steps.find(
          (s, i) =>
            !done.has(s.id) &&
            this.dependencies(run.snapshot.steps, s, i).every((d) => done.has(d)),
        );
        if (!step) throw new Error('依赖无法满足');
        if (step.reviewBefore && !run.approvedSteps.includes(step.id)) {
          run.status = 'paused';
          run.reviewStepId = step.id;
          break;
        }
        if (run.calls >= budget.maxCalls) throw new Error('达到模型调用次数预算');
        const expert = step.agentId ? this.agents?.getAgent(step.agentId) : undefined;
        if (step.agentId && (!expert || expert.callable === false))
          throw new Error('专家不存在或不允许委派');
        const model =
          run.model?.trim() ||
          step.model?.trim() ||
          expert?.model?.trim() ||
          this.llm.getDefaultModel();
        const deps = this.dependencies(run.snapshot.steps, step, run.snapshot.steps.indexOf(step));
        const context = deps
          .map((id) => {
            const result = run.stepResults.find((r) => r.stepId === id && r.ok);
            return `【步骤 ${id} 产物】\n${result?.output || ''}`;
          })
          .join('\n');
        const prompt = context ? `${context}\n【当前任务】\n${step.prompt}` : step.prompt;
        const started = Date.now();
        run.activeStepId = step.id;
        journal.toolStarted(step.id,'workflow-step',{step:step.id,model});
        // Reserve calls before execution so crash recovery cannot reset the allowance.
        const allowance = expert ? Math.min(20, budget.maxCalls - run.calls) : 1;
        run.calls += allowance;
        this.save();
        try {
          let output: string;
          let tokens = 0;
          let calls = 1;
          const workspace = join(getDefaultDataDir(), 'workflow-runs', run.id);
          mkdirSync(workspace, { recursive: true });
          if (expert) {
            if (!this.swarm) throw new Error('专家执行服务不可用');
            const child = this.swarm.createSubAgent('workflow-' + run.id, {
              task: step.name,
              prompt,
              model,
              systemPrompt: expert.systemPrompt,
              tools: expert.tools.length ? expert.tools : undefined,
              inheritTools: true,
              workspace,
              autoDestroy: false,
              maxIterations: allowance,
              allowDelegation: false,
            });
            if (!child.id) throw new Error(child.error || '专家创建失败');
            run.activeAgentId = child.id;
            this.save();
            const result = await this.swarm.executeSync(child.id);
            tokens = result.tokens || 0;
            calls = result.calls ?? allowance;
            run.calls -= allowance - calls;
            if (!result.success) throw new Error(result.error || '专家任务失败');
            output = result.result || '';
          } else {
            const result = await this.llm.chatSync({
              messages: [
                { role: 'system', content: '完成当前工作流步骤，依据前序产物给出实际结果。' },
                { role: 'user', content: prompt },
              ],
              model,
              stream: false,
              signal: controller.signal,
            });
            tokens = result.usage?.totalTokens || 0;
            output = result.content;
            if (result.toolCalls?.length) throw new Error('该步骤需要指定可使用工具的专家');
          }
          if (controller.signal.aborted) throw new Error(run.error || '执行已停止');
          if (!output.trim()) throw new Error('步骤没有产生有效输出');
          writeFileSync(
            join(workspace, `step-${run.snapshot.steps.indexOf(step) + 1}.txt`),
            output,
            'utf8',
          );
          run.stepResults.push({
            stepId: step.id,
            ok: true,
            output,
            durationMs: Date.now() - started,
            model,
            calls,
            tokens,
            workspace,
            ...(expert ? { agentId: expert.id, agentName: expert.name } : {}),
          });
          journal.toolFinished(step.id,{success:true,output});
          delete run.activeStepId;
        } catch (e) {
          run.stepResults.push({
            stepId: step.id,
            ok: false,
            output: '',
            durationMs: Date.now() - started,
            error: this.message(e),
            model,
            ...(expert ? { agentId: expert.id, agentName: expert.name } : {}),
          });
          throw e;
        } finally {
          if (run.activeAgentId) this.swarm?.destroyAgent(run.activeAgentId);
          delete run.activeAgentId;
          this.save();
        }
      }
    } catch (e) {
      if (run.status === 'running') run.status = 'error';
      run.error = this.message(e);
    } finally {
      try{journal.finish(controller.signal.aborted?'cancelled':run.status==='success'?'completed':run.status==='paused'?'paused':'failed');}catch(error){this.logger.error('Could not finish workflow journal',{error:String(error)});}
      clearTimeout(timer);
      run.elapsedMs += Date.now() - sliceStarted;
      run.finishedAt = run.status === 'paused' ? null : Date.now();
      this.syncStatus(run);
      this.save();
    }
  }
  private dependencies(steps: WorkflowStep[], step: WorkflowStep, index: number): string[] {
    return step.dependsOn ?? (index > 0 ? [steps[index - 1]!.id] : []);
  }
  private normalize(input: WorkflowCreateInput): WorkflowCreateInput {
    if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 200)
      throw new Error('工作流名称不能为空且不超过 200 字');
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 50)
      throw new Error('工作流需要 1–50 个步骤');
    const steps: WorkflowStep[] = input.steps.map((s, i) => {
      if (!s || typeof s.prompt !== 'string' || !s.prompt.trim() || s.prompt.length > 50000)
        throw new Error('每步必须有有效提示词（最多 50000 字）');
      const id = s.id || randomUUID();
      if (typeof id !== 'string' || id.length > 100) throw new Error('步骤 ID 无效');
      if (
        s.dependsOn !== undefined &&
        (!Array.isArray(s.dependsOn) || s.dependsOn.some((d) => typeof d !== 'string'))
      )
        throw new Error('步骤依赖无效');
      if (s.agentId) {
        const agent = this.agents?.getAgent(s.agentId);
        if (!agent || agent.callable === false) throw new Error('专家不存在或不允许委派');
        if (input.teamId && !this.agents?.getTeam(input.teamId).memberIds.includes(s.agentId))
          throw new Error('专家不属于所选团队');
      }
      return {
        id,
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `步骤 ${i + 1}`,
        prompt: s.prompt,
        ...(s.model ? { model: String(s.model) } : {}),
        ...(s.agentId ? { agentId: s.agentId } : {}),
        ...(s.dependsOn !== undefined ? { dependsOn: [...new Set(s.dependsOn)] } : {}),
        ...(s.reviewBefore ? { reviewBefore: true } : {}),
      };
    });
    if (new Set(steps.map((s) => s.id)).size !== steps.length) throw new Error('步骤 ID 重复');
    const visited = new Set<string>();
    while (visited.size < steps.length) {
      const ready = steps.find(
        (s, i) => !visited.has(s.id) && this.dependencies(steps, s, i).every((d) => visited.has(d)),
      );
      if (!ready) throw new Error('步骤依赖包含循环或不存在的步骤');
      visited.add(ready.id);
    }
    const budget = input.budget || DEFAULT_BUDGET;
    if (
      !Number.isInteger(budget.maxCalls) ||
      budget.maxCalls < 1 ||
      budget.maxCalls > 1000 ||
      !Number.isInteger(budget.maxDurationMs) ||
      budget.maxDurationMs < 1000 ||
      budget.maxDurationMs > 86400000
    )
      throw new Error('预算范围：1–1000 次调用、1 秒–24 小时');
    if (input.teamId) {
      if (!this.agents) throw new Error('团队服务不可用');
      this.agents.getTeam(input.teamId);
    }
    return {
      name: input.name.trim(),
      description: input.description || '',
      steps,
      enabled: input.enabled !== false,
      budget: { ...budget },
      teamId: input.teamId || '',
    };
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
