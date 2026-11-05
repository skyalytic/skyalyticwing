import { Injectable } from '@nestjs/common';
import { HttpClientService } from '../core/http/http-client.service.js';
import { LoggerService } from '../core/logger/logger.service.js';

// ============================================================
// 类型定义 - 图片生成
// ============================================================

/** 图片生成请求 */
export interface ImageGenerateRequest {
  preferredModel?: string;
  requestId?: string;
  inputImages?: string[];
  /** 指定提供商 ID */
  provider?: string;
  /** 生成提示词（必填） */
  prompt: string;
  /** 模型名称 */
  model?: string;
  /** 生成数量 */
  count?: number;
  /** 图片尺寸，如 1024x1024 */
  size?: string;
  /** 质量（standard/hd） */
  quality?: string;
  /** 返回格式：url 或 b64_json */
  format?: 'url' | 'b64_json';
}

/** 单张生成图片 */
export interface GeneratedImage {
  url: string | null;
  data: Buffer | null;
  format: string;
  width: number;
  height: number;
}

/** 图片生成结果 */
export interface ImageGenerateResult {
  images: GeneratedImage[];
  model: string;
  metadata: Record<string, unknown>;
}

/** 图片提供商接口契约 */
export interface ImageProvider {
  id: string;
  name: string;
  supportsImageInput?: boolean;
  generate(request: ImageGenerateRequest): Promise<ImageGenerateResult>;
  listModels?(): string[];
}

/** 提供商配置（任意键值） */
export type ProviderConfig = Record<string, unknown>;

// ============================================================
// 内置图片提供商
// ============================================================

/**
 * OpenAI DALL-E 图片提供商
 * 端点：{baseUrl}/images/generations
 */
export class OpenAIImageProvider implements ImageProvider {
  id = 'openai';
  name = 'OpenAI DALL-E';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
    _logger: LoggerService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['OPENAI_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://api.openai.com/v1';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'gpt-image-1.5';
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }
    const model = request.model || this.defaultModel;
    const size = request.size || '1024x1024';
    // GPT Image 系列（gpt-image-*）参数协议与 DALL-E 不同：
    //   - 不支持 response_format（恒返回 b64_json，传了会 400）
    //   - quality 取 low/medium/high/auto（不支持 DALL-E 的 standard/hd）
    const isGptImage = /^gpt-image/i.test(model);
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: request.count || 1,
      size,
    };
    if (isGptImage) {
      body['quality'] = request.quality || 'auto';
    } else {
      body['quality'] = request.quality || 'standard';
      body['response_format'] = request.format === 'url' ? 'url' : 'b64_json';
    }
    const resp = await this.http.post<{
      data?: Array<{ url?: string; b64_json?: string }>;
      model?: string;
      created?: number;
    }>(this.baseUrl + '/images/generations', body, {
      headers: { Authorization: 'Bearer ' + this.apiKey },
      responseType: 'json',
      // GPT Image 系列生成耗时较长（high 档可达 1-2 分钟）
      timeout: 180_000,
      maxRedirects: 0,
    });
    if (resp.status >= 400) throw new Error(`OpenAI image request failed (HTTP ${resp.status})`);
    const images: GeneratedImage[] = [];
    if (resp.data?.data) {
      for (const item of resp.data.data) {
        images.push({
          url: item.url || null,
          data: item.b64_json ? Buffer.from(item.b64_json, 'base64') : null,
          format: 'png',
          width: parseInt(size.split('x')[0], 10) || 1024,
          height: parseInt(size.split('x')[1], 10) || 1024,
        });
      }
    }
    if (!images.some(image => image.url || image.data)) throw new Error('OpenAI returned no generated image');
    return {
      images,
      model: resp.data?.model || model,
      metadata: { created: resp.data?.created },
    };
  }

  listModels(): string[] {
    // DALL-E 2/3 已于 2026-05 停服，仅保留 gpt-image 系列 + 兼容旧显式指定
    return ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'];
  }
}

/**
 * SiliconFlow 图片提供商
 * 端点：{baseUrl}/images/generations
 */
