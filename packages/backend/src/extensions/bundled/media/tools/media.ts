import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve as resolvePath } from 'node:path';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { HttpClientService } from '../../../../modules/core/http/http-client.service.js';
import { VideoTaskService } from '../../../../modules/automation/video-task.service.js';
import { createHash } from 'node:crypto';
import { MediaService } from '../../../../modules/automation/media.service.js';
import { GenerationPending, GENERATION_PENDING_MESSAGE } from '../../../../modules/ai/llm/generation-errors.js';
import { OcrService } from '../../../../modules/automation/ocr.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { renderDesignFile } from '../../../../modules/tools/files/design-export.js';
import { recordFileCheckpoint, withFileMutation } from '../../../../modules/tools/files/checkpoint-store.js';
import { assertObservedVersion, observeVersion } from '../../../../modules/tools/files/observed-versions.js';
import { mergePdf } from '../../../../modules/tools/files/pdf-merge.js';

/** 可选依赖统一经 dynamicRequire 加载（与 vectors.service 一致，便于降级） */
const dynamicRequire = createRequire(__filename);

interface ImageGenerateArgs {
  request_id?: string;
  prompt: string;
  size?: string;
  model?: string;
  filename?: string;
}

/** generate_image 工具参数（旧版 1.4.0 多厂商参数形状对齐版，与 image_generate 并存） */
interface GenerateImageArgs {
  request_id?: string;
  prompt: string;
  model?: string;
  size?: string;
  provider?: string;
  filename?: string;
  count?: number;
  input_images?: string[];
}

/** generate_video 工具参数 */
interface GenerateVideoArgs {
  request_id?: string;
  prompt: string;
  model?: string;
  duration_seconds?: number;
  size?: string;
  input_images?: string[];
  provider?: string;
  filename?: string;
}

interface CanvasArgs {
  action: 'create' | 'draw' | 'export' | 'clear';
  width?: number;
  height?: number;
  content?: string;
  format?: 'html' | 'png' | 'svg' | 'pdf';
  filename?: string;
}

