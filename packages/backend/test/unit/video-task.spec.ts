import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoTaskService } from '../../src/modules/automation/video-task.service.js';
import {
  DashScopeVideoProvider,
  VideoSubmissionRejected,
} from '../../src/modules/automation/video-provider.service.js';

describe('durable video tasks', () => {
  let dir: string, clock: number, service: VideoTaskService;
  let provider: { id: string; defaultModel: string; submit: jest.Mock; query: jest.Mock };
  let http: { get: jest.Mock };
  const request = {
    prompt: 'blue cube',
    provider: 'dashscope',
    model: 'wan2.7-t2v',
    durationSeconds: 2,
    size: '1280x720',
  };
  const mp4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
  const createService = () =>
    new VideoTaskService(
      { getVideoTaskDirectory: () => dir, resolveVideoProvider: () => provider, authorizeGenerationSync: () => {} } as never,
      http as never,
      { error: jest.fn() } as never,
    );
  const step = async () => {
    clock += 60001;
    service.tick();
    await new Promise((resolve) => setImmediate(resolve));
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sky-video-unit-'));
    clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    provider = {
      id: 'dashscope',
      defaultModel: 'wan2.7-t2v',
      submit: jest.fn().mockResolvedValue('vendor-1'),
      query: jest.fn().mockResolvedValue({ status: 'RUNNING' }),
    };
    http = { get: jest.fn().mockResolvedValue({ status: 200, data: mp4 }) };
    service = createService();
    service.onModuleInit();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('archives finished history while retaining artifacts and paid idempotency across restart', async () => {
    const job = service.create(request, 'archive');
    expect(() => service.archive(job.id)).toThrow('尚未结束');
    await step();
    provider.query.mockResolvedValue({ status: 'SUCCEEDED', url: 'https://example.com/result.mp4' });
    await step();
    // Use the durable persisted state to cover cleanup independently of download timing.
    const jobs = (service as unknown as { jobs: Array<{ status: string; artifactReady?: boolean }> }).jobs;
    jobs[0]!.status = 'succeeded'; jobs[0]!.artifactReady = true;
    writeFileSync(join(dir, job.id + '.mp4'), mp4);
    expect(service.archive(job.id)).toEqual({ deleted: 1 });
    expect(service.list()).toEqual([]);
    expect(readFileSync(service.artifact(job.id))).toEqual(mp4);
    service.onModuleDestroy(); service = createService(); service.onModuleInit();
    expect(service.list()).toEqual([]);
    expect(service.create(request, 'archive').id).toBe(job.id);
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });

  it('persists before submitting, deduplicates concurrent client retries, rejects conflicting keys', async () => {
    const job = service.create(request, 'same');
    expect(provider.submit).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'))[0].id).toBe(job.id);
    expect(service.create(request, 'same').id).toBe(job.id);
    expect(() => service.create({ ...request, prompt: 'different' }, 'same')).toThrow(
      'different request',
    );
    await step();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(service.get(job.id).providerTaskId).toBe('vendor-1');
    expect(service.create(request, 'same').id).toBe(job.id);
  });
  it('pins the default model and preserves idempotency after restart', async () => {
    const job = service.create({ prompt: 'default' }, 'default-key');
    await step();
    service.onModuleDestroy();
    provider.defaultModel = 'changed';
    service = createService();
    service.onModuleInit();
    expect(service.create({ prompt: 'default' }, 'default-key').id).toBe(job.id);
    await step();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(provider.query).toHaveBeenCalledWith(
      'vendor-1',
      expect.objectContaining({ model: 'wan2.7-t2v' }),
    );
  });
  it('never resubmits after an ambiguous network error; explicit linking permits query only', async () => {
    provider.submit.mockRejectedValueOnce(new Error('connection lost after POST'));
    const job = service.create(request, 'ambiguous');
    await step();
    expect(service.get(job.id).status).toBe('unknown');
    await step();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(() => service.resume(job.id)).toThrow('Confirm the provider');
    service.resume(job.id, 'recovered-id');
    await step();
    expect(provider.query).toHaveBeenCalledWith('recovered-id', expect.anything());
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });

  it('marks an explicit provider rejection as failed without retrying the chargeable POST', async () => {
    provider.submit.mockRejectedValueOnce(
      new VideoSubmissionRejected('HTTP 402: InsufficientBalance'),
    );
    const job = service.create(request, 'rejected');
    await step();
    await step();
    expect(service.get(job.id).status).toBe('failed');
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });
  it('treats a crash during submission as unknown instead of a new queued job', async () => {
    const job = service.create(request, 'crash');
    service.onModuleDestroy();
    const rows = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
    rows[0].status = 'submitting';
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(rows));
    service = createService();
    service.onModuleInit();
    await step();
    expect(service.get(job.id).status).toBe('unknown');
    expect(provider.submit).not.toHaveBeenCalled();
  });
  it('pauses queued work before a charge and resumes once', async () => {
    const job = service.create(request, 'pause');
    service.pause(job.id);
    await step();
    expect(provider.submit).not.toHaveBeenCalled();
    service.resume(job.id);
    await step();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    service.pause(job.id);
    await step();
    expect(provider.query).not.toHaveBeenCalled();
    service.resume(job.id);
    await step();
    expect(provider.query).toHaveBeenCalledTimes(1);
  });
  it('keeps the original task on polling errors and records provider failures', async () => {
    const job = service.create(request, 'retry');
    await step();
    provider.query.mockRejectedValueOnce(new Error('HTTP 429'));
    await step();
    expect(service.get(job.id)).toMatchObject({
      providerTaskId: 'vendor-1',
      error: 'HTTP 429',
      status: 'pending',
    });
    provider.query.mockResolvedValueOnce({ status: 'FAILED', error: 'Content rejected' });
    await step();
    expect(service.get(job.id)).toMatchObject({ status: 'failed', error: 'Content rejected' });
    await step();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('saves successful remote state before download; retries download without generation', async () => {
    const job = service.create(request, 'download');
    await step();
    provider.query.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      result: { videos: [{ url: 'https://fixture.example/video.mp4' }] },
    });
    http.get.mockRejectedValueOnce(new Error('download unavailable'));
    await step();
    expect(service.get(job.id)).toMatchObject({
      status: 'succeeded',
      remoteUrl: 'https://fixture.example/video.mp4',
    });
    service.onModuleDestroy();
    service = createService();
    service.onModuleInit();
    await step();
    expect(service.get(job.id)).toMatchObject({ artifactReady: true, artifactBytes: mp4.length });
    expect(readFileSync(service.artifact(job.id))).toEqual(mp4);
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(provider.query).toHaveBeenCalledTimes(1);
  });
  it('does not publish HTML error pages as MP4 artifacts', async () => {
    const job = service.create(request, 'invalid-mp4');
    await step();
    provider.query.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      result: { videos: [{ url: 'https://fixture.example/video.mp4' }] },
    });
    http.get.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from('<html>expired signed url</html>'),
    });
    await step();
    expect(service.get(job.id).artifactReady).toBeUndefined();
    expect(() => service.artifact(job.id)).toThrow('not downloaded');
  });
  it('uses wan2.7 resolution/ratio fields and one task query per request', async () => {
    const transport = {
      post: jest.fn().mockResolvedValue({ status: 200, data: { output: { task_id: 'task' } } }),
      get: jest
        .fn()
        .mockResolvedValue({ status: 200, data: { output: { task_status: 'RUNNING' } } }),
    };
    const adapter = new DashScopeVideoProvider({ apiKey: 'fixture' }, transport as never);
    expect(await adapter.submit(request)).toBe('task');
    expect(transport.post.mock.calls[0][1].parameters).toEqual({
      duration: 2,
      resolution: '720P',
      ratio: '16:9',
    });
    expect(await adapter.query('task', request)).toEqual({ status: 'RUNNING', error: undefined });
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
});
