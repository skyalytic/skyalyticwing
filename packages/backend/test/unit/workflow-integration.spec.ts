import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowService } from '../../src/modules/workflow/workflow.service';
import { WorkflowController } from '../../src/modules/workflow/workflow.controller';
import { AgentSwarmService } from '../../src/modules/ai/agent/agent-swarm.service';

// Real HTTP controller, durable workflow and queued expert executor; only provider
// responses and the tool registry are controlled. File operations are real and isolated.
describe('workflow HTTP → expert → artifact integration', () => {
  let root: string, app: INestApplication, workflows: WorkflowService, swarm: AgentSwarmService;
  const previous = process.env['SKYALYTICWING_DATA_DIR'];
  const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
  const llm = { getDefaultModel: () => 'local-test', chatSync: jest.fn() };
  const agents = {
    getAgent: () => ({
      id: 'writer',
      name: 'Writer',
      model: 'local-test',
      systemPrompt: 'Write a report',
      tools: ['write_file', 'read_file'],
      callable: true,
    }),
  };
  const tools = {
    getToolDefinitions: () => ['write_file','read_file'].map(name=>({ name, description: name, parameters: {} })),
    execute: jest.fn(async (_name: string, args: { text: string }, ctx: { workspace: string }) => {
      expect(existsSync(ctx.workspace)).toBe(true);
      if (_name === 'read_file') return {success: true, output: readFileSync(join(ctx.workspace,'report.txt'),'utf8')};
      writeFileSync(join(ctx.workspace, 'report.txt'), args.text);
      return { success: true, output: 'x'.repeat(3000) + 'FILE-WRITTEN-END' };
    }),
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    llm.chatSync.mockReset();
    root = mkdtempSync(join(tmpdir(), 'wing-workflow-integration-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    swarm = new AgentSwarmService(
      logger as never,
      { broadcast: jest.fn() } as never,
      llm as never,
      tools as never,
    );
    swarm.onModuleInit();
    workflows = new WorkflowService(
      logger as never,
      llm as never,
      agents as never,
      swarm,
    );
    const module = await Test.createTestingModule({
      controllers: [WorkflowController],
      providers: [{ provide: WorkflowService, useValue: workflows }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + sep) ||
      !root.includes('wing-workflow-integration-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  });
  async function waitStatus(id: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const response = await request(app.getHttpServer()).get(`/api/workflow/${id}/logs`);
      const run = response.body.data.at(-1);
      if (run.status === status) return run;
      if (run.status === 'error' && status !== 'error') throw Error(run.error);
      await new Promise((done) => setTimeout(done, 10));
    }
    throw Error('Workflow did not reach ' + status);
  }
  it('writes through the real expert, preserves tool output, pauses, approves and passes artifacts forward', async () => {
    llm.chatSync
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'write',
            name: 'write_file',
            arguments: JSON.stringify({ text: 'Integration report' }),
          },
        ],
      })
      .mockImplementationOnce(async (params) => {
        expect(params.messages.find((m: any) => m.role === 'tool').content).toContain(
          'FILE-WRITTEN-END',
        );
        return {content:'',toolCalls:[{id:'readback',name:'read_file',arguments:'{}'}]};
      })
      .mockResolvedValueOnce({content:'',toolCalls:[{id:'verify',name:'task_verify',arguments:JSON.stringify({checks:[{requirement:'Report saved',status:'passed',evidence:['readback'],detail:'Read report.txt and confirmed Integration report'}]})}]})
      .mockResolvedValueOnce({content:'Expert report complete',usage:{totalTokens:17}})
      .mockImplementationOnce(async (params) => {
        expect(params.messages[1].content).toContain('Expert report complete');
        return { content: 'Review approved' };
      });
    const created = await request(app.getHttpServer())
      .post('/api/workflow')
      .send({
        name: 'review report',
        steps: [
          { id: 'draft', name: 'Draft', prompt: 'write report', agentId: 'writer' },
          { id: 'review', name: 'Review', prompt: 'review draft', reviewBefore: true },
        ],
        budget: { maxCalls: 5, maxDurationMs: 10000 },
      });
    expect(created.body.success).toBe(true);
    const id = created.body.data.id;
    await request(app.getHttpServer()).post(`/api/workflow/${id}/run`).send({});
    const paused = await waitStatus(id, 'paused');
    expect(paused.calls).toBe(4);
    expect(readFileSync(join(root, 'workflow-runs', paused.id, 'report.txt'), 'utf8')).toBe(
      'Integration report',
    );
    const duplicate = await request(app.getHttpServer()).post(`/api/workflow/${id}/run`).send({});
    expect(duplicate.body.success).toBe(false);
    const approve = await request(app.getHttpServer())
      .post(`/api/workflow/${id}/runs/${paused.id}/approve`)
      .send({});
    expect(approve.body.success).toBe(true);
    const finished = await waitStatus(id, 'success');
    expect(finished.calls).toBe(5);
    expect(tools.execute).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'workflow-runs', finished.id, 'step-2.txt'), 'utf8')).toBe(
      'Review approved',
    );
    expect(swarm.getRunningCount()).toBe(0);
  });
  it('cancels a real expert in flight and does not execute a subsequent step', async () => {
    llm.chatSync.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(Error('cancelled'))),
        ),
    );
    const wf = workflows.createWorkflow({
      name: 'cancel',
      steps: [
        { id: 'a', name: 'Expert', prompt: 'wait', agentId: 'writer' },
        { id: 'b', name: 'Later', prompt: 'do not run' },
      ],
    }).workflow!;
    const run = workflows.runWorkflow(wf.id).run!;
    const cancelled = await request(app.getHttpServer())
      .post(`/api/workflow/${wf.id}/runs/${run.id}/cancel`)
      .send({});
    expect(cancelled.body.success).toBe(true);
    await waitStatus(wf.id, 'cancelled');
    expect(llm.chatSync).toHaveBeenCalledTimes(1);
    expect(swarm.getRunningCount()).toBe(0);
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it('lets an unbudgeted expert continue beyond 50 iterations with tool-safe compaction', async () => {
    writeFileSync(join(root,'report.txt'), '资料'.repeat(3000));
    let round = 0;
    llm.chatSync.mockImplementation(async () => ++round <= 55
      ? {content:'',toolCalls:[{id:`read${round}`,name:'read_file',arguments:JSON.stringify({section:round})}]}
      : {content:'资料读取结束'});
    const child = swarm.createSubAgent('main',{task:'查看资料',prompt:'查看资料',workspace:root,tools:['read_file'],inheritTools:true,autoDestroy:false});
    expect(child.id).toBeTruthy();
    expect(child).not.toHaveProperty('maxIterations');
    const result = await swarm.executeSync(child.id!);
    expect(result).toMatchObject({success:true,result:'资料读取结束'});
    expect(llm.chatSync).toHaveBeenCalledTimes(56);
  });
});