interface NotebookEditArgs {
  notebook_path: string;
  cell_number: number;
  new_source?: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

interface PdfArgs {
  action: 'read' | 'extract_text' | 'info' | 'merge' | 'create';
  file_path?: string;
  file_paths?: string[];
  pages?: string;
  output_path?: string;
  text?: string;
  title?: string;
}

/** 图片文件大小上限（50MB，对齐旧版 image_generate 下载限制） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** 视频文件大小上限（200MB，视频产物远大于图片） */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** 视频下载超时（5分钟，视频文件较大且源站下载耗时较长） */
const VIDEO_DOWNLOAD_TIMEOUT_MS = 300_000;

/** pdf-parse 解析结果 */
interface PdfParsed {
  text: string;
  numpages: number;
  info?: unknown;
}

/** pdf-parse 动态加载缓存（null 表示未加载/不可用） */
let pdfParseFn: ((b: Uint8Array, o?: Record<string, unknown>) => Promise<PdfParsed>) | null = null;
let pdfParseLoaded = false;

/** 加载 pdf-parse（失败返回 null，结果缓存） */
function loadPdfParse(): ((b: Uint8Array, o?: Record<string, unknown>) => Promise<PdfParsed>) | null {
  if (pdfParseLoaded) return pdfParseFn;
  pdfParseLoaded = true;
  try {
    const mod = dynamicRequire('pdf-parse') as unknown;
    if (typeof mod === 'function') {
      pdfParseFn = mod as (b: Uint8Array, o?: Record<string, unknown>) => Promise<PdfParsed>;
    } else if (mod && typeof (mod as { default?: unknown }).default === 'function') {
      pdfParseFn = (mod as { default: (b: Uint8Array, o?: Record<string, unknown>) => Promise<PdfParsed> }).default;
    }
  } catch {
    pdfParseFn = null;
  }
  return pdfParseFn;
}

/** pdfkit 文档最小接口（动态加载，仅用到流式写入） */
interface PdfKitDoc {
  on: (ev: string, cb: (chunk?: unknown) => void) => PdfKitDoc;
  fontSize: (n: number) => PdfKitDoc;
  moveDown: () => PdfKitDoc;
  text: (t: string, opts?: Record<string, unknown>) => PdfKitDoc;
  end: () => void;
}

/** pdfkit 构造器缓存（null 表示未加载/不可用） */
let pdfKitCtor: (new (opts?: Record<string, unknown>) => PdfKitDoc) | null = null;
let pdfKitLoaded = false;

/** 加载 pdfkit（失败返回 null，结果缓存） */
function loadPdfKit(): (new (opts?: Record<string, unknown>) => PdfKitDoc) | null {
  if (pdfKitLoaded) return pdfKitCtor;
  pdfKitLoaded = true;
  try {
    const mod = dynamicRequire('pdfkit') as unknown;
    const ctor =
      (mod as { PDFDocument?: unknown }).PDFDocument ??
      ((mod as { default?: unknown }).default ?? mod);
    if (typeof ctor === 'function') {
      pdfKitCtor = ctor as new (opts?: Record<string, unknown>) => PdfKitDoc;
    }
  } catch {
    pdfKitCtor = null;
  }
  return pdfKitCtor;
}

/**
 * 解析输出文件路径：workspace 内（PathGuard 校验），文件名清洗防穿越。
 * 返回 null 表示路径被安全策略拒绝。
 */
function resolveOutputPath(
  security: SecurityManagerService,
  media: MediaService | undefined,
  ctx: ToolContext,
  filename: string,
): string | null {
  const safeName = filename.replace(/[/\\]/g, '_').replace(/\.\./g, '');
  // 生成产物落持久化媒体数据目录（<dataDir>/generated）。
  // 此前落在 ctx.workspace/cwd：安装版 cwd 是 _up_ 安装目录，应用更新即被清空，
  // 历史会话里的图片/视频附件 URL 全部 404 变裂图（dataDir 在用户数据目录，更新不清空）
  const baseDir = media
    ? join(media.getDataDir(), 'generated')
    : ctx.workspace || process.cwd();
  if (media) {
    try {
      if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
    } catch {
      // 目录创建失败时交由下方写入报错兜底
    }
  }
  const target = resolvePath(join(baseDir, safeName));
  if (!security.isPathAllowed(target, 'write')) return null;
  return target;
}

/** 将 Buffer/URL 图片落盘；URL 下载前做 SSRF 校验（HttpClient 内置二次校验） */
async function saveGeneratedImage(
  security: SecurityManagerService,
  http: HttpClientService,
  url: string | null,
  data: Buffer | null,
  outPath: string,
): Promise<{ saved: boolean; error?: string }> {
  try {
    if (data && data.length > 0) {
      writeFileSync(outPath, data);
      return { saved: true };
    }
    if (url) {
      if (!security.checkUrlSync(url)) {
        return { saved: false, error: `URL blocked by SSRF guard: ${url}` };
      }
      const check = await security.checkUrl(url);
      if (!check.safe) {
        return { saved: false, error: `URL blocked by SSRF DNS check: ${url}` };
      }
      const resp = await http.get<Buffer>(url, {
        responseType: 'buffer',
        timeout: 60_000,
      });
      const buf = Buffer.from(resp.data);
      if (buf.length > MAX_IMAGE_BYTES) {
        return { saved: false, error: '图片过大(>50MB)' };
      }
      writeFileSync(outPath, buf);
      return { saved: true };
    }
    return { saved: false, error: 'API未返回图像数据' };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 将 Buffer/URL/本地路径视频落盘；URL 下载前做 SSRF 校验（HttpClient 内置二次校验）。
 * 视频上限 200MB、下载超时 5 分钟（视频生成为长耗时操作，仅对下载环节设限，
 * 生成轮询本身不施加人为短超时）。
 */
async function saveGeneratedVideo(
  security: SecurityManagerService,
  http: HttpClientService,
  url: string | null,
  data: Buffer | null,
  localPath: string | null,
  outPath: string,
): Promise<{ saved: boolean; error?: string }> {
  try {
    if (data && data.length > 0) {
      writeFileSync(outPath, data);
      return { saved: true };
    }
    if (localPath) {
      // 本地生成（local-ffmpeg 提供商）：直接复制到工作区输出路径
      copyFileSync(localPath, outPath);
      return { saved: true };
    }
    if (url) {
      if (!security.checkUrlSync(url)) {
        return { saved: false, error: `URL blocked by SSRF guard: ${url}` };
      }
      const check = await security.checkUrl(url);
      if (!check.safe) {
        return { saved: false, error: `URL blocked by SSRF DNS check: ${url}` };
      }
      const resp = await http.get<Buffer>(url, {
        responseType: 'buffer',
        timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
      });
      const buf = Buffer.from(resp.data);
      if (buf.length > MAX_VIDEO_BYTES) {
        return { saved: false, error: '视频过大(>200MB)' };
      }
      writeFileSync(outPath, buf);
      return { saved: true };
    }
    return { saved: false, error: 'API未返回视频数据' };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 媒体域工具：image_generate / generate_image / generate_video / canvas / pdf / notebook_edit。
 *
 * image_generate 桥接 ImageProviderService（openai/siliconflow/volcengine/custom，
 * 由 automation.media.image 配置注册）；未配置任何提供商时返回明确提示。
 * generate_image 为旧版 1.4.0 多厂商参数形状对齐版（支持 provider/count），与 image_generate 并存。
 * generate_video 桥接 VideoProviderService（runway/pika/dashscope/local-ffmpeg，
 * 由 automation.media.video 配置注册），支持文生视频/图生视频；视频生成为长耗时操作
 * （DashScope 异步轮询最长可达数分钟），工具执行层不施加人为短超时。
 * pdf 解析经 pdf-parse、生成经 pdfkit（后端依赖已包含，动态加载降级）。
 */
/**
 * 生成模型清单文案（动态构建：数据源为 provider.service 注册表，注册表更新后自动同步）。
 *
 * 只列出"当前已配置 API key"厂商的模型（所见即可用）：
 * 避免清单混入未配置厂商（如未配火山 key 的豆包 Seedance），AI 按清单选型后
 * 才发现不可用、再查配置重试的浪费往返。media 为空（AutomationModule 未加载）
 * 时退化为全量清单（兜底，不阻断工具注册）。
 */
function buildModelCatalogLines(kind: 'image' | 'video', media: MediaService | undefined): string {
  if (!media) return '媒体服务尚未就绪，不可提交生成任务';
  const items = media.generationCatalog(kind);
  if (!items.length) return '尚未配置可用生成 API。请引导用户到 /settings?tab=models 配置对应能力；不得猜测或改用其他收费来源。';
  return items.map(m => '- ' + m.providerId + '::' + m.id + ' (' + m.providerName + '): ' + m.traits).join('\n');
}

export function createMediaTools(
  security: SecurityManagerService,
  http: HttpClientService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  /** MediaService 懒解析（首次执行时解析并缓存）。
   * 走 MediaService 而非直接用 Provider 注册表：其 generateImage/generateVideo
   * 内含惰性派生（启动后才配置通义千问 qwen 的场景无需重启即生效）。
   * resolve 失败（启动早期 description getter 读取等场景）返回 undefined 不抛错。 */
  let mediaCache: MediaService | undefined;
  let mediaResolved = false;
  const getMedia = (): MediaService | undefined => {
    if (!mediaResolved) {
      try {
        mediaCache = resolve(MediaService);
        // 仅解析成功才置位：启动早期失败的读取（description getter）不永久
        // 缓存 undefined，下次调用重试解析（服务就绪后即可拿到）
        mediaResolved = true;
      } catch {
        mediaCache = undefined;
      }
    }
    return mediaCache;
  };
  /** OcrService 懒解析（pdf 扫描件本地 OCR 降级用；OCR 属本地文字识别，
   *  与媒体 API 生成无关，旧媒体套件清理时保留） */
  let ocrCache: OcrService | undefined;
  let ocrResolved = false;
  const getOcr = (): OcrService | undefined => {
    if (!ocrResolved) {
      try {
        ocrCache = resolve(OcrService);
        ocrResolved = true;
      } catch {
        ocrCache = undefined;
      }
    }
    return ocrCache;
  };

  const imageGenerateTool: ToolDefinition = {
    name: 'image_generate',
    description:
      'AI图像生成（简版）。根据文字描述生成图片并保存到工作区，提供商自动派生自设置页已配置的模型供应商，默认使用默认生成模型（跟随默认对话模型厂商）。需要按模型特性选型（质量/速度/成本）时请改用 generate_image 工具（含完整模型目录与选型规则）。',
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        request_id: {type:'string',description:'同一次生成使用同一标识；提交结果待核实时不得换标识重试。'},
        prompt: { type: 'string', description: '图像描述（英文效果最佳）' },
        size: { type: 'string', description: '图片尺寸（如 1024x1024），默认 1024x1024' },
        model: { type: 'string', description: '生成模型（由提供商决定，可选）' },
        filename: { type: 'string', description: '保存文件名（如 output.png），默认自动生成' },
      },
      required: ['prompt'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as ImageGenerateArgs;
      if (!a || typeof a.prompt !== 'string' || a.prompt.length === 0) {
        return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string' };
      }
      const media = getMedia();
      if (!media) {
        return { success: false, error: '图像生成服务不可用（AutomationModule 未加载）' };
      }
      try {
        const result = await media.generateImage({
          requestId:a.request_id || createHash('sha256').update(JSON.stringify({session:ctx.sessionId,args:a,selected:ctx.selectedModel})).digest('hex'),
          ...(ctx.selectedModel ? { preferredModel: ctx.selectedModel } : {}),
          prompt: a.prompt,
          count: 1,
          ...(typeof a.size === 'string' ? { size: a.size } : {}),
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
        });
        const img = result.images[0];
        if (!img) {
          return { success: false, error: '提供商未返回任何图像' };
        }
        const filename = a.filename || `generated-${Date.now()}.png`;
        const outPath = resolveOutputPath(security, media, ctx, filename);
        if (!outPath) {
          return {
            success: false,
            error: `输出路径不在白名单内: ${filename}`,
            blocked: true,
          };
        }
        const save = await saveGeneratedImage(security, http, img.url, img.data, outPath);
        if (!save.saved) {
          return { success: false, error: save.error ?? '保存图像失败' };
        }
        return {
          success: true,
          output: `图片已生成: ${outPath} (model=${result.model}, ${img.width}x${img.height})`,
          data: { ...result.metadata, file: outPath, filename, model: result.model },
        };
      } catch (err) {
        if(err instanceof GenerationPending)return {success:false,blocked:true,error:GENERATION_PENDING_MESSAGE,data:{pauseReason:'generation_pending',taskId:err.taskId}};
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('No image provider available')) {
          return {
            success: false,
            error:
              '未配置图像生成提供商：在设置页配置以下任一模型供应商 API 后自动可用（通义千问wanx / 火山豆包Seedream / OpenAI DALL-E / 硅基流动Flux），或在配置 automation.media.image 中手动注册提供商',
          };
        }
        return { success: false, error: `图像生成失败: ${msg}` };
      }
    },
  };

  const generateImageTool: ToolDefinition = {
    name: 'generate_image',
    // description 为 getter：AgentLoop 每次 LLM 请求都重新读取（getToolDefinitions
    // 每次访问 t.description），清单只含当前已配置厂商的模型（所见即可用），
    // 启动后新配置/移除厂商即时生效，无需重启
    get description(): string {
      return (
        'AI图像生成与编辑。根据描述生成图片；编辑时传 input_images，系统选择具备图片输入能力的已配置模型，缺少适配时可补用官方模型并扣 Wing 积分。\n' +
        `可用生成模型及特性（清单只含当前已配置 API 的厂商，按用户需求对照各模型 traits 选型，model 参数直接传模型名自动路由到对应厂商）：\n${buildModelCatalogLines('image', getMedia())}\n` +
        '选型规则（按 traits 判断，非固定型号）：用户要最高质量→选 traits 含"旗舰/最强"的；要快或便宜→选"便宜/免费/速度"的；批量生成控制成本→性价比款；带文字的海报→文字渲染强的。用户未指定且无明确倾向时：不传 model，用默认生成模型（设置页可选，未设置时跟随默认对话模型厂商）。'
      );
    },
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        request_id: {type:'string',description:'同一次生成使用同一标识；提交结果待核实时不得换标识重试。'},
        prompt: { type: 'string', description: '图片描述（中英文均可，越详细效果越好）' },
        input_images: {type:'array',items:{type:'string'},description:'需要编辑的图片：工作区路径、HTTPS 地址或图片 data URL；最多两张。'},
        model: {
          type: 'string',
          description:
            '生成模型名（从上方工具描述的可用模型清单中按 traits 选型传入）：直接传模型名系统自动路由到对应厂商；未传时用默认生成模型（设置页可选）',
        },
        size: { type: 'string', description: '图片尺寸（如 1024x1024），默认 1024x1024' },
        provider: {
          type: 'string',
          description:
            '指定图像提供商ID（dashscope=通义万相 / ark=Seedream / openai=GPT Image / siliconflow=Flux）；一般无需指定——传 model 名即自动路由，未传时用默认生成模型（设置页可选）',
        },
        filename: { type: 'string', description: '保存文件名（如 output.png），默认自动生成' },
        count: { type: 'number', description: '生成图片数量，默认1' },
      },
      required: ['prompt'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as GenerateImageArgs;
      if (!a || typeof a.prompt !== 'string' || a.prompt.length === 0) {
        return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string' };
      }
      const media = getMedia();
      if (!media) {
        return { success: false, error: '图像生成服务不可用（AutomationModule 未加载）' };
      }
      try {
        const count =
          typeof a.count === 'number' && Number.isFinite(a.count) && a.count > 0
            ? Math.floor(a.count)
            : 1;
        const inputImages:string[]=[];
        if(a.input_images!==undefined) {
          if(!Array.isArray(a.input_images)||a.input_images.length>2)throw new Error('Provide at most two input images');
          for(const value of a.input_images) {
            if(typeof value!=='string')throw new Error('Invalid image input');
            if(value.startsWith("https://")||/^data:image\/(png|jpeg|webp);base64,/.test(value)){inputImages.push(value);continue;}
            const path=resolvePath(ctx.workspace || process.cwd(),value);
            if(!security.isPathAllowed(path,'read'))throw new Error('Image path is outside the allowed workspace');
            const bytes=readFileSync(path),mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(path).toLowerCase()];
            if(!mime||bytes.length>10*1024*1024)throw new Error('Use a PNG/JPEG/WebP image under 10 MB');
            inputImages.push('data:'+mime+';base64,'+bytes.toString('base64'));
          }
        }
        const result = await media.generateImage({
          requestId:a.request_id || createHash('sha256').update(JSON.stringify({session:ctx.sessionId,args:a,selected:ctx.selectedModel})).digest('hex'),
          ...(ctx.selectedModel ? { preferredModel: ctx.selectedModel } : {}),
          prompt: a.prompt,
          count,
          ...(inputImages.length?{inputImages}:{}),
          ...(typeof a.size === 'string' ? { size: a.size } : {}),
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
          ...(typeof a.provider === 'string' ? { provider: a.provider } : {}),
        });
        const img = result.images[0];
        if (!img) {
          return { success: false, error: '提供商未返回任何图像' };
        }
        const filename = a.filename || `generated-${Date.now()}.png`;
        const outPath = resolveOutputPath(security, media, ctx, filename);
        if (!outPath) {
          return {
            success: false,
            error: `输出路径不在白名单内: ${filename}`,
            blocked: true,
          };
        }
        const save = await saveGeneratedImage(security, http, img.url, img.data, outPath);
        if (!save.saved) {
          return { success: false, error: save.error ?? '保存图像失败' };
        }
        return {
          success: true,
          output: `图片已生成: ${outPath} (model=${result.model}, ${img.width}x${img.height})`,
          data: { ...result.metadata, file: outPath, filename, model: result.model, kind: 'image' },
        };
      } catch (err) {
        if(err instanceof GenerationPending)return {success:false,blocked:true,error:GENERATION_PENDING_MESSAGE,data:{pauseReason:'generation_pending',taskId:err.taskId}};
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('No image provider available')) {
          return {
            success: false,
            error:
              '未配置图像生成提供商：在设置页配置以下任一模型供应商 API 后自动可用（通义千问wanx / 火山豆包Seedream / OpenAI DALL-E / 硅基流动Flux），或在配置 automation.media.image 中手动注册提供商',
          };
        }
        return { success: false, error: `图像生成失败: ${msg}` };
      }
    },
  };

