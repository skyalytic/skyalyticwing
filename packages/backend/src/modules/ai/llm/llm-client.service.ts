import { compactContext, estimateContextTokens } from '../agent/context-compaction.js';
import { Injectable } from '@nestjs/common';
import type { TokenUsage, ToolCallInfo } from '@skyalyticwing/shared';
import { ConfigService } from '../../core/config/config.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import type { ChatChunk, ChatParams, LlmMessage, ProviderConfig } from '../types.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { PROVIDERS_REGISTRY } from './provider-catalog.js';

/** 默认模型（无任何 provider 配置模型时回退） */
const DEFAULT_MODEL = 'gpt-4o';
/** 已知 Anthropic 模型（Anthropic 无公开 /models 列表端点；2026-10-03 按
 * anthropic.com/claude/fable 官方页面 + platform.claude.com 校准：Fable 5/5.1 公开可调，
 * opus-5-5/sonnet-5-5 为 9-22 新发布，opus-4-1/3-7-sonnet-latest 已退役；
 * Mythos 5 走 Project Glasswing 受控访问不对普通 API 开放，故不列） */
const ANTHROPIC_MODELS = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-sonnet-4-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-sonnet-4-0',
  'claude-opus-4-0',
  'claude-3-5-haiku-latest',
];

// ---------------------------------------------------------------------------
// 上下文压缩相关常量（从 start.cjs compactMessages 移植）
// ---------------------------------------------------------------------------

/** 默认最大上下文 Token 数 */
const MAX_CONTEXT_TOKENS = 120_000;
/** 容量阈值：达到 80% 时触发压缩 */
const COMPACTION_THRESHOLD = 0.8;
/** 压缩时保留最近的消息条数 */
const COMPACTION_KEEP_RECENT = 10;

// ---------------------------------------------------------------------------
// Provider 默认 baseUrl（从 start.cjs PROVIDER_DEFAULT_URLS 移植）
// 用于 resolveProviderForModel 中模型名反查提供商时的 baseUrl 回退
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  azure: '',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  bedrock: '',
  grok: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  perplexity: 'https://api.perplexity.ai',
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  together: 'https://api.together.xyz/v1',
  vertex: '',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.cn/v1',
  qianfan: 'https://qianfan.baidubce.com/v2',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  minimax: 'https://api.minimaxi.com/v1',
  hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
  xunfei: 'https://spark-api-open.xf-yun.com/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  baichuan: 'https://api.baichuan-ai.com/v1',
  stepfun: 'https://api.stepfun.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  vllm: 'http://localhost:8000/v1',
};

/** 本地/自托管供应商（豁免 SSRF 私有地址拦截：目标为用户本机/局域网服务，与旧版行为一致） */
const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'vllm']);

/**
 * 模型名 → Provider ID 提示映射（从 start.cjs resolveProviderForModel 移植）。
 * 当配置中未显式声明模型归属时，按模型名前缀正则推断所属提供商。
 */
const MODEL_HINTS: ReadonlyArray<{ re: RegExp; pid: string }> = [
  { re: /^(gpt|o[34]|dall)/i, pid: 'openai' },
  { re: /^claude/i, pid: 'anthropic' },
  { re: /^deepseek/i, pid: 'deepseek' },
  { re: /^(qwen|qwq)/i, pid: 'qwen' },
  { re: /^glm|chatglm/i, pid: 'glm' },
  { re: /^(moonshot|kimi)/i, pid: 'moonshot' },
  { re: /^gemini/i, pid: 'google' },
  { re: /^grok/i, pid: 'grok' },
  { re: /^(llama|nemotron)/i, pid: 'openrouter' },
  { re: /^(mixtral|mistral|devstral|codestral|pixtral)/i, pid: 'mistral' },
  { re: /^(doubao)/i, pid: 'doubao' },
  { re: /^minimax/i, pid: 'minimax' },
  { re: /^baichuan/i, pid: 'baichuan' },
  { re: /^step/i, pid: 'stepfun' },
  { re: /^hunyuan/i, pid: 'hunyuan' },
  { re: /^(spark|xunfei)/i, pid: 'xunfei' },
  { re: /^ernie/i, pid: 'qianfan' },
  { re: /^mimo/i, pid: 'xiaomi' },
  { re: /^sonar/i, pid: 'perplexity' },
];

/** CJK 字符正则（中日韩统一表意文字 + 平假名/片假名 + 韩文音节） */

