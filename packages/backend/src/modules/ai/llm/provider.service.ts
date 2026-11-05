import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../../core/config/config.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { LLMClientService } from './llm-client.service.js';

/**
 * ProviderService - LLM 供应商与模型管理服务
 *
 * 移植自 start.cjs 中 /providers 与 /models 路由及 getProviders/getModels 函数。
 *
 * 职责：
 *   - 列出供应商（合并静态注册表与已保存配置，标记 configured 状态）
 *   - 更新/删除供应商配置（持久化到 config.json）
 *   - 测试供应商连通性（实际调用 LLM 发送一条测试消息，返回响应时长）
 *   - 聚合所有 provider 的 models 返回可用模型列表
 *
 * 安全：
 *   - 更新 baseUrl 时调用 SecurityManagerService.checkUrlSync 进行 SSRF 校验
 *   - 响应通过 RedactInterceptor 全局脱敏 apiKey
 */

import { PROVIDERS_REGISTRY, type MediaModelEntry } from './provider-catalog.js';
export { PROVIDERS_REGISTRY, providerCapabilityDefaults } from './provider-catalog.js';
export type { MediaModelEntry } from './provider-catalog.js';

/** 媒体模型目录项（getMediaModelCatalog 返回，供 AI 工具描述动态构建） */
export interface MediaModelCatalogItem {
  id: string;
  traits: string;
  providerId: string;
  providerName: string;
}

/**
 * 生成模型目录（注册表单一数据源导出）。
 *
 * generate_image / generate_video 等工具的模型清单描述由本函数动态生成：
 * 注册表新增/调整模型（含 traits 特性）后，工具描述自动同步，无需改工具文案。
 *
 * @param availableProviderIds 已注册（已配置 API key）的媒体提供商 id 集合。
 *   传入时只返回已配置厂商的模型——工具描述里的清单应"所见即可用"，
 *   避免 AI 按清单选了未配置厂商的模型（如未配火山 key 却选了豆包 Seedance）
 *   导致先失败再查配置重试的浪费往返；未配置厂商的模型对 AI 不可见，
 *   用户配置后下次请求自动出现在清单中（description 为 getter 动态生成）。
 *   不传则返回全量（兼容旧行为，供设置页等展示完整清单用）。
 */
export function getMediaModelCatalog(availableProviderIds?: Set<string>): {
  image: MediaModelCatalogItem[];
  video: MediaModelCatalogItem[];
} {
  const image: MediaModelCatalogItem[] = [];
  const video: MediaModelCatalogItem[] = [];
  for (const p of PROVIDERS_REGISTRY) {
    // 按"已注册媒体提供商"过滤（mediaProviderId 映射：qwen→dashscope / doubao→ark）
    if (availableProviderIds && !availableProviderIds.has(p.mediaProviderId ?? p.id)) {
      continue;
    }
    for (const m of p.imageModels ?? []) {
      image.push({ id: m.id, traits: m.traits, providerId: p.id, providerName: p.name });
    }
    for (const m of p.videoModels ?? []) {
      video.push({ id: m.id, traits: m.traits, providerId: p.id, providerName: p.name });
    }
  }
  return { image, video };
}

/** Conservative output budget, not the model's context window. Saved values are retained. */
const PROVIDER_MAX_TOKENS: Record<string, number> = Object.fromEntries(
  PROVIDERS_REGISTRY.map(provider => [provider.id, 8192]),
);

/** 支持视觉输入的供应商（全量移植自 start.cjs VISION_PROVIDERS） */
const VISION_PROVIDERS = new Set([
  // https://api-docs.deepseek.com/guides/vision/ — deepseek-flash accepts screenshots.
  'deepseek',
  'openai', 'anthropic', 'google', 'azure', 'ollama', 'grok', 'qwen', 'glm',
  'moonshot', 'hunyuan', 'stepfun', 'mistral', 'minimax', 'doubao', 'xiaomi',
  'siliconflow', 'together', 'nvidia',
]);

