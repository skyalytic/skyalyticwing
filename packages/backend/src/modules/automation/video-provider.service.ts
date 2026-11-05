import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpClientService } from '../core/http/http-client.service.js';
import { LoggerService } from '../core/logger/logger.service.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import type { ProviderConfig } from './image-provider.service.js';
import { resolveMediaBinary, readMediaTool } from '../core/utils/ffmpeg-runtime.util.js';

// ============================================================
// 类型定义 - 视频生成
// ============================================================

/** 视频生成请求 */
export interface VideoGenerateRequest {
  preferredModel?: string;
  requestId?: string;
  /** 指定提供商 ID */
  provider?: string;
  /** 生成提示词（必填） */
  prompt: string;
  /** 模型名称 */
  model?: string;
  /** 时长（秒） */
  durationSeconds?: number;
  /** 分辨率/尺寸 */
  size?: string;
  /** 输入图片 URL 列表（图生视频） */
  inputImages?: string[];
}

/** 单个生成视频 */
export interface GeneratedVideo {
  url: string | null;
  data: Buffer | null;
  format: string;
  duration: number;
  /** 本地文件路径（本地生成时） */
  localPath?: string;
}

/** 视频生成结果 */
export interface VideoGenerateResult {
  videos: GeneratedVideo[];
  model: string;
  metadata: Record<string, unknown>;
}

/** 视频提供商接口契约 */
export interface VideoProvider {
  id: string;
  name: string;
  defaultModel?: string;
  supportsImageInput?: boolean;
  generate(request: VideoGenerateRequest): Promise<VideoGenerateResult>;
  submit?(request: VideoGenerateRequest): Promise<string>;
  query?(taskId: string, request: VideoGenerateRequest): Promise<VideoTaskSnapshot>;
}

export interface VideoTaskSnapshot {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
  result?: VideoGenerateResult;
  error?: string | undefined;
}

/** A provider explicitly rejected creation; network/5xx errors remain ambiguous. */
export class VideoSubmissionRejected extends Error {}

// ============================================================
// 内置视频提供商
// ============================================================

/**
 * Runway 视频提供商
 * 端点：{baseUrl}/image_to_video
 */
export class RunwayVideoProvider implements VideoProvider {
  id = 'runway';
  name = 'Runway';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['RUNWAY_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://api.dev.runwayml.com/v1';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'gen3a_turbo';
  }

  supportsImageInput = true;
  async submit(request:VideoGenerateRequest):Promise<string> {
    if(!this.apiKey)throw new VideoSubmissionRejected('Runway API key not configured');
    const model=request.model||this.defaultModel;
    if((request.inputImages?.length || 0)>1)throw new VideoSubmissionRejected('This Runway adapter accepts one input image per task');
    // Gen-4.5 supports text-only requests on image_to_video; legacy turbo models require an image.
    if(['gen3a_turbo','gen4_turbo'].includes(model) && !request.inputImages?.length)throw new VideoSubmissionRejected('This Runway model requires an input image. Attach an image in chat.');
    const response=await this.http.post<{id?:string}>(this.baseUrl+(request.inputImages?.length||model.startsWith('gen')?'/image_to_video':'/text_to_video'),{model,promptText:request.prompt,ratio:(request.size||'1280:720').replace('x',':'),duration:request.durationSeconds||5,...(request.inputImages?.length?{promptImage:request.inputImages[0]}:{})},{headers:{Authorization:'Bearer '+this.apiKey,'X-Runway-Version':'2024-11-06'},responseType:'json'});
    if(response.status>=400)throw new (response.status<500?VideoSubmissionRejected:Error)('Runway API rejected submission: '+response.status);
    if(!response.data?.id)throw new Error('Runway returned no task ID; submission outcome is unknown');
    return response.data.id;
  }
  async query(taskId:string,request:VideoGenerateRequest):Promise<VideoTaskSnapshot> {
    const response=await this.http.get<{status?:string;output?:string[];failure?:string}>(this.baseUrl+'/tasks/'+encodeURIComponent(taskId),{headers:{Authorization:'Bearer '+this.apiKey,'X-Runway-Version':'2024-11-06'},responseType:'json'});
    if(response.status>=400)throw new Error('Runway task polling failed: '+response.status);
    const raw=response.data?.status;const status=raw==='THROTTLED'?'PENDING':raw;
    if(!status||!['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED'].includes(status))throw new Error('Invalid Runway task status');
    if(status!=='SUCCEEDED')return {status:status as VideoTaskSnapshot['status'],error:response.data?.failure};
    const url=response.data?.output?.[0];if(!url)throw new Error('Runway task has no output URL');
    return {status:'SUCCEEDED',result:{videos:[{url,data:null,format:'mp4',duration:request.durationSeconds||5}],model:request.model||this.defaultModel,metadata:{taskId}}};
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    if (!this.apiKey) {
      throw new Error('Runway API key not configured');
    }
    const payload: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      promptText: request.prompt,
    };
    if (request.durationSeconds) payload['duration'] = request.durationSeconds;
    if (request.size) payload['resolution'] = request.size;
    if (request.inputImages && request.inputImages.length > 0) {
      payload['promptImage'] = request.inputImages[0];
    }
    const resp = await this.http.post<{ url?: string; id?: string; status?: string }>(
      this.baseUrl + '/image_to_video',
      payload,
      {
        headers: {
          Authorization: 'Bearer ' + this.apiKey,
          'X-Runway-Version': '2024-11-06',
        },
        responseType: 'json',
      },
    );
    return {
      videos: [
        {
          url: resp.data?.url || null,
          data: null,
          format: 'mp4',
          duration: request.durationSeconds || 5,
        },
      ],
      model: request.model || this.defaultModel,
      metadata: { taskId: resp.data?.id, status: resp.data?.status },
    };
  }
}