export class SiliconFlowImageProvider implements ImageProvider {
  id = 'siliconflow';
  name = 'SiliconFlow';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
    _logger: LoggerService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['SILICONFLOW_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://api.siliconflow.cn/v1';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) ||
      'stabilityai/stable-diffusion-xl-base-1.0';
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.apiKey) {
      throw new Error('SiliconFlow API key not configured');
    }
    const body = {
      model: request.model || this.defaultModel,
      prompt: request.prompt,
      n: request.count || 1,
      image_size: request.size || '1024x1024',
      batch_size: request.count || 1,
    };
    const resp = await this.http.post<{
      images?: Array<{ url?: string }>;
      data?: Array<{ url?: string; b64_json?: string }>;
    }>(this.baseUrl + '/images/generations', body, {
      headers: { Authorization: 'Bearer ' + this.apiKey },
      responseType: 'json',
      // 生图为长耗时操作，默认 30s 超时会误杀（对齐 OpenAI provider 的 180s）
      timeout: 180_000,
    });
    const images: GeneratedImage[] = [];
    if (resp.data?.images) {
      for (const item of resp.data.images) {
        images.push({
          url: item.url || null,
          data: null,
          format: 'png',
          width: 1024,
          height: 1024,
        });
      }
    } else if (resp.data?.data) {
      for (const item of resp.data.data) {
        images.push({
          url: item.url || null,
          data: item.b64_json ? Buffer.from(item.b64_json, 'base64') : null,
          format: 'png',
          width: 1024,
          height: 1024,
        });
      }
    }
    return {
      images,
      model: request.model || this.defaultModel,
      metadata: {},
    };
  }

  listModels(): string[] {
    return [
      'stabilityai/stable-diffusion-xl-base-1.0',
      'stabilityai/stable-diffusion-3-medium',
      'black-forest-labs/FLUX.1-schnell',
    ];
  }
}

/**
 * Volcengine（火山引擎）图片提供商
 * 端点：{baseUrl}/2022-08-31/cv/v1/aigc_high_aes
 */
export class VolcengineImageProvider implements ImageProvider {
  id = 'volcengine';
  name = 'Volcengine';
  accessKey: string;
  secretKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
    _logger: LoggerService,
  ) {
    this.accessKey =
      (typeof config['accessKey'] === 'string' && config['accessKey']) ||
      process.env['VOLCENGINE_ACCESS_KEY'] ||
      '';
    this.secretKey =
      (typeof config['secretKey'] === 'string' && config['secretKey']) ||
      process.env['VOLCENGINE_SECRET_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://visual.volcengineapi.com';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) ||
      'high_aes_general_v21';
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.accessKey || !this.secretKey) {
      throw new Error('Volcengine credentials not configured');
    }
    const body = {
      req_key: 'high_aes',
      model: request.model || this.defaultModel,
      prompt: request.prompt,
      return_url: true,
      logo_info: { add_logo: false },
    };
    const resp = await this.http.post<{
      data?: { image_urls?: string[] };
      request_id?: string;
    }>(this.baseUrl + '/2022-08-31/cv/v1/aigc_high_aes', body, {
      responseType: 'json',
      // 生图为长耗时操作，默认 30s 超时会误杀（对齐 OpenAI provider 的 180s）
      timeout: 180_000,
    });
    const images: GeneratedImage[] = [];
    if (resp.data?.data?.image_urls) {
      for (const u of resp.data.data.image_urls) {
        images.push({
          url: u,
          data: null,
          format: 'png',
          width: 1024,
          height: 1024,
        });
      }
    }
    return {
      images,
      model: request.model || this.defaultModel,
      metadata: { requestId: resp.data?.request_id },
    };
  }

  listModels(): string[] {
    return ['high_aes_general_v21', 'high_aes_anime_v22', 'high_aes_general_v20_L'];
  }
}

/**
 * OpenAI 兼容图片提供商（自定义端点）
 * 端点：{baseUrl}/images/generations
 */
export class OpenAICompatibleImageProvider implements ImageProvider {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
    _logger: LoggerService,
  ) {
    this.id = (typeof config['id'] === 'string' && config['id']) || 'openai-compatible';
    this.name = (typeof config['name'] === 'string' && config['name']) || 'OpenAI-Compatible';
    this.apiKey = (typeof config['apiKey'] === 'string' && config['apiKey']) || '';
    this.baseUrl = (typeof config['baseUrl'] === 'string' && config['baseUrl']) || '';
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'default';
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.baseUrl) {
      throw new Error('Base URL not configured for OpenAI-compatible provider');
    }
    const model = request.model || this.defaultModel;
    const body = {
      model,
      prompt: request.prompt,
      n: request.count || 1,
      size: request.size || '1024x1024',
      ...(/^gpt-image/i.test(model) ? {} : { response_format: 'b64_json' }),
    };
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;
    const resp = await this.http.post<{
      data?: Array<{ url?: string; b64_json?: string }>;
    }>(this.baseUrl + '/images/generations', body, {
      headers,
      responseType: 'json',
      // 生图为长耗时操作，默认 30s 超时会误杀（对齐 OpenAI provider 的 180s）
      timeout: 180_000,
    });
    const images: GeneratedImage[] = [];
    if (resp.data?.data) {
      for (const item of resp.data.data) {
        images.push({
          url: item.url || null,
          data: item.b64_json ? Buffer.from(item.b64_json, 'base64') : null,
          format: 'png',
          width: 1024,
          height: 1024,
        });
      }
    }
    return {
      images,
      model: request.model || this.defaultModel,
      metadata: {},
    };
  }

  listModels(): string[] {
    return [this.defaultModel];
  }
}