/** 明确不支持视觉的模型（全量移植自 start.cjs NON_VISION_MODELS） */
const NON_VISION_MODELS = new Set([
  'deepseek-coder', 'deepseek-v4-pro', 'deepseek-v4-flash', 'o1-mini', 'o3-mini',
  'o3-mini-high', 'qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long', 'glm-4',
  'glm-4-flash', 'glm-4-air', 'glm-4-airx', 'glm-4-long', 'glm-3-turbo', 'glm-5-turbo',
  'codegeex-4', 'moonshot-v1-auto', 'moonshot-v1-32k', 'moonshot-v1-128k',
  'moonshot-v1-8k', 'hunyuan-turbos-latest', 'hunyuan-a13b', 'hunyuan-role-latest',
  'hy3-preview', 'step-3', 'step-3.5-flash', 'step-3.5-ultra', 'step-r1-v-mini',
  'mistral-large-latest', 'mistral-small-latest', 'mistral-medium-3.5',
  'codestral-latest', 'devstral-medium-latest', 'doubao-seed-evolving',
  'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-character-260628',
  'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428',
  'doubao-seed-2-0-code-preview-260215', 'doubao-pro-128k', 'doubao-pro-32k',
  'doubao-lite-32k', 'Baichuan-M3-Plus', 'Baichuan-M3', 'Baichuan4', 'Baichuan4-Turbo',
  'mimo-v2.5-pro', 'ernie-5.1', 'ernie-5.0-8k', 'ernie-5.0-thinking-preview',
  'ernie-5.0-thinking-latest', 'ernie-4.5-turbo-128k', 'ernie-4.5-turbo-32k',
  'ernie-4.0-turbo-8k', 'ernie-4.0-8k', 'ernie-speed-128k',
]);

/** 视觉模型名关键词（全量移植自 start.cjs VISION_MODEL_KEYWORDS）。
 * 2026-09-27 二次校正：恢复 claude-fable / claude-mythos（Fable 5/5.1 经 anthropic.com 官方
 * 页面确认公开可调且支持视觉；Mythos 同底层模型）；glm-5 前缀会误判纯文本旗舰
 * glm-5.3/glm-5 为视觉（官方 GLM 视觉为 5v/4.6v/4.5v/5.3-flash 系）；
 * DeepSeek 官方视觉 id 为 deepseek-flash（deepseek-v4-pro 官方明确无视觉）。 */
const VISION_MODEL_KEYWORDS = [
  'gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3',
  'claude-fable', 'claude-mythos', 'claude-opus', 'claude-sonnet', 'claude-haiku', 'gemini', 'kimi-k2',
  'kimi-k3', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl', 'qwen3.7', 'qwen3.8',
  'qwen-max', 'qwen-plus', 'qvq', 'deepseek-vl', 'deepseek-flash', 'moonshot-vl', 'moonshot-v1',
  'glm-5v', 'glm-5.3-flash', 'glm-4.6v', 'glm-4.5v', 'minimax', 'hunyuan-vision',
  'hunyuan-turbos-vision', 'hunyuan-t1-vision', 'grok', 'doubao-seed-2-1', 'doubao-seed-2-0',
  'mimo-v2.5', 'ernie-5.0-thinking', 'ernie-4.5-turbo-vl', 'spark-x2', 'pixtral', 'step-3',
];

/**
 * 判断指定供应商下的模型是否支持视觉输入
 * （移植自 start.cjs 视觉能力判断：VISION_PROVIDERS && !NON_VISION_MODELS && KEYWORDS 前缀/包含匹配）
 */