/** getActiveProvider 返回的活跃提供商信息 */
export interface ActiveProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
  models: unknown[];
  temperature?: number;
  maxTokens?: number;
}

/** resolveProviderForModel 返回的按模型解析出的提供商信息 */
export interface ResolvedProviderForModel {
  id: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLMClientService - 统一 LLM 客户端
 *
 * 职责：
 *   - 从 ConfigService 读取 provider 配置（apiKey / baseUrl / type / models）
 *   - apiKey 中的 `${ENV_VAR}` 替换为 process.env[ENV_VAR]
 *   - 根据 provider 类型路由到 OpenAI 兼容适配器或 Anthropic 适配器
 *   - SSRF fail-close：调用前对 baseUrl 做 SecurityManagerService.checkUrl 校验
 *   - 提供 chat（流式）/ chatSync（非流式聚合）/ listModels 接口
 */
@Injectable()
export class LLMClientService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
    private readonly openai: OpenAIAdapter,
    private readonly anthropic: AnthropicAdapter,

  ) {}

  /** 流式聊天 */
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    let providerId: string;
    let cfg: ProviderConfig;
    try {
      params = this.routeRequiredCapability(params);
      const inferred = params.providerId ? undefined : this.resolveProviderForModel(params.model);
      const resolved = this.resolveProvider(params.providerId ?? inferred?.id);
      providerId = resolved.providerId;
      cfg = resolved.config;
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }

    // SSRF fail-close（checkUrl 为 async，必须 await 取回结果）
    // 本地供应商豁免：ollama/lmstudio/vllm 目标为本机/局域网服务（与旧版行为一致）
    if (!LOCAL_PROVIDER_IDS.has(providerId)) {
      const ssrfCheck = await this.security.checkUrl(cfg.baseUrl);
      if (!ssrfCheck.safe) {
        yield { type: 'error', error: `Provider baseUrl blocked by SSRF guard (${ssrfCheck.reason}): ${cfg.baseUrl}` };
        return;
      }
    }

    this.logger.debug('LLM chat request', { providerId, model: params.model });
    const adapter = cfg.type === 'anthropic' ? this.anthropic : this.openai;
    yield* adapter.chat(params, cfg);
  }

  private routeRequiredCapability(params:ChatParams):ChatParams {
    const entries=this.getProvidersConfig() as Record<string,Record<string,any>>;
    const parts=params.model.split('::'),raw=parts.length>1?parts.slice(1).join('::'):params.model;
    const selectedId=params.providerId || (parts.length>1?parts[0]:Object.keys(entries).find(id=>['models','visionModels','imageModels','videoModels'].some(k=>entries[id]?.[k]?.includes(raw))));
    if(parts.length>1 && selectedId)params={...params,providerId:selectedId,model:raw};
    const selected=selectedId?entries[selectedId]:undefined;
    const visual=params.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
    const generation=['imageModels','videoModels'].some(k=>selected?.[k]?.includes(raw));
    const supportsVision=(id:string,p:Record<string,any>,model:string)=>Array.isArray(p['visionModels'])?p['visionModels'].includes(model):!!PROVIDERS_REGISTRY.find(r=>r.id===(p['baseProvider'] || id))?.visionModels?.includes(model);
    const missingTools=!!params.tools?.length && selected?.['supportsTools']===false;
    if(!generation && !missingTools && (!visual || (selectedId && selected && supportsVision(selectedId,selected,raw))))return params;
    const ordered=Object.entries(entries).sort(([a],[b])=>Number(b===selectedId)-Number(a===selectedId));
    for(const [id,p] of ordered) {
      if(!p['apiKey'] && !LOCAL_PROVIDER_IDS.has(id))continue;
      if(params.tools?.length && p['supportsTools']===false)continue;
      const choices: string[] = visual ? p['visionModels'] || (p['models'] || []).filter((m:string)=>supportsVision(id,p,m)) : p['models'] || [];
      const model=choices.find(m=>!p['imageModels']?.includes(m)&&!p['videoModels']?.includes(m));
      if(model)return {...params,providerId:id,model};
    }
    throw new Error('The selected model does not support this task. Configure a model with the required capability.');
  }


  /** 非流式聊天：聚合流式响应为最终结果 */
  async chatSync(
    params: ChatParams,
  ): Promise<{ content: string; reasoningContent?: string; toolCalls?: ToolCallInfo[]; usage?: TokenUsage }> {
    let content = '';
    let reasoningContent: string | undefined;
    const toolCalls: ToolCallInfo[] = [];
    let usage: TokenUsage | undefined;

    for await (const chunk of this.chat(params)) {
      if (chunk.type === 'content' && chunk.content) {
        content += chunk.content;
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        toolCalls.push({
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          arguments: chunk.toolCall.arguments,
        });
      } else if (chunk.type === 'done') {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.reasoningContent !== undefined) reasoningContent = chunk.reasoningContent;
      } else if (chunk.type === 'error' && chunk.error) {
        throw new Error(chunk.error);
      }
    }

    const result: { content: string; reasoningContent?: string; toolCalls?: ToolCallInfo[]; usage?: TokenUsage } = { content };
    if (reasoningContent !== undefined) result.reasoningContent = reasoningContent;
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    if (usage) result.usage = usage;
    return result;
  }

  /** 列出指定 provider 支持的模型 */
  async listModels(providerId: string): Promise<string[]> {
    const cfg = this.resolveProvider(providerId).config;
    const fallback = cfg.models ?? [];

    // 本地供应商豁免 SSRF：目标为本机/局域网服务（与旧版行为一致）
    if (!LOCAL_PROVIDER_IDS.has(providerId)) {
      const ssrfListCheck = await this.security.checkUrl(cfg.baseUrl);
      if (!ssrfListCheck.safe) return fallback;
    }
    if (cfg.type === 'anthropic') {
      return Array.from(new Set([...ANTHROPIC_MODELS, ...fallback]));
    }

    // OpenAI 兼容：GET ${baseUrl}/models
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/models`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json: any = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        const ids: string[] = [];
        for (const m of data) {
          if (m && typeof m.id === 'string') ids.push(m.id);
        }
        return Array.from(new Set([...ids, ...fallback]));
      }
    } catch {
      clearTimeout(timer);
      // 落到 fallback
    }
    return fallback;
  }

  /** 获取默认 provider ID（配置中的第一个 provider） */
  getDefaultProviderId(): string {
    const providers = this.getProvidersConfig();
    const ids = Object.keys(providers);
    if (ids.length === 0) throw new Error('No providers configured');
    return ids[0];
  }

  /** 获取默认模型（默认 provider 的第一个模型，否则回退 gpt-4o） */
  getDefaultModel(): string {
    return this.resolveModel(DEFAULT_MODEL);
  }

  /** 读取并解析 provider 配置，apiKey 完成环境变量替换 */
  private resolveProvider(providerId?: string): { providerId: string; config: ProviderConfig } {
    const providers = this.getProvidersConfig();
    const ids = Object.keys(providers);
    if (ids.length === 0) throw new Error('No providers configured');

    const pid = providerId ?? ids[0];
    const raw = providers[pid] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Provider '${pid}' not found`);
    }

    const isLocal = LOCAL_PROVIDER_IDS.has(pid) || raw['type'] === 'local';
    const apiKey = resolveEnvVars(typeof raw['apiKey'] === 'string' ? raw['apiKey'] : '');
    const baseUrl = typeof raw['baseUrl'] === 'string' ? raw['baseUrl'] : '';
    // 本地供应商（ollama/lmstudio/vllm）无需密钥；云端供应商必须提供
    if (!apiKey && !isLocal) throw new Error(`Provider '${pid}' missing apiKey`);
    if (!baseUrl) throw new Error(`Provider '${pid}' missing baseUrl`);

    const isAnthropic = raw['type'] === 'anthropic' || pid === 'anthropic';
    const type: 'openai' | 'anthropic' = isAnthropic ? 'anthropic' : 'openai';
    const models = Array.isArray(raw['models']) ? (raw['models'] as unknown[]).map(String) : undefined;

    const config: ProviderConfig = { id: pid, apiKey, baseUrl, type };
    if (models) config.models = models;
    return { providerId: pid, config };
  }

  private getProvidersConfig(): Record<string, unknown> {
    try {
      return this.config.get<Record<string, unknown>>('providers');
    } catch {
      return {};
    }
  }

  // ===========================================================================
  // 任务2: 上下文压缩（estimateTokens + compactMessages）
  // 从 start.cjs 第 2873-2989 行移植
  // ===========================================================================

  /**
   * 估算消息列表的 Token 数（CJK 感知）。
   *
   * 规则（与 .cjs 一致）：
   *   - CJK 字符（中日韩）按 1.5 字/token 估算
   *   - 其他字符按 4 字/token 估算
   *   - content 为字符串时直接统计
   *   - 多模态文本正常计入；图片按固定近似值预留，不把 base64 当文本计数
   *   - toolCalls 整体 JSON.stringify 后统计
   */
  estimateTokens(messages: LlmMessage[]): number {
    return estimateContextTokens(messages);
  }

  /** Compatibility entry point: share tool-safe, data-role compaction with the agent. */
  compactMessages(messages: LlmMessage[], sessionId: string): LlmMessage[] {
    if (this.estimateTokens(messages) < this.getMaxContextTokens() * COMPACTION_THRESHOLD) return messages;
    this.logger.info('Compacting model context', { sessionId });
    return compactContext(messages, COMPACTION_KEEP_RECENT);
  }
  /** 读取 maxContextTokens 配置（缺失时回退默认值）。公开供 AgentLoop 发前自动压缩判断阈值 */
  getMaxContextTokens(_modelId?: string): number {
    try {
      const all = this.config.getAll() as Record<string, unknown>;
      const v = all['maxContextTokens'];
      if (typeof v === 'number' && v > 0) return v;
    } catch {
      // ignore
    }
    return MAX_CONTEXT_TOKENS;
  }

  // ===========================================================================
  // 任务4: 提供商解析（getActiveProvider + resolveModel + resolveProviderForModel）
  // 从 start.cjs 第 4532-4669 行移植
  // ===========================================================================

  /**
   * 获取活跃提供商：遍历配置中的 providers，返回第一个有 apiKey
   * （ollama 可仅有 baseUrl）的提供商，附带其模型列表。
   *
   * 修复点（与 .cjs 一致）：返回当前 provider 自己的模型列表，
   * 而非所有 provider 的模型汇总，避免 resolveModel 返回其他 provider 的模型
   * 却用当前 provider 的 key 调用导致 404。
   */
  getActiveProvider(): ActiveProvider | null {
    const providers = this.getProvidersConfig();
    for (const id of Object.keys(providers)) {
      const prov = providers[id] as Record<string, unknown> | undefined;
      if (!prov) continue;
      const apiKey = typeof prov['apiKey'] === 'string' ? prov['apiKey'] : '';
      const baseUrl = typeof prov['baseUrl'] === 'string' ? prov['baseUrl'] : '';
      // ollama 可仅有 baseUrl（本地模型无需 apiKey）
      const isOllamaWithBaseUrl = id === 'ollama' && baseUrl;
      if (!apiKey && !isOllamaWithBaseUrl) continue;

      // 优先使用 provider 自身配置的模型列表
      let provModels: unknown[] = Array.isArray(prov['models'])
        ? (prov['models'] as unknown[])
        : [];

      // 若 provider 未配置模型，回退到默认 baseUrl 注册表（PROVIDER_DEFAULT_URLS 不含模型，
      // 此处保留与 .cjs PROVIDERS_REGISTRY 一致的回退语义：空列表）
      if (provModels.length === 0) {
        provModels = [];
      }

      const result: ActiveProvider = {
        id,
        baseUrl,
        apiKey,
        models: provModels,
      };
      if (typeof prov['temperature'] === 'number') {
        result.temperature = prov['temperature'];
      }
      if (typeof prov['maxTokens'] === 'number') {
        result.maxTokens = prov['maxTokens'];
      }
      return result;
    }
    return null;
  }

  /**
   * 解析模型名称（支持别名/回退）。
   *
   * 优先级（与 .cjs 一致）：
   *   1. config.general.defaultModel
   *   2. 活跃 provider 的第一个模型
   *   3. 遍历所有有 apiKey 的 provider，取第一个有模型的 provider 的首个模型
   *   4. fallbackModel
   */
  resolveModel(fallbackModel?: string): string {
    // 1. 配置中的默认模型
    try {
      const general = this.config.get<Record<string, unknown>>('general');
      const m = typeof general['defaultModel'] === 'string' ? general['defaultModel'] : '';
      if (m) return m;
    } catch {
      // ignore
    }

    // 2. 活跃 provider 的第一个模型
    const prov = this.getActiveProvider();
    if (prov && prov.models && prov.models.length > 0) {
      const first = prov.models[0];
      return typeof first === 'object' && first !== null
        ? String((first as Record<string, unknown>)['id'] ?? '')
        : String(first);
    }

    // 3. 遍历所有有 apiKey 的 provider
    const provs = this.getProvidersConfig();
    for (const pid of Object.keys(provs)) {
      const p = provs[pid] as Record<string, unknown> | undefined;
      if (!p || (!p['apiKey'] && !LOCAL_PROVIDER_IDS.has(pid) && p['type'] !== 'local')) continue;
      const pModels = Array.isArray(p['models']) ? (p['models'] as unknown[]) : [];
      if (pModels.length > 0) {
        const pm = pModels[0];
        return typeof pm === 'object' && pm !== null
          ? String((pm as Record<string, unknown>)['id'] ?? '')
          : String(pm);
      }
    }

    // 4. 回退
    return fallbackModel ?? '';
  }

  /**
   * 根据模型名反查提供商。
   *
   * 查找顺序（与 .cjs 一致）：
   *   1. 精确匹配：遍历有 apiKey 的 provider，模型 ID 完全匹配（大小写不敏感）
   *   2. 前缀匹配：模型 ID 前 2 段（按 - 分割）作为子串匹配
   *   3. 模型名提示：按 MODEL_HINTS 正则推断 provider ID，使用 PROVIDER_DEFAULT_URLS 回退 baseUrl
   *   4. 均未命中 → null
   */
  resolveProviderForModel(modelName: string): ResolvedProviderForModel | null {
    if (!modelName) return null;
    const mLower = modelName.toLowerCase();
    const provs = this.getProvidersConfig();

    // 1. 精确匹配
    for (const pid of Object.keys(provs)) {
      const p = provs[pid] as Record<string, unknown> | undefined;
      if (!p || (!p['apiKey'] && !LOCAL_PROVIDER_IDS.has(pid) && p['type'] !== 'local')) continue;
      const pModels = Array.isArray(p['models']) ? (p['models'] as unknown[]) : [];
      for (const pm of pModels) {
        const mid =
          typeof pm === 'object' && pm !== null
            ? String((pm as Record<string, unknown>)['id'] ?? '')
            : String(pm);
        if (mid && mid.toLowerCase() === mLower) {
          return this.buildResolvedProvider(pid, p, mid);
        }
      }
    }

    // 2. 前缀匹配（模型 ID 前 2 段）
    for (const pid2 of Object.keys(provs)) {
      const p2 = provs[pid2] as Record<string, unknown> | undefined;
      if (!p2 || !p2['apiKey']) continue;
      const pModels2 = Array.isArray(p2['models']) ? (p2['models'] as unknown[]) : [];
      for (const pm2 of pModels2) {
        const mid2 =
          typeof pm2 === 'object' && pm2 !== null
            ? String((pm2 as Record<string, unknown>)['id'] ?? '')
            : String(pm2);
        if (mid2) {
          const prefix = mid2.toLowerCase().split('-').slice(0, 2).join('-');
          if (prefix && mLower.indexOf(prefix) >= 0) {
            return this.buildResolvedProvider(pid2, p2, modelName);
          }
        }
      }
    }

    // 3. 模型名提示
    for (const hint of MODEL_HINTS) {
      if (hint.re.test(modelName)) {
        const hintPid = hint.pid;
        const hp = provs[hintPid] as Record<string, unknown> | undefined;
        if (hp && hp['apiKey']) {
          const baseUrl =
            (typeof hp['baseUrl'] === 'string' ? hp['baseUrl'] : '') ||
            PROVIDER_DEFAULT_URLS[hintPid] ||
            '';
          const result: ResolvedProviderForModel = {
            id: hintPid,
            apiKey: String(hp['apiKey']),
            baseUrl,
            model: modelName,
          };
          if (typeof hp['temperature'] === 'number') {
            result.temperature = hp['temperature'];
          }
          if (typeof hp['maxTokens'] === 'number') {
            result.maxTokens = hp['maxTokens'];
          }
          return result;
        }
      }
    }

    // 4. 未命中
    return null;
  }

  /** 从 provider 配置构建 ResolvedProviderForModel */
  private buildResolvedProvider(
    pid: string,
    p: Record<string, unknown>,
    model: string,
  ): ResolvedProviderForModel {
    const result: ResolvedProviderForModel = {
      id: pid,
      apiKey: String(p['apiKey'] ?? ''),
      baseUrl: typeof p['baseUrl'] === 'string' ? p['baseUrl'] : '',
      model,
    };
    if (typeof p['temperature'] === 'number') {
      result.temperature = p['temperature'];
    }
    if (typeof p['maxTokens'] === 'number') {
      result.maxTokens = p['maxTokens'];
    }
    return result;
  }
}

/**
 * 环境变量替换：将 `${ENV_VAR}` 替换为 process.env[ENV_VAR]。
 * 未定义的环境变量替换为空字符串。
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? '');
}