/**
 * Pika 视频提供商
 * 端点：{baseUrl}/generate
 */
export class PikaVideoProvider implements VideoProvider {
  id = 'pika';
  name = 'Pika';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['PIKA_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://api.pika.art/v1';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'pika-1.0';
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    if (!this.apiKey) {
      throw new Error('Pika API key not configured');
    }
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      model: request.model || this.defaultModel,
    };
    if (request.durationSeconds) payload['duration'] = request.durationSeconds;
    if (request.size) payload['resolution'] = request.size;
    if (request.inputImages && request.inputImages.length > 0) {
      payload['image_url'] = request.inputImages[0];
    }
    const resp = await this.http.post<{ video_url?: string; url?: string; id?: string }>(
      this.baseUrl + '/generate',
      payload,
      {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        responseType: 'json',
      },
    );
    return {
      videos: [
        {
          url: resp.data?.video_url || resp.data?.url || null,
          data: null,
          format: 'mp4',
          duration: request.durationSeconds || 4,
        },
      ],
      model: request.model || this.defaultModel,
      metadata: { taskId: resp.data?.id },
    };
  }
}

/**
 * DashScope（阿里灵积）视频提供商（通义万相 wan2.7 系列）
 * 端点：{baseUrl}/services/aigc/video-generation/video-synthesis
 * 异步任务模式：提交后轮询 tasks/{taskId}
 * 与 LLM 供应商 qwen 共用 DashScope API key，可自动派生。
 */
export class DashScopeVideoProvider implements VideoProvider {
  supportsImageInput = true;
  id = 'dashscope';
  name = 'DashScope (通义万相)';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['DASHSCOPE_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://dashscope.aliyuncs.com/api/v1';
    // Default to the live-verified model; newer protocols remain explicitly selectable.
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'wan2.6-t2v';
  }