export function isVisionModel(providerId: string, model: string): boolean {
  const baseProvider = providerId.replace(/_\d+$/, '');
  const preset = PROVIDERS_REGISTRY.find(p => p.id === baseProvider);
  if (preset?.visionModels?.includes(model)) return true;
  if (preset?.models.includes(model) && preset.visionModels) return false;
  if (!VISION_PROVIDERS.has(baseProvider) && !['custom', 'lmstudio', 'vllm'].includes(baseProvider)) return false;
  const m = (model || '').toLowerCase();
  if (!m) return false;
  if (NON_VISION_MODELS.has(model) || NON_VISION_MODELS.has(m)) return false;
  return VISION_MODEL_KEYWORDS.some((k) => m.includes(k));
}

/** 供应商列表项 */
export interface ProviderListItem {
  id: string;
  name: string;
  type: string;
  region: string;
  requiresApiKey: boolean;
  configured: boolean;
  baseUrl: string;
  models: string[];
  /** 环境变量密钥名（用于启动时自动配置，本地供应商为空） */
  envKey: string;
  /** 该供应商默认最大输出 Token（PROVIDER_MAX_TOKENS） */
  maxTokens: number;
  /** 该供应商是否支持视觉输入（VISION_PROVIDERS） */
  vision: boolean;
  /** 是否本地/自托管供应商 */
  local: boolean;
  /** 自定义供应商的显示名（仅 custom 类型） */
  displayName?: string;
  /** 多实例条目的所属注册表厂商 ID（如 openai_2 → openai）；注册表原生条目无此字段 */
  baseProvider?: string;
}

/** 可用模型项 */
export interface ModelItem {
  id: string;
  name: string;
  billingLabel?: string;
  inputCreditsPerMillion?: string;
  outputCreditsPerMillion?: string;
  creditRateMultiplier?: string;
  creditRateMultiplierVariable?: boolean;
  automatic?: boolean;
  billingSource?: string;
  provider: string;
  providerId: string;
  providerName: string;
  available: boolean;
  /** 该模型是否支持视觉输入 */
  vision: boolean;
  /** 模型用途：chat=对话 / image=图片生成 / video=视频生成（统一模型体系） */
  kind: 'chat' | 'image' | 'video';
}

/** 测试连通性结果 */
export interface ProviderTestResult {
  success: boolean;
  latencyMs?: number;
  latency?: string;
  message?: string;
  error?: string;
  model?: string;
}

