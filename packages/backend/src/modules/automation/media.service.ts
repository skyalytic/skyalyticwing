import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { PROVIDERS_REGISTRY } from '../ai/llm/provider.service.js';
import { CatalogImageProvider, CatalogVideoProvider } from './catalog-media.providers.js';
import { HttpClientService } from '../core/http/http-client.service.js';
import { ConfigService } from '../core/config/config.service.js';
import { LoggerService } from '../core/logger/logger.service.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import {
  ImageProviderService,
  OpenAIImageProvider,
  SiliconFlowImageProvider,
  VolcengineImageProvider,
  OpenAICompatibleImageProvider,
  DashScopeImageProvider,
  type ProviderConfig,
} from './image-provider.service.js';
import {
  VideoProviderService,
  RunwayVideoProvider,
  PikaVideoProvider,
  DashScopeVideoProvider,
  LocalFFmpegVideoProvider,
  ArkVideoProvider,
} from './video-provider.service.js';

// ============================================================
// LLM 供应商 → 媒体生成派生映射表
// ============================================================

/** 单条派生规则：LLM 供应商 id → 图片/视频生成能力（同凭证体系才可派生） */
interface MediaDerivation {
  /** 设置页模型供应商 id（provider.service.ts 注册表） */
  llmId: string;
  /** apiKey 环境变量兜底（按顺序尝试） */
  envKeys: string[];
  /** 该供应商默认对话模型前缀（用于默认媒体提供商跟随默认对话模型） */
  modelPrefixes: string[];
  /** 图片派生配置（null = 该厂商不支持生图） */
  image: { id: string; name: string; baseUrl: string; model: string } | null;
  /** 视频派生配置（null = 该厂商不支持生视频） */
  video: { id: string; model: string } | null;
}

/**
 * 可自动派生的厂商清单（LLM key 与媒体生成同一凭证体系，默认模型取各家最新正式版）：
 *   - openai      → gpt-image-1.5（/images/generations；DALL-E 2/3 已于 2026-05 停服）
 *   - qwen        → 通义万相 wan2.7（图 multimodal-generation 同步 / 视频 video-synthesis 异步）
 *   - doubao      → 火山方舟 Seedream 4.5（图）/ Seedance 2.0（视频，异步任务）
 *   - siliconflow → Flux / Stable Diffusion（/images/generations）
 * 不支持生成或独立凭证体系的厂商（glm/deepseek/moonshot/kimi/runway/pika 等）
 * 不在此表：runway/pika 为纯视频厂商（无对话模型），需在 automation.media.video 手动配置。
 */