  async submit(request: VideoGenerateRequest): Promise<string> {
    if (!this.apiKey) throw new VideoSubmissionRejected('DashScope API key not configured');
    const model = request.model || this.defaultModel;
    const parameters: Record<string, unknown> = {};
    if (request.durationSeconds) parameters['duration'] = request.durationSeconds;
    if (request.size) {
      const size = request.size.trim().replace(/[xX×]/g, '*').replace(/\s+/g, '');
      if (model.startsWith('wan2.7')) {
        const sizes: Record<string, [string, string]> = {
          '1280*720': ['720P', '16:9'], '720*1280': ['720P', '9:16'], '960*960': ['720P', '1:1'],
          '1104*832': ['720P', '4:3'], '832*1104': ['720P', '3:4'],
          '1920*1080': ['1080P', '16:9'], '1080*1920': ['1080P', '9:16'], '1440*1440': ['1080P', '1:1'],
          '1648*1248': ['1080P', '4:3'], '1248*1648': ['1080P', '3:4'],
        };
        const mapped = sizes[size];
        if (!mapped) throw new VideoSubmissionRejected('Unsupported wan2.7 size; use an official resolution/ratio size');
        parameters['resolution'] = mapped[0]; parameters['ratio'] = mapped[1];
      } else parameters['size'] = size;
    }
    if (model.startsWith('wan2.7') && request.durationSeconds !== undefined
      && (!Number.isInteger(request.durationSeconds) || request.durationSeconds < 2 || request.durationSeconds > 15)) {
      throw new VideoSubmissionRejected('wan2.7 duration must be an integer from 2 to 15 seconds');
    }
    const input: Record<string, unknown> = { prompt: request.prompt };
    if (model.startsWith('wan2.7-i2v')) {
      if (!request.inputImages?.length || request.inputImages.length > 2) throw new VideoSubmissionRejected('wan2.7-i2v requires one or two frame images');
      input['media'] = request.inputImages.map((url, i) => ({ type: i ? 'last_frame' : 'first_frame', url }));
    } else if (request.inputImages?.length) throw new VideoSubmissionRejected('Choose an image-to-video model for image input');
    const resp = await this.http.post<{ output?: { task_id?: string }; code?: string; message?: string }>(
      this.baseUrl + '/services/aigc/video-generation/video-synthesis',
      { model, input, parameters },
      { headers: { Authorization: 'Bearer ' + this.apiKey, 'X-DashScope-Async': 'enable' }, responseType: 'json' },
    );
    if (resp.status >= 400) {
      const Rejection = resp.status < 500 ? VideoSubmissionRejected : Error;
      throw new Rejection('DashScope API ' + resp.status + ' ' + (resp.data?.code ?? '') + ': ' + (resp.data?.message ?? 'request failed'));
    }
    if (!resp.data?.output?.task_id) throw new Error('DashScope returned no task id; submission outcome is unknown');
    return resp.data.output.task_id;
  }

  async query(taskId: string, request: VideoGenerateRequest): Promise<VideoTaskSnapshot> {
    const resp = await this.http.get<{
      output?: { task_status?: VideoTaskSnapshot['status']; video_url?: string; results?: { video_url?: string }; code?: string; message?: string };
      code?: string; message?: string;
    }>(this.baseUrl + '/tasks/' + encodeURIComponent(taskId), {
      headers: { Authorization: 'Bearer ' + this.apiKey }, responseType: 'json',
    });
    if (resp.status >= 400) throw new Error('DashScope task ' + taskId + ' polling failed: HTTP ' + resp.status + ' ' + (resp.data?.code ?? '') + ' ' + (resp.data?.message ?? ''));
    const status = resp.data?.output?.task_status;
    if (!status || !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) throw new Error('DashScope task ' + taskId + ' returned no valid task_status');
    if (status !== 'SUCCEEDED') return { status, error: resp.data?.output?.message || resp.data?.output?.code };
    const url = resp.data?.output?.video_url || resp.data?.output?.results?.video_url;
    if (!url) throw new Error('DashScope task ' + taskId + ' succeeded but returned no video URL');
    return { status, result: { videos: [{ url, data: null, format: 'mp4', duration: request.durationSeconds || 5 }], model: request.model || this.defaultModel, metadata: { taskId, status } } };
  }

  /** Compatibility API; application-facing entry points use durable VideoTaskService. */
  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    const taskId = await this.submit(request);
    for (let i = 0; i < 180; i++) {
      await sleep(5000);
      const state = await this.query(taskId, request);
      if (state.result) return state.result;
      if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(state.status)) throw new Error('DashScope task ' + taskId + ': ' + (state.error || state.status));
    }
    throw new Error('DashScope video task ' + taskId + ' polling timed out; query this task before submitting again');
  }

}

/**
 * 火山方舟 Ark 视频提供商（豆包 Seedance 系列）
 * 端点：{baseUrl}/contents/generations/tasks（异步任务模式，提交后轮询 tasks/{id}）
 * 与 LLM 供应商 doubao 共用 Ark API key，可自动派生。
 */