/**
 * DashScope 通义万相 2.7 图片提供商（wan2.7-image / wan2.7-image-pro）
 * 端点：{baseUrl}/services/aigc/multimodal-generation/generation（同步多模态协议）
 * 请求为 messages 数组格式，响应 output.choices[].message.content[].image 为图片 URL。
 * 与 LLM 供应商 qwen 共用 DashScope API key，可自动派生。
 */
export class DashScopeImageProvider implements ImageProvider {
  id = 'dashscope';
  name = 'DashScope (通义万相 2.7)';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  constructor(
    config: ProviderConfig,
    private readonly http: HttpClientService,
    _logger: LoggerService,
  ) {
    this.apiKey =
      (typeof config['apiKey'] === 'string' && config['apiKey']) ||
      process.env['DASHSCOPE_API_KEY'] ||
      '';
    this.baseUrl =
      (typeof config['baseUrl'] === 'string' && config['baseUrl']) ||
      'https://dashscope.aliyuncs.com/api/v1';
    // wan2.7-image 速度优先；pro 版（4K）可经 model 参数指定
    this.defaultModel =
      (typeof config['model'] === 'string' && config['model']) || 'wan2.7-image';
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.apiKey) {
      throw new Error('DashScope API key not configured');
    }
    // DashScope 要求 size 格式为 "W*H"（星号分隔），外部习惯 "WxH"（字母x）需归一化，
    // 否则 HTTP 400 InvalidParameter: Invalid size format
    const normSize = request.size
      ? request.size.trim().replace(/[xX\u00d7]/, '*').replace(/\s+/g, '')
      : '';
    const body = {
      model: request.model || this.defaultModel,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: request.prompt }],
          },
        ],
      },
      ...(normSize
        ? { parameters: { size: normSize } }
        : {}),
    };
    const resp = await this.http.post<{
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ image?: string }> };
        }>;
        // 容错：部分版本响应结构差异
        results?: Array<{ url?: string }>;
      };
      request_id?: string;
      code?: string;
      message?: string;
    }>(this.baseUrl + '/services/aigc/multimodal-generation/generation', body, {
      headers: { Authorization: 'Bearer ' + this.apiKey },
      responseType: 'json',
      // 同步生成耗时较长（万相2.7 约 5-30s），放宽超时
      timeout: 120_000,
    });

    // HttpClientService 不抛 4xx/5xx（静默 resolve），必须显式检查状态码，
    // 否则错误结构被当作空响应吞掉，上层只看到"提供商未返回任何图像"
    if (resp.status >= 400) {
      const errBody = resp.data as unknown as { code?: string; message?: string };
      throw new Error(
        `DashScope API ${resp.status}${errBody?.code ? ` ${errBody.code}` : ''}: ${errBody?.message ?? 'request failed'}`,
      );
    }

    const images: GeneratedImage[] = [];
    const choices = resp.data?.output?.choices;
    if (choices && choices.length > 0) {
      const content = choices[0].message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.image) {
            images.push({
              url: part.image,
              data: null,
              format: 'png',
              width: 1024,
              height: 1024,
            });
          }
        }
      }
    }
    // 降级解析 results 结构
    if (images.length === 0 && Array.isArray(resp.data?.output?.results)) {
      for (const r of resp.data.output.results) {
        if (r.url) {
          images.push({
            url: r.url,
            data: null,
            format: 'png',
            width: 1024,
            height: 1024,
          });
        }
      }
    }
    return {
      images,
      model: request.model || this.defaultModel,
      metadata: { requestId: resp.data?.request_id },
    };
  }

  listModels(): string[] {
    return ['wan2.7-image', 'wan2.7-image-pro'];
  }
}

// ============================================================
// 图片提供商注册表服务
// ============================================================

/** 已知图片提供商 ID 列表（用于 listImageProviders 展示） */
const KNOWN_IMAGE_PROVIDERS = ['openai', 'siliconflow', 'volcengine', 'dashscope', 'ark', 'stability', 'replicate', 'minimax', 'local'];

/** 模型名推断路由 → 厂商显示名（用于未配置对应厂商 key 时的报错提示） */
const INFERRED_IMAGE_PROVIDER_NAMES: Record<string, string> = {
  dashscope: '通义千问',
  ark: '火山豆包',
  openai: 'OpenAI',
  siliconflow: '硅基流动',
};

/**
 * 根据生成模型名推断图片提供商 ID（统一模型体系路由）。
 *
 * AI 传 model 名即可自动路由到对应媒体厂商：
 *   - wan/wanx 开头（通义万相系列）→ dashscope
 *   - 含 seedream（火山 Seedream 系列）→ ark
 *   - 含 seedance / doubao-seedance（火山 Seedance 系列）→ ark
 *   - gpt-image / dall-e 开头 → openai
 *   - 含 flux / stable-diffusion / stabilityai / black-forest（如 FLUX.1-schnell）→ siliconflow
 *   - 无匹配返回 null（走默认提供商回退链）
 */