@Injectable()
export class ProviderService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
    private readonly llm: LLMClientService,
  ) {}

  /** 启动时从环境变量自动配置未设置的供应商（对应旧版 ADDITIONAL_PROVIDERS.autoConfigure 立即执行） */
  onModuleInit(): void {
    try {
      const n = this.autoConfigureFromEnv();
      if (n > 0) this.logger.info(`已从环境变量自动配置 ${n} 个供应商`);
    } catch (err) {
      this.logger.warn('Provider env auto-configure failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 列出所有供应商
   * - 遍历静态注册表，附加 configured 状态与已保存配置
   * - 追加已保存的自定义供应商（不在注册表中的）
   */
  listProviders(): { providers: ProviderListItem[] } {
    const saved = this.getSavedProviders();
    const registryIds = new Set<string>();
    const list: ProviderListItem[] = [];

    for (const reg of PROVIDERS_REGISTRY) {
      registryIds.add(reg.id);
      const cfg = saved[reg.id] as Record<string, unknown> | undefined;
      const baseUrl = (cfg && typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : '') || reg.baseUrl;
      const models = Array.isArray(cfg?.['models']) ? (cfg!['models'] as unknown[]).map(String) : reg.models;
      const isLocal = reg.type === 'local';
      // 用户自定义显示名（编辑表单可改）：优先于注册表默认名；空串回退默认名。
      // 此前恒用 reg.name，编辑保存的 displayName 被丢弃——改名的 bug 根因
      const dn = typeof cfg?.['displayName'] === 'string' ? (cfg!['displayName'] as string).trim() : '';
      list.push({
        id: reg.id,
        name: dn || reg.name,
        type: reg.type,
        region: reg.region,
        requiresApiKey: !isLocal,
        configured: !!(cfg && (cfg['apiKey'] || cfg['baseUrl'])),
        baseUrl,
        models,
        envKey: reg.envKey,
        maxTokens: typeof cfg?.['maxTokens'] === 'number' ? cfg['maxTokens'] : (PROVIDER_MAX_TOKENS[reg.id] ?? 8192),
        vision: !!reg.visionModels?.length,
        local: isLocal,
        ...(dn ? { displayName: dn } : {}),
      });
    }

    // 追加已保存的实例条目（不在注册表中的 key）：注册表厂商多实例 + 自定义供应商
    // 多实例场景：同厂商不同 API Key / 不同 baseUrl（如两个 OpenAI 账号、多个中转端点）。
    // 实例 ID 形如 `<registryId>_<后缀>`（openai_2 / custom_abc），LLM 路由按
    // config.providers[实例ID] 直查，协议类型经 cfg.type 显式携带。
    for (const sid of Object.keys(saved)) {
      if (registryIds.has(sid)) continue;
      const cfg = saved[sid] as Record<string, unknown> | undefined;
      if (!cfg || typeof cfg !== 'object') continue;

      // 解析所属基础厂商：显式 baseProvider 字段优先，其次 `<registryId>_<后缀>` 前缀
      let baseId = typeof cfg['baseProvider'] === 'string' ? cfg['baseProvider'] : '';
      if (!registryIds.has(baseId)) {
        const prefixMatch = sid.match(/^(.+?)_[^_]+$/);
        baseId = prefixMatch && registryIds.has(prefixMatch[1]) ? prefixMatch[1] : '';
      }

      if (baseId === 'custom') {
        // 自定义供应商实例（历史 custom_* 命名或显式 baseProvider=custom）
        const dn = typeof cfg['displayName'] === 'string' ? cfg['displayName'] : '';
        list.push({
          id: sid,
          name: dn || '自定义模型',
          type: 'custom',
          region: 'CUSTOM',
          requiresApiKey: true,
          configured: !!(cfg['apiKey'] || cfg['baseUrl']),
          baseUrl: typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : '',
          models: Array.isArray(cfg['models']) ? (cfg['models'] as unknown[]).map(String) : [],
          envKey: '',
          maxTokens: typeof cfg['maxTokens'] === 'number' ? cfg['maxTokens'] : 0,
          vision: false,
          local: false,
          displayName: dn || '自定义模型',
          baseProvider: 'custom',
        });
        continue;
      }

      const base = baseId ? PROVIDERS_REGISTRY.find((r) => r.id === baseId) : undefined;
      if (base) {
        // 注册表厂商的多实例：继承品牌类型与默认值，配置（key/url/模型）来自实例自身
        const dn = typeof cfg['displayName'] === 'string' ? cfg['displayName'] : '';
        const isLocal = base.type === 'local';
        list.push({
          id: sid,
          name: dn || base.name,
          type: base.type,
          region: base.region,
          requiresApiKey: !isLocal,
          configured: !!(cfg['apiKey'] || cfg['baseUrl']) || isLocal,
          baseUrl: typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : base.baseUrl,
          models: Array.isArray(cfg['models']) ? (cfg['models'] as unknown[]).map(String) : [],
          envKey: '',
          maxTokens:
            typeof cfg['maxTokens'] === 'number'
              ? cfg['maxTokens']
              : (PROVIDER_MAX_TOKENS[base.id] ?? 0),
          vision: VISION_PROVIDERS.has(base.id),
          local: isLocal,
          displayName: dn || base.name,
          baseProvider: base.id,
        });
        continue;
      }

      // 无基础厂商且非自定义：忽略（无法归类的孤立条目）
    }

    // Browsing presets must not depend on a cloud subscription. Model execution
    // still checks the account entitlement in the LLM/media services.
    return { providers: list };
  }

  /**
   * 更新供应商配置
   * - 校验 baseUrl（若提供）通过 SSRF 检查
   *   （本地供应商 ollama/lmstudio/vllm 豁免：目标是用户本机服务，与旧版行为一致）
   * - 写入 config.providers[id]，持久化
   * - apiKey 经由 sanitize 处理（环境变量引用 `${VAR}` 保留原值不替换）
   */
  updateProvider(id: string, partial: Record<string, unknown>): { updated: boolean } {
    for (const key of ['visionModels','imageModels','videoModels']) if(partial[key]!==undefined && (!Array.isArray(partial[key]) || (partial[key] as unknown[]).some(m=>typeof m!=='string'||!m.trim()||m.length>160))) throw new Error('Invalid capability model list');
    for (const [key,protocols] of [['imageProtocol',['none','openai-compatible','openai-images','dashscope','gemini','minimax','xai','zhipu','siliconflow','ideogram']],['videoProtocol',['none','dashscope','ark','runway','pika','minimax','xai']]] as const) if(partial[key]!==undefined && !(protocols as readonly unknown[]).includes(partial[key])) throw new Error('Unsupported media API protocol');
    for (const key of ['imageBaseUrl','videoBaseUrl']) if(partial[key] && (typeof partial[key]!=='string' || !this.security.checkUrlSync(partial[key] as string))) throw new Error('Media API URL blocked');
    if (!id || typeof id !== 'string') {
      throw new Error('Provider id required');
    }
    const reg = PROVIDERS_REGISTRY.find((r) => r.id === id);
    // 多实例 ID（如 ollama_2）不在注册表：从 baseProvider 字段或 ID 前缀解析基础厂商，
    // 继承其 local 属性（SSRF 豁免）与默认 maxTokens
    let baseReg = reg;
    if (!baseReg) {
      const explicitBase =
        typeof partial['baseProvider'] === 'string' ? (partial['baseProvider'] as string) : '';
      const prefixMatch = id.match(/^(.+?)_[^_]+$/);
      const baseId =
        explicitBase ||
        (prefixMatch && PROVIDERS_REGISTRY.some((r) => r.id === prefixMatch[1])
          ? prefixMatch[1]
          : '');
      baseReg = baseId ? PROVIDERS_REGISTRY.find((r) => r.id === baseId) : undefined;
    }
    const isLocal = baseReg?.type === 'local' || partial['type'] === 'local';
    const baseUrl = partial['baseUrl'];
    if (!isLocal && typeof baseUrl === 'string' && baseUrl.length > 0) {
      if (!this.security.checkUrlSync(baseUrl)) {
        throw new Error(`Provider baseUrl blocked by SSRF guard: ${baseUrl}`);
      }
    }

    const providers = this.getSavedProviders();
    if (!providers[id]) providers[id] = {};
    const existing = providers[id] as Record<string, unknown>;
    for (const [k, v] of Object.entries(restoreRedactedConfig(partial, existing) as Record<string, unknown>)) {
      if (k === 'id' || k === 'providerId') continue;
      existing[k] = v;
    }
    // 注册表供应商（含其实例）自动补默认 maxTokens（与旧版 PROVIDER_MAX_TOKENS 一致）
    if (baseReg && PROVIDER_MAX_TOKENS[baseReg.id] && typeof existing['maxTokens'] !== 'number') {
      existing['maxTokens'] = PROVIDER_MAX_TOKENS[baseReg.id];
    }
    this.config.set('providers', providers);
    this.config.save();
    this.logger.info('Provider updated', { providerId: id });
    return { updated: true };
  }

  /**
   * 删除供应商
   * - 移除 config.providers[id]，持久化
   * - 若默认模型指向该供应商（模型 ID 存储或旧厂商 ID 存储），清空默认模型
   */
  deleteProvider(id: string): { deleted: string } {
    const providers = this.getSavedProviders();
    const entry = providers[id] as Record<string, unknown> | undefined;
    if (!entry) {
      throw new Error(`Provider not found: ${id}`);
    }
    // 该供应商的模型清单（判断默认模型是否指向此供应商）
    const providerModels = Array.isArray(entry['models'])
      ? (entry['models'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : [];
    delete providers[id];
    this.config.set('providers', providers);

    // 若默认模型指向该供应商（defaultModel 为模型 ID，兼容历史厂商 ID 存储），清空
    try {
      const general = this.config.get<Record<string, unknown>>('general');
      const dm = general['defaultModel'];
      if (
        general &&
        typeof dm === 'string' &&
        dm &&
        (dm === id || providerModels.includes(dm))
      ) {
        general['defaultModel'] = '';
        this.config.set('general', general);
      }
    } catch {
      // general 段不存在，忽略
    }
    this.config.save();
    this.logger.info('Provider deleted', { providerId: id });
    return { deleted: id };
  }

  /**
   * 测试供应商连通性
   * - ollama：直接 GET ${baseUrl}/api/tags
   * - 其他：调用 LLMClientService.chatSync 发送一条测试消息，测量响应时长
   */
  async testProvider(id: string): Promise<ProviderTestResult> {
    const saved = this.getSavedProviders();
    const cfg = saved[id] as Record<string, unknown> | undefined;
    if (!cfg) {
      return { success: false, error: `Provider not found: ${id}` };
    }

    const baseUrl = typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : '';
    const apiKey = typeof cfg['apiKey'] === 'string' ? cfg['apiKey'] : '';

    // 本地服务连通性测试（ollama/lmstudio/vllm）：GET ${baseUrl}/api/tags 或 /models
    // 豁免 SSRF 校验：目标为用户本机/局域网服务（与旧版行为一致）
    if (id === 'ollama' || id === 'lmstudio' || id === 'vllm' || cfg['type'] === 'local') {
      const root = baseUrl || (id === 'lmstudio' ? 'http://localhost:1234/v1' : id === 'vllm' ? 'http://localhost:8000/v1' : 'http://localhost:11434');
      const url = id === 'ollama' && !root.endsWith('/v1')
        ? root.replace(/\/$/, '') + '/api/tags'
        : root.replace(/\/$/, '') + '/models';
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          return {
            success: true,
            latencyMs: Date.now() - start,
            latency: `${Date.now() - start}ms`,
            message: '本地服务连接正常',
          };
        }
        return { success: false, error: `HTTP ${res.status}` };
      } catch (err) {
        clearTimeout(timer);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (!apiKey) {
      return { success: false, error: '未配置API密钥' };
    }
    if (baseUrl && !this.security.checkUrlSync(baseUrl)) {
      return { success: false, error: `Provider baseUrl blocked by SSRF guard: ${baseUrl}` };
    }

    // 解析模型：优先 provider 配置的第一个模型，否则用 LLMClientService 默认
    const models = Array.isArray(cfg['models']) ? (cfg['models'] as unknown[]).map(String) : [];
    const model = models.length > 0 ? models[0] : this.llm.getDefaultModel();

    const start = Date.now();
    try {
      const result = await this.llm.chatSync({
        messages: [
          { role: 'system', content: 'You are a connectivity test endpoint. Reply with the single word: pong' },
          { role: 'user', content: 'ping' },
        ],
        model,
        providerId: id,
        stream: false,
      });
      const latencyMs = Date.now() - start;
      const ok = !!result.content && result.content.length > 0;
      return {
        success: ok,
        latencyMs,
        latency: `${latencyMs}ms`,
        model,
        message: ok ? '连接正常' : '空响应',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
        latency: `${Date.now() - start}ms`,
        model,
      };
    }
  }

  /**
   * 聚合所有 provider 的可用模型（统一模型体系）
   * - 遍历 listProviders，每个 provider 取其 models 数组（kind='chat'）
   * - 注册表中的 imageModels / videoModels 一并输出（kind='image' / 'video'，
   *   生成模型不支持视觉输入，vision 恒 false；available 跟随供应商配置状态）
   * - available = configured || type === 'local'
   * - vision = isVisionModel（仅 chat 模型判断：VISION_PROVIDERS/NON_VISION_MODELS/KEYWORDS 三级判断）
   */
  listModels(): { models: ModelItem[] } {
    const { providers } = this.listProviders();
    const saved = this.getSavedProviders() as Record<string, Record<string, any>>;
    const models: ModelItem[] = [];
    const pushChat = (p: ProviderListItem, list: string[]): void => {
      for (const m of list) {
        models.push({
          id: m,
          name: m,
          provider: p.id,
          providerId: p.id,
          providerName: p.name,
          available: p.configured || p.type === 'local',
          vision: (Array.isArray(saved[p.id]?.['visionModels']) ? saved[p.id]['visionModels'].includes(m) : isVisionModel(p.baseProvider || p.id, m)),
          kind: 'chat',
        });
      }
    };
    for (const p of providers) {
      pushChat(p, p.models || []);
      // 生成模型：注册表静态定义（设置页配置对应供应商 API key 后即可用，
      // 生成时传 model 名由 Image/VideoProviderService 自动路由到对应厂商）
      const reg = PROVIDERS_REGISTRY.find((r) => r.id === (p.baseProvider || p.id));
      const pushGen = (list: MediaModelEntry[] | undefined, kind: 'image' | 'video'): void => {
        for (const m of list ?? []) {
          models.push({
            id: (p.baseProvider || saved[p.id]?.[kind+'Protocol']) ? `${p.id}::${m.id}` : m.id,
            name: m.id,
            provider: p.id,
            providerId: p.id,
            providerName: p.name,
            available: p.configured || p.type === 'local',
            vision: false,
            kind,
          });
        }
      };
      for(const kind of ['image','video'] as const) {
        if(saved[p.id]?.[kind+'Protocol']==='none')continue;
        const declared=saved[p.id]?.[kind+'Models'];
        pushGen(Array.isArray(declared)?declared.map(id=>({id,traits:''})):kind==='image'?reg?.imageModels:reg?.videoModels,kind);
      }
    }
    return { models };
  }

  // ─── 内部工具 ──────────────────────────────────────────────

  /**
   * 启动时从环境变量自动配置供应商（移植自 start.cjs ADDITIONAL_PROVIDERS.autoConfigure）
   * - 遍历注册表中带 envKey 的非本地供应商
   * - 若环境变量存在且用户未配置该供应商，则自动写入（apiKey / baseUrl / models / maxTokens）
   * - 已存在的用户配置不会被覆盖
   */
  autoConfigureFromEnv(): number {
    const providers = this.getSavedProviders();
    let configured = 0;
    for (const reg of PROVIDERS_REGISTRY) {
      if (!reg.envKey || reg.type === 'local' || reg.type === 'custom') continue;
      const envVal = process.env[reg.envKey];
      if (envVal && !providers[reg.id]) {
        const entry: Record<string, unknown> = {
          apiKey: envVal,
          baseUrl: reg.baseUrl,
          models: reg.models,
        };
        if (PROVIDER_MAX_TOKENS[reg.id]) entry['maxTokens'] = PROVIDER_MAX_TOKENS[reg.id];
        if (reg.type === 'anthropic') entry['type'] = 'anthropic';
        providers[reg.id] = entry;
        configured++;
        this.logger.info('Auto-configured provider from env', { providerId: reg.id, name: reg.name });
      }
    }
    if (configured > 0) {
      this.config.set('providers', providers);
      this.config.save();
    }
    return configured;
  }

  /** 读取 config.providers 段（不存在时返回空对象） */
  private getSavedProviders(): Record<string, unknown> {
    try {
      const v = this.config.get<Record<string, unknown>>('providers');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
}
import { restoreRedactedConfig } from '../../core/logger/redacted-config.util.js';