const MEDIA_DERIVATIONS: MediaDerivation[] = [
  {
    llmId: 'openai',
    envKeys: ['OPENAI_API_KEY'],
    modelPrefixes: ['gpt-', 'o3', 'o4', 'gpt-image'],
    image: { id: 'openai', name: 'OpenAI GPT Image', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1.5' },
    video: null,
  },
  {
    llmId: 'qwen',
    envKeys: ['DASHSCOPE_API_KEY'],
    modelPrefixes: ['qwen', 'qwq', 'qvq', 'wan'],
    image: { id: 'dashscope', name: 'DashScope (通义万相 2.7)', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-image' },
    video: { id: 'dashscope', model: 'wan2.6-t2v' },
  },
  {
    llmId: 'doubao',
    envKeys: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
    modelPrefixes: ['doubao', 'seedream', 'seedance'],
    image: { id: 'ark', name: '火山方舟 (Seedream)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128' },
    video: { id: 'ark', model: 'doubao-seedance-2-5-260628' },
  },
  {
    llmId: 'siliconflow',
    envKeys: ['SILICONFLOW_API_KEY'],
    modelPrefixes: ['qwen/qwen', 'deepseek-ai', 'thudm/glm', 'black-forest', 'stabilityai'],
    image: { id: 'siliconflow', name: 'SiliconFlow (Flux/SD)', baseUrl: 'https://api.siliconflow.cn/v1', model: 'black-forest-labs/FLUX.1-schnell' },
    video: null,
  },
];

// ============================================================
// 平台标识
// ============================================================

const PLAT = platform();
const IS_WIN = PLAT === 'win32';

// ============================================================
// 类型定义 - 资产管理
// ============================================================

/** 资产记录 */
export interface AssetRecord {
  id: string;
  filename: string;
  format: string;
  filePath: string;
  size: number;
  createdAt: number;
  url: string;
}

// ============================================================
// MediaService - 媒体处理主服务
// ============================================================

/**
 * MediaService - 媒体处理主服务
 *
 * 职责：
 *   1. 代理图片与视频生成至 ImageProviderService / VideoProviderService
 *   2. LLM 供应商 key 自动派生媒体提供商（MEDIA_DERIVATIONS 映射表）
 *   3. 资产管理：保存/获取/列出/删除/URL 生成
 *
 * 移植自 packages/web/media-manager.cjs。
 * （旧版的音乐生成 / 媒体理解（图片/视频/音频分析）链路已随旧媒体套件清理移除，
 *  现仅承载统一模型体系的图片/视频 API 生成。）
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private dataDir: string = '';
  private assetIndexFile: string = '';
  private assets: Record<string, AssetRecord> = {};
  private providerRevision = '';
  private optionalConfig(section:string):Record<string,any> { try { return this.config.get<Record<string,any>>(section) || {}; } catch { return {}; } }
  private generationBindings: Array<{kind:'image'|'video';id:string;providerId:string;providerName:string;traits:string}> = [];

  /** Rebuild on configuration changes, including key rotation and deletion. */
  private refreshProviders(): void {
    const saved = this.optionalConfig('providers');
    const manual = this.optionalConfig('automation')['media'] || {};
    const environment = MEDIA_DERIVATIONS.map(d=>d.envKeys.map(k=>process.env[k]||''));
    const revision = createHash('sha256').update(JSON.stringify([saved,manual,environment])).digest('hex');
    if (revision === this.providerRevision) return;
    this.imageProviders.clearProviders(); this.videoProviders.clearProviders(); this.generationBindings=[];
    this.registerImageProvidersFromConfig(manual); this.registerVideoProvidersFromConfig(manual);
    for (const p of this.imageProviders.listImageProviders().filter(p=>p.status==='available')) {
      for(const model of this.imageProviders.listImageModels(p.id))this.generationBindings.push({kind:'image',id:model,providerId:p.id,providerName:p.name,traits:'Configured image API'});
    }
    for (const p of this.videoProviders.listVideoProviders().filter(p=>p.status==='available')) {
      const model=this.videoProviders.resolveProvider({provider:p.id,prompt:''}).defaultModel;
      if(model)this.generationBindings.push({kind:'video',id:model,providerId:p.id,providerName:p.name,traits:'Configured video API'});
    }
    const entries = {...saved};
    for (const d of MEDIA_DERIVATIONS) if (!entries[d.llmId]) {
      const key=d.envKeys.map(k=>process.env[k]).find(Boolean);
      if(key)entries[d.llmId]={apiKey:key};
    }
    for (const [id, entry] of Object.entries(entries) as Array<[string,Record<string,any>]>) {
      if (!entry?.['apiKey'] && !entry?.['baseUrl']) continue;
      const base=entry['baseProvider'] || id;
      const reg=PROVIDERS_REGISTRY.find(p=>p.id===base);
      const derivation=MEDIA_DERIVATIONS.find(d=>d.llmId===base);
      for (const kind of ['image','video'] as const) {
        const explicit=entry[kind+'Protocol'];
        if (explicit==='none') continue;
        const protocol=explicit || (kind==='image'?reg?.imageProtocol:reg?.videoProtocol) || (kind==='image' ? (base==='qwen'?'dashscope':derivation?.image?'openai-compatible':'') : derivation?.video?.id);
        const registryModels=kind==='image'?reg?.imageModels:reg?.videoModels;
        const declared=entry[kind+'Models'];
        const models:string[]=Array.isArray(declared)?declared:registryModels?.map(m=>m.id)||[];
        if (!protocol || protocol==='none' || !models.length) continue;
        const providerId=id===base ? (derivation?.[kind]?.id || id) : id;
        if(this.generationBindings.some(b=>b.kind===kind && b.providerId===providerId))continue;
        // A custom proxy must retain its own credentials and host. Only substitute
        // native media URLs when the chat URL still matches the official preset.
        const customRoot=entry['baseUrl'] && entry['baseUrl'].replace(/\/$/,'')!==reg?.baseUrl.replace(/\/$/,'');
        const root=entry[kind+'BaseUrl'] || (customRoot ? entry['baseUrl'] : (kind==='image'?reg?.imageBaseUrl:reg?.videoBaseUrl) || entry['baseUrl']) || derivation?.image?.baseUrl;
        // Only the official DashScope OpenAI-compatibility URL has a known media equivalent.
        const baseUrl=protocol==='dashscope' && root?.includes('dashscope.aliyuncs.com/compatible-mode') ? 'https://dashscope.aliyuncs.com/api/v1' : root;
        const cfg={apiKey:entry['apiKey'],baseUrl,model:models[0],id:providerId,name:entry['displayName']||reg?.name||id};
        if(kind==='image') {
          const provider=protocol==='dashscope'?new DashScopeImageProvider(cfg,this.http,this.logger)
            :protocol==='openai-images'?new OpenAIImageProvider(cfg,this.http,this.logger)
            :['gemini','minimax','xai','zhipu','siliconflow','ideogram'].includes(protocol)?new CatalogImageProvider(protocol as 'gemini'|'minimax'|'xai'|'zhipu'|'siliconflow'|'ideogram',cfg,this.http)
            :protocol==='openai-compatible'?new OpenAICompatibleImageProvider(cfg,this.http,this.logger):null;
          if(!provider)continue;
          provider.listModels = () => [...models];
          provider.id=providerId; this.imageProviders.registerProvider(providerId,provider);
        } else {
          const provider=protocol==='dashscope'?new DashScopeVideoProvider(cfg,this.http):protocol==='ark'?new ArkVideoProvider(cfg,this.http):protocol==='runway'?new RunwayVideoProvider(cfg,this.http):protocol==='pika'?new PikaVideoProvider(cfg,this.http):['minimax','xai'].includes(protocol)?new CatalogVideoProvider(protocol as 'minimax'|'xai',cfg,this.http):null;
          if(!provider)continue;
          provider.id=providerId;this.videoProviders.registerProvider(providerId,provider);
        }
        for(const model of models)this.generationBindings.push({kind,id:model,providerId,providerName:cfg.name,traits:registryModels?.find(m=>m.id===model)?.traits || '用户配置的生成模型'});
      }
    }
    this.providerRevision=revision;
  }

  generationCatalog(kind:'image'|'video') {
    this.refreshProviders();
    return this.generationBindings.filter(b=>b.kind===kind);
  }

  private routeGeneration(kind:'image'|'video',request:{provider?:string;model?:string;preferredModel?:string;inputImages?:string[]}):void {
    this.refreshProviders();
    const general=this.optionalConfig('general');
    const allBindings=this.generationBindings.filter(b=>b.kind===kind);
    const bindings=allBindings.filter(b=>kind!=='image'||!request.inputImages?.length||this.imageProviders.supportsImageInput(b.providerId));
    if(kind==='image' && request.inputImages?.length) {
      const specified=allBindings.find(b=>(!request.provider||b.providerId===request.provider)&&(request.model===b.id||request.model===b.providerId+'::'+b.id));
      if(specified && !this.imageProviders.supportsImageInput(specified.providerId)){delete request.provider;delete request.model;}
    }
    const preferredMatches=bindings.some(b=>b.id===request.preferredModel || b.providerId+'::'+b.id===request.preferredModel);
    const selected=(preferredMatches?request.preferredModel:undefined) || general[kind==='image'?'defaultImageModel':'defaultVideoModel'] || request.preferredModel || general['defaultModel'] || '';
    if(request.model?.includes('::')) {const [provider,...model]=request.model.split('::');request.provider=provider;request.model=model.join('::');}
    const selectedBinding=bindings.find(b=>b.id===selected || b.providerId+'::'+b.id===selected);
    if(selectedBinding && !request.provider && !request.model) {request.provider=selectedBinding.providerId;request.model=selectedBinding.id;return;}
    const alias=MEDIA_DERIVATIONS.find(d=>d.llmId===request.provider)?.[kind]?.id;
    if(alias)request.provider=alias;
    const own=bindings.filter(b=>(!request.provider||b.providerId===request.provider) && (!request.model||b.id===request.model));
    if(request.model && !request.provider && own.length>1)throw new Error('Multiple providers configure this model; choose provider::model');
    if(own.length){
      const source=String(selected).split('::')[0];
      const owner=Object.entries(this.optionalConfig('providers')).find(([id,p])=>id===source || p['models']?.includes(source))?.[0];
      const match=own.find(b=>b.id===selected || b.providerId===owner || b.providerId===MEDIA_DERIVATIONS.find(d=>d.llmId===owner)?.[kind]?.id) || own[0]!;
      request.provider=match.providerId;request.model=match.id;return;
    }
    // Missing capability must not reroute an already submitted request.
    if(request.provider || request.model)throw new Error('Requested '+kind+' model is not configured');
    throw new Error('Required '+kind+' capability is not configured. Configure your API.');
  }

  constructor(
    private readonly http: HttpClientService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
    private readonly imageProviders: ImageProviderService,
    private readonly videoProviders: VideoProviderService,
  ) {}

  onModuleInit(): void {
    this.initFromConfig();
  }

  /** 从 ConfigService 读取 media 配置并初始化（幂等） */
  private initFromConfig(): void {
    this.dataDir = this.resolveDataDir();
    try {
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    } catch (err) {
      this.logger.error('Failed to create media data directory: ' + (err instanceof Error ? err.message : String(err)));
    }
    // 媒体数据目录注册进 PathGuard（readwrite）：
    // 图片/视频/PDF 等生成产物落 <dataDir>/generated（持久化，更新不清空），
    // 未注册则写入与 /api/files/serve 读取都会被路径白名单拦截
    try {
      this.security.addAllowedPath(this.dataDir, 'readwrite');
    } catch (err) {
      this.logger.warn('Failed to register media dataDir to path guard: ' + (err instanceof Error ? err.message : String(err)));
    }
    this.assetIndexFile = join(this.dataDir, 'asset-index.json');
    this.loadAssetIndex();

    // 读取 media 配置段（容错：automation.media 或 media 段不存在时跳过）
    let mediaConfig: Record<string, unknown> = {};
    try {
      const automation = this.config.get<Record<string, unknown>>('automation');
      const mc = automation['media'];
      if (mc && typeof mc === 'object' && !Array.isArray(mc)) {
        mediaConfig = mc as Record<string, unknown>;
      }
    } catch {
      // automation 段未配置，使用空配置
    }

    this.registerImageProvidersFromConfig(mediaConfig);
    this.registerVideoProvidersFromConfig(mediaConfig);

    // 自动派生：未手动配置媒体提供商时，复用 LLM 供应商（通义千问 qwen）的
    // apiKey 注册 DashScope 图片/视频提供商（通义万相 wan 系列），
    // 用户只需配置一次通义千问 API 即可在对话中自动生成图片/视频
    this.deriveProvidersFromLlmProviders();

    this.logger.info('MediaService initialized (dataDir: ' + this.dataDir + ')');
  }

  /**
   * 从 LLM 供应商配置自动派生媒体提供商（多厂商映射表驱动）。
   *
   * 派生规则（仅在该类提供商无任何手动配置时生效，不覆盖 automation.media 配置）：
   *   - 遍历 MEDIA_DERIVATIONS 映射表，凡设置页已配置 apiKey（或环境变量兜底命中）
   *     的厂商全部派生注册 → 用户配置多个可用 API 时全部生效，AI 可经 provider/model 参数选择
   *   - 默认提供商三级优先（统一模型体系）：
   *     1. general.defaultImageModel / general.defaultVideoModel（前端选择生成模型时写入）
   *        前缀匹配 MEDIA_DERIVATIONS 所属厂商
   *     2. general.defaultModel（默认对话模型）前缀匹配（原有行为）
   *     3. 第一个已派生
   */
  private deriveProvidersFromLlmProviders(): void {
    // 读取已保存的 LLM 供应商 key
    let saved: Record<string, unknown> = {};
    try {
      saved = this.config.get<Record<string, unknown>>('providers') ?? {};
    } catch {
      // providers 段未配置，仅靠环境变量兜底
    }

    const derivedImageIds: string[] = [];
    const derivedVideoIds: string[] = [];
    const derivedLlmIds: string[] = [];
    // 手动配置基线：automation.media 已手动注册的类不派生（不覆盖用户显式配置）。
    // 基线在循环外读取一次——循环内注册后 hasProviders() 会变 true，
    // 若循环内判断会误伤后续厂商的派生（多厂商需全部注册）
    const manualImage = this.imageProviders.hasProviders();
    const manualVideo = this.videoProviders.hasProviders();

    for (const d of MEDIA_DERIVATIONS) {
      // key 来源：设置页 providers 段 → 环境变量兜底
      let apiKey = '';
      const entry = saved[d.llmId] as Record<string, unknown> | undefined;
      if (entry && typeof entry['apiKey'] === 'string' && entry['apiKey']) {
        apiKey = entry['apiKey'];
      }
      if (!apiKey) {
        for (const envKey of d.envKeys) {
          if (process.env[envKey]) {
            apiKey = process.env[envKey] as string;
            break;
          }
        }
      }
      if (!apiKey) continue;
      derivedLlmIds.push(d.llmId);

      // 图片派生（该厂商支持生图且用户未手动配置图片提供商）
      if (d.image && !manualImage) {
        const cfg: ProviderConfig & Record<string, unknown> = {
          apiKey,
          baseUrl: d.image.baseUrl,
          model: d.image.model,
        };
        if (d.llmId === 'openai') {
          this.imageProviders.registerProvider(
            d.image.id,
            new OpenAIImageProvider(cfg, this.http, this.logger),
          );
        } else if (d.llmId === 'siliconflow') {
          this.imageProviders.registerProvider(
            d.image.id,
            new SiliconFlowImageProvider(cfg, this.http, this.logger),
          );
        } else if (d.llmId === 'qwen') {
          // 通义万相 wan2.7 走 DashScope 多模态同步端点（非 OpenAI 兼容协议）
          this.imageProviders.registerProvider(
            d.image.id,
            new DashScopeImageProvider(cfg, this.http, this.logger),
          );
        } else {
          // doubao(ark) 走 OpenAI 兼容 /images/generations
          this.imageProviders.registerProvider(
            d.image.id,
            new OpenAICompatibleImageProvider(
              { ...cfg, id: d.image.id, name: d.image.name },
              this.http,
              this.logger,
            ),
          );
        }
        derivedImageIds.push(d.image.id);
        this.logger.info(`Media: auto-derived image provider '${d.image.id}' from llm provider '${d.llmId}'`);
      }

      // 视频派生（该厂商支持生视频且用户未手动配置视频提供商）
      if (d.video && !manualVideo) {
        if (d.llmId === 'qwen') {
          this.videoProviders.registerProvider(
            d.video.id,
            new DashScopeVideoProvider({ apiKey, model: d.video.model }, this.http),
          );
        } else if (d.llmId === 'doubao') {
          this.videoProviders.registerProvider(
            d.video.id,
            new ArkVideoProvider({ apiKey, model: d.video.model }, this.http),
          );
        }
        derivedVideoIds.push(d.video.id);
        this.logger.info(`Media: auto-derived video provider '${d.video.id}' from llm provider '${d.llmId}'`);
      }
    }

    if (derivedLlmIds.length === 0) return;

    // 默认提供商三级优先：defaultImageModel/defaultVideoModel → defaultModel → 第一个已派生
    let general: Record<string, unknown> = {};
    try {
      general = this.config.get<Record<string, unknown>>('general') ?? {};
    } catch {
      // general 段不存在，忽略
    }

    /**
     * 按候选模型名优先级解析默认媒体提供商 id：
     * 逐个候选按 modelPrefixes 前缀匹配所属厂商，命中且其媒体提供商已派生才采用
     * （模型指向的厂商未配置 key 时跳过该候选，继续尝试下一级），全部未命中返回 undefined
     */
    const pickDefaultMediaId = (
      candidates: unknown[],
      pick: (d: MediaDerivation) => string | undefined,
      derivedIds: string[],
    ): string | undefined => {
      for (const cand of candidates) {
        if (typeof cand !== 'string' || !cand) continue;
        const m = cand.toLowerCase();
        for (const d of MEDIA_DERIVATIONS) {
          if (!d.modelPrefixes.some((p) => m.startsWith(p))) continue;
          const id = pick(d);
          if (id && derivedIds.includes(id)) return id;
        }
      }
      return undefined;
    };

    const imageDefault =
      pickDefaultMediaId(
        [general['defaultImageModel'], general['defaultModel']],
        (d) => d.image?.id,
        derivedImageIds,
      ) ?? derivedImageIds[0];
    if (imageDefault) this.imageProviders.setDefaultProvider(imageDefault);

    const videoDefault =
      pickDefaultMediaId(
        [general['defaultVideoModel'], general['defaultModel']],
        (d) => d.video?.id,
        derivedVideoIds,
      ) ?? derivedVideoIds[0];
    if (videoDefault) this.videoProviders.setDefaultProvider(videoDefault);
  }

  // ============================================================
  // 配置注册
  // ============================================================

  /** 从配置注册图片提供商 */
  private registerImageProvidersFromConfig(mediaConfig: Record<string, unknown>): void {
    const imageCfg = mediaConfig['image'];
    if (!imageCfg || typeof imageCfg !== 'object' || Array.isArray(imageCfg)) return;
    const ic = imageCfg as Record<string, ProviderConfig>;
    if (ic['openai']) {
      this.imageProviders.registerProvider('openai', new OpenAIImageProvider(ic['openai'], this.http, this.logger));
    }
    if (ic['siliconflow']) {
      this.imageProviders.registerProvider('siliconflow', new SiliconFlowImageProvider(ic['siliconflow'], this.http, this.logger));
    }
    if (ic['volcengine']) {
      this.imageProviders.registerProvider('volcengine', new VolcengineImageProvider(ic['volcengine'], this.http, this.logger));
    }
    if (ic['custom']) {
      const customCfg = ic['custom'] as ProviderConfig;
      this.imageProviders.registerProvider(
        (typeof customCfg['id'] === 'string' && customCfg['id']) || 'openai-compatible',
        new OpenAICompatibleImageProvider(customCfg, this.http, this.logger),
      );
    }
    if (typeof ic['defaultProvider'] === 'string') {
      this.imageProviders.setDefaultProvider(ic['defaultProvider']);
    }
  }

  /** 从配置注册视频提供商 */
  private registerVideoProvidersFromConfig(mediaConfig: Record<string, unknown>): void {
    const videoCfg = mediaConfig['video'];
    if (!videoCfg || typeof videoCfg !== 'object' || Array.isArray(videoCfg)) return;
    const vc = videoCfg as Record<string, ProviderConfig>;
    if (vc['runway']) {
      this.videoProviders.registerProvider('runway', new RunwayVideoProvider(vc['runway'], this.http));
    }
    if (vc['pika']) {
      this.videoProviders.registerProvider('pika', new PikaVideoProvider(vc['pika'], this.http));
    }
    if (vc['dashscope']) {
      this.videoProviders.registerProvider('dashscope', new DashScopeVideoProvider(vc['dashscope'], this.http));
    }
    if (vc['ffmpeg']) {
      this.videoProviders.registerProvider('local-ffmpeg', new LocalFFmpegVideoProvider(vc['ffmpeg'], this.security, this.dataDir));
    }
    if (typeof vc['defaultProvider'] === 'string') {
      this.videoProviders.setDefaultProvider(vc['defaultProvider']);
    }
  }

  /** 获取数据目录 */
  getDataDir(): string {
    return this.dataDir;
  }

  // ============================================================
  // 图片生成（代理至 ImageProviderService）
  // ============================================================

  async generateImage(request: import('./image-provider.service.js').ImageGenerateRequest) {
    await this.authorizeGeneration('image',request);
    // 惰性派生：启动后才在设置页配置通义千问(qwen)的场景，无需重启即生效
    this.routeGeneration('image', request);
    return this.imageProviders.generateImage(request);
  }

  listImageProviders() {
    // 惰性派生兜底：启动后才配置 LLM 供应商的场景，首次查询前派生，
    // 保证工具描述（getter 动态读取）看到的可用厂商清单始终准确
    this.refreshProviders();
    return this.imageProviders.listImageProviders();
  }

  listImageModels(providerId?: string) {
    return this.imageProviders.listImageModels(providerId);
  }

  // ============================================================
  // 视频生成（代理至 VideoProviderService）
  // ============================================================

  async generateVideo(request: import('./video-provider.service.js').VideoGenerateRequest) {
    await this.authorizeGeneration('video',request);
    // 惰性派生：同 generateImage（启动后配置 qwen 无需重启）
    this.routeGeneration('video', request);
    return this.videoProviders.generateVideo(request);
  }

  resolveVideoProvider(request: import('./video-provider.service.js').VideoGenerateRequest) {
    this.routeGeneration('video', request);
    return this.videoProviders.resolveProvider(request);
  }

  async authorizeGeneration(kind:'image'|'video',request:{provider?:string;model?:string;preferredModel?:string}={}):Promise<void> {
    this.routeGeneration(kind,request);
  }
  authorizeGenerationSync(kind:'image'|'video',request:{provider?:string;model?:string;preferredModel?:string}={}):void {
    this.routeGeneration(kind,request);
  }

  getVideoTaskDirectory(): string {
    return join(this.dataDir || this.resolveDataDir(), 'video-tasks');
  }

  listVideoProviders() {
    // 惰性派生兜底：同 listImageProviders
    this.refreshProviders();
    return this.videoProviders.listVideoProviders();
  }

  // ============================================================
  // 资产管理
  // ============================================================

  /** 保存资产到磁盘并登记到索引 */
  saveAsset(data: Buffer | string | Record<string, unknown>, filename?: string, format?: string): AssetRecord {
    if (!this.dataDir) {
      throw new Error('Media manager not initialized');
    }
    const assetDir = join(this.dataDir, 'assets');
    try {
      if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
    } catch {
      // 忽略
    }

    const assetId = randomUUID();
    const ext = format || extname(filename || '').replace('.', '') || 'bin';
    const safeName = (filename || 'asset-' + Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = join(assetDir, assetId + '-' + safeName);

    try {
      if (Buffer.isBuffer(data)) {
        writeFileSync(filePath, data);
      } else if (typeof data === 'string') {
        // 视为 base64
        writeFileSync(filePath, Buffer.from(data, 'base64'));
      } else {
        writeFileSync(filePath, JSON.stringify(data));
      }
    } catch (err) {
      this.logger.error('Failed to save asset file: ' + (err instanceof Error ? err.message : String(err)));
      throw err;
    }

    const asset: AssetRecord = {
      id: assetId,
      filename: safeName,
      format: ext,
      filePath,
      size: statSync(filePath).size,
      createdAt: Date.now(),
      url: '/api/media/assets/' + assetId,
    };

    this.assets[assetId] = asset;
    this.saveAssetIndex();
    this.logger.info('Asset saved: ' + assetId + ' (' + safeName + ')');
    return asset;
  }

  /** 获取资产（校验文件仍存在） */
  getAsset(assetId: string): AssetRecord | null {
    if (!assetId) return null;
    const asset = this.assets[assetId];
    if (!asset) return null;
    if (!existsSync(asset.filePath)) {
      this.logger.warn('Asset file missing: ' + asset.filePath);
      return null;
    }
    return { ...asset };
  }

  /** 列出资产（可按格式过滤） */
  listAssets(type?: string): AssetRecord[] {
    const result: AssetRecord[] = [];
    for (const asset of Object.values(this.assets)) {
      if (type && asset.format !== type) continue;
      result.push({ ...asset });
    }
    return result;
  }

  /** 删除资产 */
  deleteAsset(assetId: string): boolean {
    if (!assetId || !this.assets[assetId]) return false;
    const asset = this.assets[assetId];
    try {
      if (existsSync(asset.filePath)) {
        unlinkSync(asset.filePath);
      }
    } catch (err) {
      this.logger.error('Failed to delete asset file: ' + (err instanceof Error ? err.message : String(err)));
    }
    delete this.assets[assetId];
    this.saveAssetIndex();
    this.logger.info('Asset deleted: ' + assetId);
    return true;
  }

  /** 获取资产 URL */
  getAssetUrl(assetId: string): string | null {
    if (!assetId || !this.assets[assetId]) return null;
    return '/api/media/assets/' + assetId;
  }

  // ============================================================
  // 资产索引持久化
  // ============================================================

  private loadAssetIndex(): void {
    if (!this.assetIndexFile) return;
    try {
      if (existsSync(this.assetIndexFile)) {
        const data = readFileSync(this.assetIndexFile, 'utf8');
        this.assets = JSON.parse(data) as Record<string, AssetRecord>;
      }
    } catch (err) {
      this.logger.error('Failed to load asset index: ' + (err instanceof Error ? err.message : String(err)));
      this.assets = {};
    }
  }

  private saveAssetIndex(): void {
    if (!this.assetIndexFile) return;
    try {
      const dir = dirname(this.assetIndexFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.assetIndexFile, JSON.stringify(this.assets, null, 2), 'utf8');
    } catch (err) {
      this.logger.error('Failed to save asset index: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ============================================================
  // 数据目录解析
  // ============================================================

  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'media');
    return join(this.getDefaultDataDir(), 'media');
  }

  private getDefaultDataDir(): string {
    if (IS_WIN) {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (PLAT === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