export function inferImageProviderId(model?: string): string | null {
  if (!model) return null;
  if (/^(wan|wanx)/i.test(model)) return 'dashscope';
  if (/seedream/i.test(model)) return 'ark';
  if (/seedance|doubao-seedance/i.test(model)) return 'ark';
  if (/^gpt-image|^dall-e/i.test(model)) return 'openai';
  if (/flux|stable-diffusion|stabilityai|black-forest|qwen-image|kolors/i.test(model)) return 'siliconflow';
  return null;
}

/**
 * ImageProviderService - 图片提供商注册表
 *
 * 职责：
 *   - 注册/管理图片生成提供商
 *   - 按提供商 ID 调度 generateImage
 *   - 列出可用提供商与模型
 *
 * 全量移植自 media-manager.cjs 图片生成注册表段落。
 */
@Injectable()
export class ImageProviderService {
  private readonly providers: Record<string, ImageProvider> = {};
  private defaultProvider: string | null = null;

  constructor(
    _http: HttpClientService,
    private readonly logger: LoggerService,
  ) {}

  /** 注册图片提供商 */
  registerProvider(id: string, provider: ImageProvider): void {
    if (!id || typeof id !== 'string') {
      throw new Error('Image provider ID must be a non-empty string');
    }
    if (!provider || typeof provider.generate !== 'function') {
      throw new Error('Image provider must implement generate()');
    }
    this.providers[id] = provider;
    if (!this.defaultProvider) {
      this.defaultProvider = id;
    }
    this.logger.info('Registered image provider: ' + id);
  }

  /** 设置默认图片提供商 */
  clearProviders(): void { for (const id of Object.keys(this.providers)) delete this.providers[id]; this.defaultProvider=null; }
  setDefaultProvider(id: string): void {
    this.defaultProvider = id;
  }

  /** 是否已注册任意图片提供商（供自动派生判断：无手动配置时才派生） */
  hasProviders(): boolean {
    return Object.keys(this.providers).length > 0;
  }
  supportsImageInput(id:string):boolean {return this.providers[id]?.supportsImageInput===true;}

  /**
   * 生成图片：统一模型体系路由调度
   * 解析顺序：request.provider → inferImageProviderId(request.model)
   * （命中且已注册才用；命中但未注册时明确报错指明需配置哪家厂商 key，而非静默回退
   * ——回退到其他厂商会以错误模型调用）→ 默认提供商 → 第一个已注册
   */
  async generateImage(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const req = request || ({} as ImageGenerateRequest);
    let provider: ImageProvider | undefined = req.provider
      ? this.providers[req.provider]
      : undefined;
    if (req.provider && !provider) throw new Error('Unknown image provider: ' + req.provider);
    if (!provider && req.model) {
      const inferred = inferImageProviderId(req.model);
      if (inferred) {
        provider = this.providers[inferred];
        if (!provider) {
          throw new Error(
            `模型 ${req.model} 需要配置 ${INFERRED_IMAGE_PROVIDER_NAMES[inferred] ?? inferred} 供应商 API key`,
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
        throw new Error('No image provider available');
      }
    }
    if (!req.prompt) {
      throw new Error('Image generation prompt is required');
    }
    if(req.inputImages?.length && !provider.supportsImageInput)throw new Error('This image provider has no image editing adapter configured');
    this.logger.info('Generating image with provider: ' + provider.id);
    try {
      return await provider.generate(req);
    } catch (err) {
      this.logger.error('Image generation failed with ' + provider.id + ': ' + (err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** 列出所有图片提供商（含未配置的已知项） */
  listImageProviders(): Array<{
    id: string;
    name: string;
    type: string;
    isDefault: boolean;
    status: string;
  }> {
    const result: Array<{ id: string; name: string; type: string; isDefault: boolean; status: string }> = [];
    const keys = Object.keys(this.providers);
    for (const k of new Set([...KNOWN_IMAGE_PROVIDERS, ...keys])) {
      const registered = keys.indexOf(k) >= 0;
      result.push({
        id: k,
        name: registered ? (this.providers[k].name || k) : k,
        type: 'image',
        isDefault: k === this.defaultProvider,
        status: registered ? 'available' : 'unconfigured',
      });
    }
    return result;
  }

  /** 列出指定提供商支持的模型 */
  listImageModels(providerId?: string): string[] {
    const provider = this.providers[providerId || this.defaultProvider || ''];
    if (!provider) return [];
    if (typeof provider.listModels === 'function') {
      return provider.listModels();
    }
    return [];
  }
}
