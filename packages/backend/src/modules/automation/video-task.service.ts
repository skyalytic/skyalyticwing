import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { HttpClientService } from '../core/http/http-client.service.js';
import { LoggerService } from '../core/logger/logger.service.js';
import { MediaService } from './media.service.js';
import type { VideoGenerateRequest } from './video-provider.service.js';
import { VideoSubmissionRejected } from './video-provider.service.js';

export interface VideoTask {
  id: string;
  keyHash: string;
  requestHash?: string;
  request: VideoGenerateRequest;
  status:
    'queued' | 'submitting' | 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'unknown';
  providerTaskId?: string;
  providerStatus?: string;
  createdAt: number;
  updatedAt: number;
  nextPollAt: number;
  error?: string | undefined;
  remoteUrl?: string | undefined;
  artifactReady?: boolean;
  artifactBytes?: number;
  downloadAttempts?: number;
  polls: number;
  pauseReason?: string | undefined;
  billing?: unknown;
  archivedAt?: number;
}

/** Single-writer durable task queue. Never repeat an ambiguous paid submission. */
@Injectable()
export class VideoTaskService implements OnModuleInit, OnModuleDestroy {
  private jobs: VideoTask[] = [];
  private file = '';
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<string>();
  private stopped = false;

  constructor(
    private readonly media: MediaService,
    private readonly http: HttpClientService,
    private readonly logger: LoggerService,

  ) {}