export class ArkVideoProvider implements VideoProvider {
  id = 'ark';
  name = 'Volcengine Ark (Seedance)';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['ARK_API_KEY'] ||
      process.env['VOLCENGINE_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://ark.cn-beijing.volces.com/api/v3';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) ||
      'doubao-seedance-2-5-260628';
  }

  supportsImageInput = true;
  async submit(request:VideoGenerateRequest):Promise<string> {
    if(!this.apiKey)throw new VideoSubmissionRejected('Ark API key not configured');
    const content:Array<Record<string,unknown>>=[{type:'text',text:request.prompt}];
    for(const [i,url] of (request.inputImages || []).entries())content.push({type:'image_url',image_url:{url},role:i===0?'first_frame':'last_frame'});
    let ratio=request.size?.replace('x',':');
    if(ratio && /^\d+:\d+$/.test(ratio)) { const [w,h]=ratio.split(':').map(Number); const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a; const d=gcd(w!,h!); if(d)ratio=`${w!/d}:${h!/d}`; }
    const response=await this.http.post<{id?:string;error?:{message?:string}}>(this.baseUrl+'/contents/generations/tasks',{model:request.model||this.defaultModel,content,...(request.durationSeconds?{duration:request.durationSeconds}:{}),...(ratio?{ratio}:{} )},{headers:{Authorization:'Bearer '+this.apiKey},responseType:'json'});
    if(response.status>=400)throw new (response.status<500?VideoSubmissionRejected:Error)('Ark API rejected submission: '+response.status);
    if(!response.data?.id)throw new Error('Ark returned no task ID; submission outcome is unknown');
    return response.data.id;
  }
  async query(taskId:string,request:VideoGenerateRequest):Promise<VideoTaskSnapshot> {
    const response=await this.http.get<{status?:string;content?:{video_url?:string};error?:{message?:string}}>(this.baseUrl+'/contents/generations/tasks/'+encodeURIComponent(taskId),{headers:{Authorization:'Bearer '+this.apiKey},responseType:'json'});
    if(response.status>=400)throw new Error('Ark task polling failed: '+response.status);
    const statuses:Record<string,VideoTaskSnapshot['status']>={queued:'PENDING',running:'RUNNING',succeeded:'SUCCEEDED',failed:'FAILED',cancelled:'CANCELED',expired:'FAILED'};
    const status=statuses[response.data?.status||''];if(!status)throw new Error('Invalid Ark task status');
    if(status!=='SUCCEEDED')return {status,error:response.data?.error?.message};
    const url=response.data?.content?.video_url;if(!url)throw new Error('Ark task has no output URL');
    return {status,result:{videos:[{url,data:null,format:'mp4',duration:request.durationSeconds||5}],model:request.model||this.defaultModel,metadata:{taskId}}};
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    if (!this.apiKey) {
      throw new Error('Ark API key not configured');
    }
    // content 数组：图生视频时首帧图片 + 文本提示词（对齐 Ark Seedance 协议）
    const content: Array<Record<string, unknown>> = [];
    if (request.inputImages && request.inputImages.length > 0) {
      content.push({
        type: 'image_url',
        image_url: { url: request.inputImages[0] },
        role: 'first_frame',
      });
    }
    content.push({ type: 'text', text: request.prompt });

    const resp = await this.http.post<{
      id?: string;
      status?: string;
      error?: { message?: string };
    }>(this.baseUrl + '/contents/generations/tasks', {
      model: request.model || this.defaultModel,
      content,
    }, {
      headers: { Authorization: 'Bearer ' + this.apiKey },
      responseType: 'json',
    });

    const taskId = resp.data?.id;
    if (!taskId) {
      throw new Error(
        'Ark video task create failed: ' + (resp.data?.error?.message || 'no task id'),
      );
    }

    // 异步任务轮询：Seedance 长视频生成耗时与时长成正比（15 秒视频可达 7 分钟+），
    // 5 分钟上限会掐断长时长视频，放宽到 15 分钟（180 * 5s），与 DashScope 对齐
    const maxPolls = 180;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(5000);
      const poll = await this.http.get<{
        status?: string;
        content?: { video_url?: string };
        error?: { message?: string };
      }>(this.baseUrl + '/contents/generations/tasks/' + encodeURIComponent(taskId), {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        responseType: 'json',
      });
      const status = poll.data?.status;
      if (status === 'succeeded') {
        return {
          videos: [
            {
              url: poll.data?.content?.video_url || null,
              data: null,
              format: 'mp4',
              duration: request.durationSeconds || 5,
            },
          ],
          model: request.model || this.defaultModel,
          metadata: { taskId, status },
        };
      }
      if (status === 'failed') {
        throw new Error(
          'Ark video generation failed: ' + (poll.data?.error?.message || 'unknown'),
        );
      }
      // queued / running 继续轮询
    }
    throw new Error('Ark video generation timed out');
  }
}