  const generateVideoTool: ToolDefinition = {
    name: 'generate_video',
    // description 为 getter：同 generate_image，清单动态过滤为已配置厂商
    get description(): string {
      return (
        '视频模型生成（可能收费）。用户不要视频模型、仅用代码或本地制作时，不得调用本工具，改用 render_code_video；字幕、图表和程序动画优先代码渲染。按用户配置的 API、任务输入与所选模型路由。支持持久任务的提供商返回任务 ID；不能将图片发送给仅支持文生视频的模型。单次生成时长不等于成片时长；长片可规划分镜、分段生成，再用 concat_videos 拼接已有兼容片段。先确认费用与生成数量，不可直接批量提交昂贵任务，也不要声称所有工具都无法制作长片。\n' +
        `可用生成模型及特性（清单只含当前已配置 API 的厂商，按用户需求对照各模型 traits 选型，model 参数直接传模型名自动路由到对应厂商）：\n${buildModelCatalogLines('video', getMedia())}\n` +
        '选型规则（按 traits 判断，非固定型号）：用户要最高质量/正式成片→选 traits 含"旗舰"的；要快或低成本试稿→"便宜/最快"的；上代 pro 性价比也可选。用户未指定且无明确倾向时：不传 model，用默认生成模型（设置页可选，未设置时跟随默认对话模型厂商）。视频生成会立即返回持久任务 ID；用 get_video_task 查询或在对话中的生成记录查看下载。刷新或重启不会重提交；新版本使用新的 request_id。在模型设置中选择对应 API 协议并填写模型 ID，用户提供商不限万相。'
      );
    },
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '同一次生成重试必须复用的请求标识；需要新的视频版本时换一个标识。不填时按会话和生成参数去重。' },
        prompt: { type: 'string', description: '视频内容描述（中英文均可，越详细效果越好）' },
        model: {
          type: 'string',
          description:
            '视频生成模型名（从上方工具描述的可用模型清单中按 traits 选型传入）：直接传模型名系统自动路由到对应厂商；未传时用默认生成模型（设置页可选）',
        },
        duration_seconds: {
          type: 'number',
          description: '视频时长（秒），默认5秒（部分模型仅支持固定时长）',
        },
        size: { type: 'string', description: '视频分辨率/尺寸（部分模型支持），如 1920x1080' },
        input_images: {
          type: 'array',
          items: { type: 'string' },
          description: '输入图片列表（图生视频）：本地工作区图片路径或URL',
        },
        provider: {
          type: 'string',
          description:
            '指定视频提供商ID（dashscope=通义万相 / ark=Seedance / runway / pika / local-ffmpeg）；一般无需指定——传 model 名即自动路由，未传时用默认生成模型（设置页可选）',
        },
        filename: {
          type: 'string',
          description: '旧同步提供商的保存文件名；持久视频任务自动以任务 ID 保存，可下载后重命名',
        },
      },
      required: ['prompt'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as GenerateVideoArgs;
      if(ctx.videoCodeOnly)return {success:false,blocked:true,error:'用户已要求不用视频模型，请编写绘图函数并使用 render_code_video。'};
      if (!a || typeof a.prompt !== 'string' || a.prompt.length === 0) {
        return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string' };
      }
      const media = getMedia();
      if (!media) {
        return { success: false, error: '视频生成服务不可用（AutomationModule 未加载）' };
      }
      // 校验并规范化输入图片（图生视频）：URL/data 直接透传，本地路径解析为
      // 工作区绝对路径并校验 PathGuard 白名单与存在性（对齐旧版参考图校验）
      const inputImages: string[] = [];
      if (Array.isArray(a.input_images)) {
        for (const img of a.input_images) {
          if (typeof img !== 'string' || img.length === 0) continue;
          if (/^(https?|data):/i.test(img)) {
            inputImages.push(img);
            continue;
          }
          const absImg = resolvePath(ctx.workspace || process.cwd(), img);
          if (!security.isPathAllowed(absImg, 'read')) {
            return {
              success: false,
              error: `输入图片路径不在白名单内: ${img}`,
              blocked: true,
            };
          }
          if (!existsSync(absImg)) {
            return { success: false, error: `输入图片文件不存在: ${img}` };
          }
          const imageBytes=readFileSync(absImg);
          const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(absImg).toLowerCase()];
          if(!mime || imageBytes.length>10*1024*1024)return {success:false,error:'Video input must be a PNG/JPEG/WebP image under 10 MB'};
          inputImages.push('data:'+mime+';base64,'+imageBytes.toString('base64'));
        }
      }
      try {
        const request = {
          ...(ctx.selectedModel ? { preferredModel: ctx.selectedModel } : {}),
          prompt: a.prompt,
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
          ...(typeof a.duration_seconds === 'number' ? { durationSeconds: a.duration_seconds } : {}),
          ...(typeof a.size === 'string' ? { size: a.size } : {}),
          ...(inputImages.length > 0 ? { inputImages } : {}),
          ...(typeof a.provider === 'string' ? { provider: a.provider } : {}),
        };
        if (!media.resolveVideoProvider(request).submit) {
          const result = await media.generateVideo(request);
          const video = result.videos[0];
          const filename = a.filename || `generated-${Date.now()}.mp4`;
          const outPath = resolveOutputPath(security, media, ctx, filename);
          if (!video || !outPath) return { success: false, error: 'Video result or allowed output path missing' };
          const saved = await saveGeneratedVideo(security, http, video.url, video.data, video.localPath ?? null, outPath);
          return saved.saved ? { success: true, output: '视频已生成: ' + outPath, data: { file: outPath, kind: 'video' } } : { success: false, error: saved.error || 'Video save failed' };
        }
        const tasks = resolve(VideoTaskService);
        if (!tasks) throw new Error('Video task service unavailable');
        const key = a.request_id || createHash('sha256').update(JSON.stringify({ session: ctx.sessionId, request })).digest('hex');
        const job = await tasks.submit(request, key);
        return { success: true, output: '视频任务已提交，ID: ' + job.id + '。请使用 get_video_task 查询，或在对话中的生成记录查看进度与下载。', data: job };
      } catch (err) {
        if(err instanceof GenerationPending)return {success:false,blocked:true,error:GENERATION_PENDING_MESSAGE,data:{pauseReason:'generation_pending',taskId:err.taskId}};
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('No video provider available')) {
          return {
            success: false,
            error:
              '未配置视频生成模型。可用 render_code_video 制作代码动画、字幕、图表或素材视频，无需视频模型 API；若用户需要真实场景等效果，请说明素材/模型需求并确认制作方式。',
          };
        }
        return { success: false, error: `视频生成失败: ${msg}` };
      }
    },
  };

  const canvasTool: ToolDefinition = {
    name: 'canvas',
    description:
      'Canvas画布操作。create/draw 将 HTML 或 SVG 保存为可编辑 HTML 设计稿，用户可在画布继续编辑。export 可真实导出 PNG/PDF/SVG；clear 必须指定 HTML/SVG 文件名，会将该文件改为空白画布。',
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'draw', 'export', 'clear'],
          description: '操作：create/draw=写入内容，export=导出文件，clear=清空画布',
        },
        width: { type: 'number', description: '画布宽度（像素），默认800' },
        height: { type: 'number', description: '画布高度（像素），默认600' },
        content: { type: 'string', description: '绘制内容（HTML 或 SVG 文本）' },
        format: { type: 'string', enum: ['html', 'png', 'svg', 'pdf'], description: '默认 html，可在设计画布继续编辑；PNG/PDF 需要本机 Edge 或 Chrome' },
        filename: { type: 'string', description: '导出文件名' },
      },
      required: ['action'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as CanvasArgs;
      if (!a || (a.action !== 'create' && a.action !== 'draw' && a.action !== 'export' && a.action !== 'clear')) {
        return { success: false, error: 'Parameter "action" must be one of create/draw/export/clear' };
      }
      const width = a.width ?? 800, height = a.height ?? 600;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || width > 2560 || height > 2560) return { success: false, error: '画布尺寸必须为 100–2560 的整数' };
      if (a.action === 'clear' && !a.filename) return { success: false, error: '清空画布必须明确指定 filename' };
      const format = a.format ?? (a.filename ? extname(a.filename).slice(1).toLowerCase() : 'html');
      if (!['html', 'svg', 'png', 'pdf'].includes(format)) return { success: false, error: '画布格式无效' };
      if (a.action === 'clear' && !['html', 'svg'].includes(format)) return { success: false, error: '只能清空可编辑的 HTML/SVG 画布' };
      const filename = a.filename || `canvas-${Date.now()}.${format}`;
      if (extname(filename).toLowerCase() !== '.' + format) return { success: false, error: '文件扩展名必须与导出格式一致' };
      let content = typeof a.content === 'string' ? a.content : '';
      if (a.action === 'clear' || (a.action === 'create' && !content)) content = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;
      if (!content || Buffer.byteLength(content) > 1536 * 1024) return { success: false, error: '请提供不超过 1.5 MB 的 HTML/SVG 内容' };
      if (format === 'svg' && !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(content)) return { success: false, error: 'SVG 导出要求 SVG 内容' };
      const html = /^\s*(<!doctype|<html)/i.test(content) ? content : `<!doctype html><html><head><meta charset="utf-8"><title>Wing Canvas</title></head><body style="margin:0">${content}</body></html>`;
      // Editable designs belong to the selected workspace scanned by the design canvas.
      const outPath = resolveOutputPath(security, undefined, ctx, filename);
      if (!outPath) {
        return { success: false, error: `输出路径不在白名单内: ${filename}`, blocked: true };
      }
      try {
        const data = format === 'png' || format === 'pdf' ? await renderDesignFile(html, width, height, format) : format === 'html' ? html : content;
        await withFileMutation(outPath, async () => {
          if (a.action === 'clear' && !existsSync(outPath)) throw new Error('指定的画布文件不存在');
          if(typeof data==='string'){
            const old=existsSync(outPath)?readFileSync(outPath,'utf8'):null;
            assertObservedVersion(ctx.sessionId,outPath,old);
            recordFileCheckpoint(ctx.sessionId,outPath,old,data);
          }
          writeFileSync(outPath, data);
          if(typeof data==='string')observeVersion(ctx.sessionId,outPath,data);
        });
        return {
          success: true,
          output: `${a.action === 'clear' ? '画布文件已清空' : '画布已保存'}: ${outPath} (format=${format})${format === 'html' ? '。可在当前工作区的设计画布打开并编辑。' : ''}`,
          data: { file: outPath, filename, format },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const pdfTool: ToolDefinition = {
    name: 'pdf',
    description:
      'PDF文档处理。读取PDF提取文字(read/extract_text)、获取文件信息(info)、由文本生成PDF(create)。当用户提到PDF文件时优先使用本工具。',
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'extract_text', 'info', 'create', 'merge'],
          description: '操作：read/extract_text=提取文字, info=文件信息, create=由文本生成PDF, merge=本地按顺序合并页面',
        },
        file_path: { type: 'string', description: 'PDF文件路径（read/info用）' },
        pages: { type: 'string', description: '页码范围（如1-5,8），默认全部' },
        file_paths: { type: 'array', items: { type: 'string' }, description: '合并时的PDF路径列表（merge用）' },
        output_path: { type: 'string', description: '输出文件路径（create/merge用）' },
        text: { type: 'string', description: '生成PDF的正文文本（create用）' },
        title: { type: 'string', description: '生成PDF的标题（create用）' },
      },
      required: ['action'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as PdfArgs;
      if (!a || !a.action) {
        return { success: false, error: 'Parameter "action" is required' };
      }
      try {
        if (a.action === 'info' || a.action === 'read' || a.action === 'extract_text') {
          return await readPdf(security, a, getOcr());
        }
        if (a.action === 'create') {
          return await createPdf(security, getMedia(), ctx, a);
        }
        if (a.action === 'merge') {
          const data = await mergePdf(security, ctx.workspace || process.cwd(), a.file_paths, a.output_path);
          return { success: true, output: `已合并 ${data.inputs} 个 PDF，共 ${data.pages} 页：${data.file}`, data };
        }
        return { success: false, error: `Unknown action: ${a.action}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const notebookEditTool: ToolDefinition = {
    name: 'notebook_edit',
    description: '编辑Jupyter Notebook单元格（.ipynb）。支持替换/插入/删除代码或Markdown单元格。',
    category: 'media',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Notebook文件绝对路径' },
        cell_number: { type: 'number', description: '单元格编号（0开始）' },
        new_source: { type: 'string', description: '新的单元格内容' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: '插入时的单元格类型' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: '编辑模式，默认replace' },
      },
      required: ['notebook_path', 'cell_number'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as NotebookEditArgs;
      if (!a || typeof a.notebook_path !== 'string' || a.notebook_path.length === 0) {
        return { success: false, error: 'Parameter "notebook_path" is required' };
      }
      if (typeof a.cell_number !== 'number' || !Number.isInteger(a.cell_number) || a.cell_number < 0) {
        return { success: false, error: 'Parameter "cell_number" must be a non-negative integer' };
      }
      const absPath = resolvePath(a.notebook_path);
      if (absPath.includes('\0')) {
        return { success: false, error: 'path must not contain null bytes' };
      }
      if (!security.isPathAllowed(absPath, 'write')) {
        return { success: false, error: `路径不在白名单内: ${absPath}`, blocked: true };
      }
      if (!existsSync(absPath)) {
        return { success: false, error: `文件不存在: ${a.notebook_path}` };
      }
      try {
        const nb = JSON.parse(readFileSync(absPath, 'utf-8')) as {
          cells?: Array<{ cell_type: string; source: string | string[]; metadata?: unknown; outputs?: unknown[]; execution_count?: unknown }>;
        };
        if (!nb.cells || !Array.isArray(nb.cells)) {
          return { success: false, error: '不是有效的Jupyter Notebook（缺少cells）' };
        }
        const mode = a.edit_mode ?? 'replace';
        if (mode === 'delete') {
          if (a.cell_number >= nb.cells.length) {
            return { success: false, error: `单元格越界: ${a.cell_number}（共${nb.cells.length}个）` };
          }
          nb.cells.splice(a.cell_number, 1);
        } else if (mode === 'insert') {
          nb.cells.splice(a.cell_number, 0, {
            cell_type: a.cell_type ?? 'code',
            source: a.new_source ?? '',
            metadata: {},
            outputs: [],
            execution_count: null,
          });
        } else {
          if (a.cell_number >= nb.cells.length) {
            return { success: false, error: `单元格越界: ${a.cell_number}（共${nb.cells.length}个）` };
          }
          nb.cells[a.cell_number]!.source = a.new_source ?? '';
        }
        writeFileSync(absPath, JSON.stringify(nb, null, 1), 'utf-8');
        return {
          success: true,
          output: `Notebook已更新: ${absPath} (cell=${a.cell_number}, mode=${mode})`,
          data: { file: absPath, cell: a.cell_number, mode },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return [
    imageGenerateTool,
    generateImageTool,
    generateVideoTool,
    {
      name: 'get_video_task', description: '查询已提交的视频任务，不会再次生成或计费。完成后显示本地文件路径。', category: 'media', dangerous: false,
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      async execute(args: unknown): Promise<ToolResult> {
        try {
          const tasks = resolve(VideoTaskService);
          if (!tasks) throw new Error('Video task service unavailable');
          const job = tasks.get((args as { task_id: string }).task_id);
          return { success: true, output: JSON.stringify(job), data: { ...job, ...(job.artifactReady ? { file: tasks.artifact(job.id), kind: 'video' } : {}) } };
        } catch (e) { return { success: false, error: String(e) }; }
      },
    },
    canvasTool,
    pdfTool,
    notebookEditTool,
  ];
}

/** 解析页码范围字符串（"1-5,8"）为页码数组；非法输入返回 null（全部页） */
function parsePageRange(range: string, maxPages: number): number[] | null {
  if (!/^[\d,\-\s]+$/.test(range)) return null;
  const pages = new Set<number>();
  for (const part of range.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    if (seg.includes('-')) {
      const [s, e] = seg.split('-');
      const start = Math.max(1, parseInt(s || '1', 10) || 1);
      const end = Math.min(maxPages, parseInt(e || String(maxPages), 10) || maxPages);
      for (let p = start; p <= end; p++) pages.add(p);
    } else {
      const n = parseInt(seg, 10);
      if (n >= 1 && n <= maxPages) pages.add(n);
    }
  }
  return pages.size > 0 ? Array.from(pages).sort((x, y) => x - y) : null;
}

/** 读取/解析 PDF（pdf-parse 动态加载，缺库时降级原始文本提取；
 *  扫描件（提取不到文本）降级本地 OCR） */
async function readPdf(security: SecurityManagerService, a: PdfArgs, ocr?: OcrService): Promise<ToolResult> {
  const filePath = a.file_path ?? '';
  if (!filePath) {
    return { success: false, error: 'Parameter "file_path" is required' };
  }
  const absPath = resolvePath(filePath);
  if (absPath.includes('\0')) {
    return { success: false, error: 'path must not contain null bytes' };
  }
  if (!security.isPathAllowed(absPath, 'read')) {
    return { success: false, error: `路径不在白名单内: ${absPath}`, blocked: true };
  }
  if (!existsSync(absPath)) {
    return { success: false, error: `文件不存在: ${filePath}` };
  }
  if (extname(absPath).toLowerCase() !== '.pdf') {
    return { success: false, error: `不是PDF文件: ${filePath}` };
  }
  const buf = readFileSync(absPath);
  const parser = loadPdfParse();
  if (!parser) {
    const raw = buf
      .toString('latin1')
      .replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .substring(0, 50_000);
    return {
      success: true,
      output: raw || '（未能提取到文本，pdf-parse 库不可用）',
      data: { file: absPath, method: 'raw-fallback' },
    };
  }
  let parsed: PdfParsed;
  try {
    parsed = await parser(new Uint8Array(buf), { max: 0, version: 'v2.0.550' });
  } catch (err) {
    return { success: false, error: `PDF解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (a.action === 'info') {
    return {
      success: true,
      output: `PDF信息: ${absPath}，${parsed.numpages}页`,
      data: { file: absPath, pages: parsed.numpages, metadata: parsed.info ?? null },
    };
  }
  let text: string = parsed.text ?? '';
  let method = `pdf-parse(${parsed.numpages}页)`;
  if (a.pages) {
    const selected = parsePageRange(a.pages, parsed.numpages);
    if (!selected) {
      return { success: false, error: '无效的页码范围，仅允许数字、逗号和连字符' };
    }
    // pdf-parse 返回全文；段数与页数一致时按段分页截取，否则保留全文
    const perPage = splitPdfPages(parsed.text ?? '', parsed.numpages);
    if (perPage) {
      text = selected.map((p) => perPage[p - 1] ?? '').join('\n\n');
      method = `pdf-parse(第${selected.join(',')}页/${parsed.numpages}页)`;
    }
  }
  if (text.length > 100_000) text = text.substring(0, 100_000) + '\n...[文本过长已截断]';
  // 扫描件降级：pdf-parse 提取不到文本时走本地 OCR（离线可用零成本）
  if (!text.trim() && ocr) {
    try {
      const ocrResult = await ocr.recognize(absPath);
      if (ocrResult.success && ocrResult.text.trim()) {
        return {
          success: true,
          output: ocrResult.text.substring(0, 100_000),
          data: { file: absPath, method: `local-ocr(${ocrResult.engine})` },
        };
      }
    } catch {
      // OCR 失败继续走原提示
    }
  }
  return {
    success: true,
    output: text.trim() || '（未提取到文本，可能是扫描件，请用OCR）',
    data: { file: absPath, method },
  };
}

/** 按空行拆分 pdf-parse 文本（段数与页数一致时视为可靠分页，否则返回 null） */
function splitPdfPages(text: string, numpages: number): string[] | null {
  if (!text) return null;
  const parts = text.split('\n\n');
  return parts.length === numpages ? parts : null;
}

/** 由纯文本生成 PDF（pdfkit 动态加载） */
async function createPdf(
  security: SecurityManagerService,
  media: MediaService | undefined,
  ctx: ToolContext,
  a: PdfArgs,
): Promise<ToolResult> {
  const text = a.text ?? '';
  if (!text) {
    return { success: false, error: 'Parameter "text" is required for create' };
  }
  const Ctor = loadPdfKit();
  if (!Ctor) {
    return { success: false, error: 'PDF生成不可用：pdfkit 库加载失败' };
  }
  const filename = a.output_path
    ? resolvePath(a.output_path)
    : resolveOutputPath(security, media, ctx, `pdf-${Date.now()}.pdf`);
  if (!filename) {
    return { success: false, error: '输出路径不在白名单内', blocked: true };
  }
  if (!security.isPathAllowed(filename, 'write')) {
    return { success: false, error: `输出路径不在白名单内: ${filename}`, blocked: true };
  }
  try {
    const doc = new Ctor({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolveDone, rejectDone) => {
      doc.on('data', (chunk?: unknown) => {
        if (chunk) chunks.push(chunk as Buffer);
      });
      doc.on('end', () => resolveDone());
      doc.on('error', (e: unknown) => rejectDone(e instanceof Error ? e : new Error(String(e))));
    });
    doc.fontSize(16).text(a.title ?? 'Document', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).text(text);
    doc.end();
    await done;
    const content = Buffer.concat(chunks);
    writeFileSync(filename, content);
    return {
      success: true,
      output: `PDF已生成: ${filename} (${content.length} bytes)`,
      data: { file: filename },
    };
  } catch (err) {
    return { success: false, error: `PDF生成失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