  onModuleInit(): void {
    this.file = join(this.media.getVideoTaskDirectory(), 'tasks.json');
    this.jobs = readJsonRecover<VideoTask[]>(this.file, []);
    if (
      !Array.isArray(this.jobs) ||
      this.jobs.some(
        (j) =>
          !/^[0-9a-f-]{36}$/i.test(j.id) ||
          !j.request ||
          ![
            'queued',
            'submitting',
            'pending',
            'running',
            'succeeded',
            'failed',
            'paused',
            'unknown',
          ].includes(j.status),
      )
    )
      throw new Error('Invalid video task store');
    for (const job of this.jobs) {
      if (job.status === 'submitting') {
        job.status = job.providerTaskId ? 'pending' : 'unknown';
        job.error = job.providerTaskId
          ? undefined
          : '进程在提交时中断，结果未知；请在供应商控制台核对并关联任务 ID，不能自动重提交。';
      }
    }
    this.persist();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  private persist(): void {
    writeJsonAtomicSync(this.file, this.jobs);
  }
  private find(id: string): VideoTask {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new NotFoundException('Video task not found');
    return job;
  }
  list(): VideoTask[] {
    return structuredClone(this.jobs.filter(job => !job.archivedAt).reverse());
  }
  archive(id?: string): { deleted: number } {
    const candidates = id ? [this.find(id)] : this.jobs;
    const finished = (job: VideoTask) => ['succeeded', 'failed'].includes(job.status) && !this.active.has(job.id);
    if (id && !finished(candidates[0]!)) throw new ConflictException('任务尚未结束，请结束后再清理记录');
    let deleted = 0;
    for (const job of candidates) {
      if (!job.archivedAt && finished(job)) { job.archivedAt = Date.now(); deleted++; }
    }
    this.persist();
    return { deleted };
  }
  get(id: string): VideoTask {
    return structuredClone(this.find(id));
  }

  create(input: VideoGenerateRequest, key: string): VideoTask {
    if (typeof key !== 'string' || !key || key.length > 200)
      throw new BadRequestException('Idempotency-Key is required (1–200 characters)');
    if (
      !input ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      input.prompt.length > 5000
    )
      throw new BadRequestException('prompt must contain 1–5000 characters');
    for (const name of ['provider', 'model', 'size'] as const)
      if (
        input[name] !== undefined &&
        (typeof input[name] !== 'string' || input[name]!.length > 200)
      )
        throw new BadRequestException('Invalid ' + name);
    if (
      input.durationSeconds !== undefined &&
      (!Number.isInteger(input.durationSeconds) ||
        input.durationSeconds < 2 ||
        input.durationSeconds > 15)
    )
      throw new BadRequestException('durationSeconds must be 2–15');
    if (
      input.inputImages !== undefined &&
      (!Array.isArray(input.inputImages) || input.inputImages.length > 2 || input.inputImages.some(v=>typeof v!=='string'||! /^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(v)))
    )
      throw new BadRequestException('Video inputs require at most two HTTPS or image data URLs');
    const request: VideoGenerateRequest = JSON.parse(
      JSON.stringify({
        prompt: input.prompt,
        preferredModel: input.preferredModel,
        provider: input.provider,
        model: input.model,
        durationSeconds: input.durationSeconds,
        size: input.size,
        inputImages: input.inputImages }),
    );
    const keyHash = createHash('sha256').update(key).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const old = this.jobs.find((j) => j.keyHash === keyHash);
    // Compare the submitted representation before resolving a potentially changed default provider.
    if (old) {
      const candidate = { ...request, provider: request.provider || old.request.provider };
      if (
        old.requestHash
          ? old.requestHash !== requestHash
          : JSON.stringify(candidate) !== JSON.stringify(old.request)
      )
        throw new ConflictException('Idempotency-Key already used for a different request');
      return structuredClone(old);
    }
    request.requestId=keyHash;
    this.media.authorizeGenerationSync('video',request);
    const provider = this.media.resolveVideoProvider(request);
    if(request.inputImages?.length && !provider.supportsImageInput)throw new BadRequestException('This configured provider supports text-to-video only');
    if (!provider.submit || !provider.query)
      throw new BadRequestException('This provider does not support resumable video tasks yet');
    request.provider = provider.id;
    if (!request.model && provider.defaultModel) request.model = provider.defaultModel;
    if (
      this.jobs.filter((j) => ['queued', 'submitting', 'pending', 'running'].includes(j.status))
        .length >= 20
    )
      throw new ConflictException('Video queue is full');
    const job: VideoTask = {
      id: randomUUID(),
      keyHash,
      requestHash,
      request,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextPollAt: 0,
      polls: 0 };
    this.jobs.push(job);
    try {
      this.persist();
    } catch (error) {
      this.jobs.pop();
      throw error;
    }
    return structuredClone(job);
  }

  pause(id: string): VideoTask {
    const job = this.find(id);
    if (this.active.has(id)) throw new ConflictException('Task is updating; retry shortly');
    if (!['queued', 'pending', 'running'].includes(job.status))
      throw new ConflictException('Task cannot be paused in its current state');
    job.status = 'paused';
    job.updatedAt = Date.now();
    this.persist();
    return this.get(id);
  }

  async submit(input:VideoGenerateRequest,key:string):Promise<VideoTask> {
    const job=this.create(input,key);
    // Commit intent first, then return a known submission outcome to the agent.
    // A duplicate request can only inspect the existing task.
    if(job.status==='queued' && !this.active.has(job.id)) {
      this.active.add(job.id);
      try {await this.step(this.find(job.id));} finally {this.active.delete(job.id);}
    }
    return this.get(job.id);
  }

  resume(id: string, taskId?: string): VideoTask {
    const job = this.find(id);
    if (this.active.has(id)) throw new ConflictException('Task is updating; retry shortly');
    if (taskId) {
      if (job.status !== 'unknown' || job.providerTaskId || !/^[\w-]{1,200}$/.test(taskId))
        throw new BadRequestException(
          'Only an unknown submission can be linked to a provider task',
        );
      if (
        this.jobs.some(
          (j) => j.providerTaskId === taskId && j.request.provider === job.request.provider,
        )
      )
        throw new ConflictException('Provider task already linked');
      job.providerTaskId = taskId;
    }
    if (!['paused', 'unknown', 'succeeded'].includes(job.status)) return this.get(id);
    if (job.status === 'unknown' && !job.providerTaskId)
      throw new ConflictException(
        'Confirm the provider task ID before resuming; no automatic resubmission',
      );
    if (job.status !== 'succeeded') job.status = job.providerTaskId ? 'pending' : 'queued';
    job.pauseReason=undefined;
    job.nextPollAt = 0;
    job.downloadAttempts = 0;
    job.error = undefined;
    job.updatedAt = Date.now();
    this.persist();
    return this.get(id);
  }

  artifact(id: string): string {
    const job = this.find(id);
    const file = join(this.media.getVideoTaskDirectory(), job.id + '.mp4');
    if (!job.artifactReady || !existsSync(file))
      throw new NotFoundException('Video artifact is not downloaded yet');
    return file;
  }

  tick(): void {
    if (this.stopped) return;
    for (const job of this.jobs) {
      if (this.active.size >= 2) break;
      if (this.active.has(job.id) || job.nextPollAt > Date.now()) continue;
      if (
        !['queued', 'pending', 'running'].includes(job.status) &&
        !(job.status === 'succeeded' && !job.artifactReady && (job.downloadAttempts || 0) < 5)
      )
        continue;
      this.active.add(job.id);
      void this.step(job)
        .catch((error) =>
          this.logger.error('Video task state could not be saved: ' + String(error)),
        )
        .finally(() => this.active.delete(job.id));
    }
  }

  private async step(job: VideoTask): Promise<void> {
    try {
      if (job.status === 'queued') {
        // Fail closed if the intent cannot be committed before the chargeable call.
        job.status = 'submitting';
        job.updatedAt = Date.now();
        this.persist();
        const provider = this.media.resolveVideoProvider(job.request);
        job.providerTaskId = await provider.submit!(job.request);
        job.status = 'pending';
        job.providerStatus = 'PENDING';
      } else if (job.status === 'succeeded') {
        await this.download(job);
      } else {
        const provider = this.media.resolveVideoProvider(job.request);
        const snapshot = await provider.query!(job.providerTaskId!, job.request);
        job.polls++;
        job.providerStatus = snapshot.status;
        job.error = snapshot.error;
        if (snapshot.status === 'SUCCEEDED') {
          job.billing=snapshot.result?.metadata?.['billing'];
          job.remoteUrl = snapshot.result?.videos[0]?.url || undefined;
          if (!job.remoteUrl) throw new Error('Video succeeded without a downloadable artifact');
          job.status = 'succeeded';
          this.persist(); // Save the remote result before attempting a download.
          await this.download(job);
        } else if (snapshot.status === 'FAILED' || snapshot.status === 'CANCELED')
          job.status = 'failed';
        else if (snapshot.status === 'UNKNOWN') {
          job.status = 'unknown';
          job.error = snapshot.error || 'Provider task is unknown or expired';
        } else job.status = snapshot.status === 'RUNNING' ? 'running' : 'pending';
      }
      job.nextPollAt = Date.now() + 15000;
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      if (job.status === 'submitting')
        job.status = job.providerTaskId
          ? 'pending'
          : error instanceof VideoSubmissionRejected
            ? 'failed'
            : 'unknown';
      job.nextPollAt = Date.now() + 60000;
    }
    job.updatedAt = Date.now();
    // Stop polling after the provider's task lookup window; keep the ID for investigation.
    if (Date.now() - job.createdAt > 24 * 3600000 && ['pending', 'running'].includes(job.status)) {
      job.status = 'unknown';
      job.error = 'Task lookup window exceeded; verify the saved provider task ID';
    }
    this.persist();
  }

  private async download(job: VideoTask): Promise<void> {
    job.downloadAttempts = (job.downloadAttempts || 0) + 1;
    if (!job.remoteUrl) throw new Error('No video download URL');
    const response = await this.http.get<Buffer>(job.remoteUrl, {
      responseType: 'buffer',
      timeout: 120000 });
    if (
      response.status !== 200 ||
      !Buffer.isBuffer(response.data) ||
      response.data.length < 12 ||
      response.data.toString('ascii', 4, 8) !== 'ftyp'
    )
      throw new Error('Video download did not return a valid MP4');
    const dir = this.media.getVideoTaskDirectory();
    mkdirSync(dir, { recursive: true });
    const final = join(dir, job.id + '.mp4');
    const temp = final + '.tmp';
    writeFileSync(temp, response.data, { mode: 0o600 });
    renameSync(temp, final);
    job.artifactReady = true;
    job.artifactBytes = response.data.length;
    job.error = undefined;
  }
}