/**
 * 本地 FFmpeg 视频提供商
 * 使用图片序列生成视频，需校验输入路径（M-D11）
 */
export function selectLocalVideoEncoder(list: string): string {
  const available = new Set(list.split('\n').flatMap(line => {
    const match = /^\s*V\S+\s+(\S+)/.exec(line);
    return match ? [match[1]!] : [];
  }));
  const encoder = ['libx264','libopenh264','h264_videotoolbox','h264_mf','mpeg4'].find(name => available.has(name));
  if (!encoder) throw new Error('FFmpeg 未包含可用的本地视频编码器');
  return encoder;
}

export class LocalFFmpegVideoProvider implements VideoProvider {
  id = 'local-ffmpeg';
  name = 'Local FFmpeg';
  ffmpegPath: string;
  /** 输出目录（由 VideoProviderService 注入） */
  dataDir: string;

  constructor(
    config: ProviderConfig,
    private readonly security: SecurityManagerService,
    dataDir: string,
  ) {
    this.ffmpegPath = resolveMediaBinary('ffmpeg',typeof config['ffmpegPath'] === 'string' ? config['ffmpegPath'] : undefined).path;
    this.dataDir = dataDir;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    if (!request.inputImages || request.inputImages.length === 0) {
      throw new Error('Local FFmpeg requires input images for video generation');
    }
    // 校验用户 inputImages[0] 路径，防止恶意路径注入 ffmpeg 命令
    if (!this.security.isPathAllowed(request.inputImages[0], 'read')) {
      throw new Error('Input image path not allowed (M-D11): ' + request.inputImages[0]);
    }
    const outputDir = join(this.dataDir, 'video');
    try {
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    } catch {
      // 忽略
    }
    const outputFile = join(outputDir, 'video-' + Date.now() + '.mp4');
    const encoder = selectLocalVideoEncoder(await readMediaTool(this.ffmpegPath, ['-hide_banner','-encoders']));
    const args = [
      '-y',
      '-framerate', '1',
      '-i', request.inputImages[0],
      '-c:v', encoder,
      '-pix_fmt', 'yuv420p',
      '-t', String(request.durationSeconds || 5),
      outputFile,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile(this.ffmpegPath, args, { timeout: 60000 }, (err) => {
        if (err) {
          return reject(new Error('FFmpeg error: ' + err.message));
        }
        resolve();
      });
    });
    return {
      videos: [
        {
          url: null,
          data: null,
          format: 'mp4',
          duration: request.durationSeconds || 5,
          localPath: outputFile,
        },
      ],
      model: 'ffmpeg',
      metadata: {},
    };
  }
}

// ============================================================
// 视频提供商注册表服务
// ============================================================

/** 已知视频提供商 ID 列表（用于 listVideoProviders 展示） */
const KNOWN_VIDEO_PROVIDERS = ['runway', 'pika', 'dashscope', 'ark', 'minimax', 'volcengine', 'local', 'local-ffmpeg'];

/** 模型名推断路由 → 厂商显示名（用于未配置对应厂商 key 时的报错提示） */
const INFERRED_VIDEO_PROVIDER_NAMES: Record<string, string> = {
  dashscope: '通义千问',
  ark: '火山豆包',
  openai: 'OpenAI',
  siliconflow: '硅基流动',
};

/**
 * 根据生成模型名推断视频提供商 ID（统一模型体系路由）。
 *
 * AI 传 model 名即可自动路由到对应媒体厂商：
 *   - wan/wanx 开头（通义万相系列，如 wan2.7-t2v）→ dashscope
 *   - 含 seedream（火山 Seedream 系列）→ ark
 *   - 含 seedance / doubao-seedance（火山 Seedance 系列，如 doubao-seedance-2-0-260128）→ ark
 *   - gpt-image / dall-e 开头 → openai
 *   - 含 flux / stable-diffusion / stabilityai / black-forest → siliconflow
 *   - 无匹配返回 null（走默认提供商回退链）
 */
export function inferVideoProviderId(model?: string): string | null {
  if (!model) return null;
  if (/^(wan|wanx)/i.test(model)) return 'dashscope';
  if (/seedream/i.test(model)) return 'ark';
  if (/seedance|doubao-seedance/i.test(model)) return 'ark';
  if (/^gpt-image|^dall-e/i.test(model)) return 'openai';
  if (/flux|stable-diffusion|stabilityai|black-forest/i.test(model)) return 'siliconflow';
  return null;
}

/**
 * VideoProviderService - 视频提供商注册表
 *
 * 职责：
 *   - 注册/管理视频生成提供商
 *   - 按提供商 ID 调度 generateVideo
 *   - 列出可用提供商
 *
 * 全量移植自 media-manager.cjs 视频生成注册表段落。
 */
@Injectable()
export class VideoProviderService {
  private readonly providers: Record<string, VideoProvider> = {};
  private defaultProvider: string | null = null;

  constructor(
    _http: HttpClientService,
    private readonly logger: LoggerService,
  ) {}

  /** 注册视频提供商 */
  registerProvider(id: string, provider: VideoProvider): void {
    if (!id || typeof id !== 'string') {
      throw new Error('Video provider ID must be a non-empty string');
    }
    if (!provider || typeof provider.generate !== 'function') {
      throw new Error('Video provider must implement generate()');
    }
    this.providers[id] = provider;
    if (!this.defaultProvider) {
      this.defaultProvider = id;
    }
    this.logger.info('Registered video provider: ' + id);
  }

  /** 设置默认视频提供商 */
  clearProviders(): void { for (const id of Object.keys(this.providers)) delete this.providers[id]; this.defaultProvider=null; }
  setDefaultProvider(id: string): void {
    this.defaultProvider = id;
  }

  /** 是否已注册任意视频提供商（供自动派生判断：无手动配置时才派生） */
  hasProviders(): boolean {
    return Object.keys(this.providers).length > 0;
  }

  /**
   * 生成视频：统一模型体系路由调度
   * 解析顺序：request.provider → inferVideoProviderId(request.model)
   * （命中且已注册才用；命中但未注册时明确报错指明需配置哪家厂商 key，而非静默回退
   * ——回退到其他厂商会以错误模型调用）→ 默认提供商 → 第一个已注册
   */
  resolveProvider(request: VideoGenerateRequest): VideoProvider {
    const req = request || ({} as VideoGenerateRequest);
    let provider: VideoProvider | undefined = req.provider
      ? this.providers[req.provider]
      : undefined;
    if (req.provider && !provider) throw new Error('Unknown video provider: ' + req.provider);
    if (!provider && req.model) {
      const inferred = inferVideoProviderId(req.model);
      if (inferred) {
        provider = this.providers[inferred];
        if (!provider) {
          throw new Error(
            `模型 ${req.model} 需要配置 ${INFERRED_VIDEO_PROVIDER_NAMES[inferred] ?? inferred} 供应商 API key`,
          );
        }
      }
    }
    if (!provider && this.defaultProvider) {
      provider = this.providers[this.defaultProvider];
    }
    if (!provider) {
      const keys = Object.keys(this.providers);
      if (keys.length > 0) {
        provider = this.providers[keys[0]];
      } else {
        throw new Error('No video provider available');
      }
    }
    if (!req.prompt) {
      throw new Error('Video generation prompt is required');
    }
    return provider;
  }

  async generateVideo(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    const req = request;
    const provider = this.resolveProvider(req);
    this.logger.info('Generating video with provider: ' + provider.id);
    try {
      return await provider.generate(req);
    } catch (err) {
      this.logger.error('Video generation failed with ' + provider.id + ': ' + (err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** 列出所有视频提供商（含未配置的已知项） */
  listVideoProviders(): Array<{
    id: string;
    name: string;
    type: string;
    isDefault: boolean;
    status: string;
  }> {
    const result: Array<{ id: string; name: string; type: string; isDefault: boolean; status: string }> = [];
    const keys = Object.keys(this.providers);
    for (const k of new Set([...KNOWN_VIDEO_PROVIDERS, ...keys])) {
      const registered = keys.indexOf(k) >= 0;
      result.push({
        id: k,
        name: registered ? (this.providers[k].name || k) : k,
        type: 'video',
        isDefault: k === this.defaultProvider,
        status: registered ? 'available' : 'unconfigured',
      });
    }
    return result;
  }
}

/** 简单 sleep 工具 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
