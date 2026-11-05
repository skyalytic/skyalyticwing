/** Official API catalog reviewed 2026-10-16. This is a template, not account entitlement.
 * Keep unsupported/native-only models in references, never in routable lists.
 * Saved provider configurations are deliberately not migrated by catalog updates. */
export interface MediaModelEntry { id: string; traits: string }
export interface ProviderRegistryEntry {
  id: string; name: string; type: 'openai' | 'anthropic' | 'local' | 'custom';
  region: string; baseUrl: string; envKey: string; models: string[];
  visionModels?: string[]; imageModels?: MediaModelEntry[]; videoModels?: MediaModelEntry[];
  imageProtocol?: string; videoProtocol?: string; imageBaseUrl?: string; videoBaseUrl?: string;
  mediaProviderId?: string;
  catalog?: {
    checkedAt: string; sources: string[]; note?: string; noteEn?: string;
    setup?: 'gateway' | 'deployment' | 'reference' | 'local';
    references?: Array<{ id: string; kind: 'chat' | 'image' | 'video' }>;
  };
}
const media = (...ids: string[]): MediaModelEntry[] => ids.map(id => ({ id, traits: id }));
const reviewed = (sources: string[], note?: string, noteEn?: string,
  extra: Partial<NonNullable<ProviderRegistryEntry['catalog']>> = {}) =>
  ({ checkedAt: '2026-10-16', sources, ...(note ? { note, noteEn: noteEn || note } : {}), ...extra });
const claude = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
// GPT-6 requires Responses for tool calling. Do not advertise it as a working
// agent preset while Wing's native text adapter uses Chat Completions.
const gpt = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const gemini = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'];
const qwenVision = ['qwen3.8-max', 'qwen3.8-max-prime', 'qwen3.8-flash', 'qwen3.8-omni-flash', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen3-vl-plus', 'qwen-vl-max', 'qvq-max'];
const kimi = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'];
const bailianPartnerVision = ['MiniMax/MiniMax-M3.1-Flash', 'xiaomi/mimo-v2.6-pro-ultraspeed', 'deepseek-v4.1-flash-1017'];
const mimo = ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed'];
const aggregateNote = '聚合平台的模型 ID、权限和能力以该平台目录为准，不与原厂 ID 混用。';
const aggregateNoteEn = 'Use this platform’s model IDs and access permissions; upstream IDs may differ.';

export const PROVIDERS_REGISTRY: ProviderRegistryEntry[] = [
  { id: 'custom', name: '自定义模型', type: 'custom', region: 'CUSTOM', baseUrl: '', envKey: '', models: [] },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', type: 'anthropic', region: 'US', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY',
    models: claude, visionModels: claude,
    catalog: reviewed(['https://platform.claude.com/docs/en/models/overview']),
  },
  {
    id: 'openai', name: 'OpenAI (GPT)', type: 'openai', region: 'US', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY',
    models: gpt, visionModels: gpt, mediaProviderId: 'openai',
    imageModels: media('gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'),
    imageProtocol: 'openai-images', imageBaseUrl: 'https://api.openai.com/v1',
    catalog: reviewed(['https://developers.openai.com/api/docs/models', 'https://developers.openai.com/api/docs/guides/image-generation', 'https://developers.openai.com/api/docs/models/gpt-6.1-sol', 'https://developers.openai.com/api/docs/models/gpt-6.1-terra'],
      'GPT-6 系列工具调用需要 Responses API，当前原厂文本适配为 Chat Completions，因此仅列入参考目录；图片生成可独立配置。',
      'GPT-6 tool calling requires the Responses API. Wing currently uses native Chat Completions, so GPT-6 is reference-only. Image generation is configured independently.',
      { checkedAt: '2026-10-27', references: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'].map(id => ({ id, kind: 'chat' as const })) }),
  },
  {
    id: 'azure', name: 'Azure OpenAI / Foundry', type: 'openai', region: 'CN/US', baseUrl: '', envKey: 'AZURE_OPENAI_API_KEY', models: [], visionModels: [],
    catalog: reviewed(['https://learn.microsoft.com/azure/ai-foundry/openai/how-to/switching-endpoints'],
      '填写你的资源 /openai/v1 地址和部署名称；可用模型与地区、部署有关，不能直接照抄原厂模型 ID。',
      'Enter your resource /openai/v1 endpoint and deployment name. Availability depends on your deployment and region.', { setup: 'deployment' }),
  },
  {
    id: 'google', name: 'Google AI (Gemini)', type: 'openai', region: 'US', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GOOGLE_API_KEY',
    models: gemini, visionModels: gemini, mediaProviderId: 'google',
    imageModels: media('gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'),
    imageProtocol: 'gemini', imageBaseUrl: 'https://generativelanguage.googleapis.com/v1',
    catalog: reviewed(['https://ai.google.dev/gemini-api/docs/models', 'https://ai.google.dev/gemini-api/docs/latest-model', 'https://ai.google.dev/gemini-api/docs/openai', 'https://ai.google.dev/gemini-api/docs/generate-content/image-generation', 'https://ai.google.dev/gemini-api/docs/video'],
      'Gemini 4 Argon 已发布，但 Wing 尚未完成该型号的工具连续调用验证，暂列参考。图片使用 Gemini 原生接口；Interactions / Veo 视频适配尚未启用。',
      'Gemini 4 Argon is released but tool continuation in Wing is not yet verified; reference only. Images use the native Gemini API; Interactions / Veo video adapters are not enabled.',
      { checkedAt: '2026-10-27', references: [{ id: 'gemini-4-argon', kind: 'chat' }, { id: 'gemini-omni-1.1-flash', kind: 'video' }, { id: 'veo-3.1-generate-preview', kind: 'video' }] }),
  },
  {
    id: 'bedrock', name: 'AWS Bedrock', type: 'anthropic', region: 'US', baseUrl: '', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://platform.claude.com/docs/en/models/overview', 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html'],
      '原生 Bedrock 需要 AWS 身份与区域配置；当前表单仅接入兼容 Messages 的网关，请填写网关地址和它的模型 ID。',
      'Native Bedrock requires AWS identity and region configuration. This form supports a Messages-compatible gateway with its own model IDs.',
      { setup: 'gateway', references: claude.map(id => ({ id: `anthropic.${id}`, kind: 'chat' as const })) }),
  },
  {
    id: 'grok', name: 'xAI Grok', type: 'openai', region: 'US', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY',
    models: ['grok-4.7', 'grok-4.3'], visionModels: ['grok-4.7', 'grok-4.3'], mediaProviderId: 'grok',
    imageModels: media('grok-imagine-image-2.0'), imageProtocol: 'xai', imageBaseUrl: 'https://api.x.ai/v1',
    videoModels: media('grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite'), videoProtocol: 'xai', videoBaseUrl: 'https://api.x.ai/v1',
    catalog: reviewed(['https://docs.x.ai/developers/models', 'https://docs.x.ai/developers/model-capabilities/video/generation']),
  },
  {
    id: 'mistral', name: 'Mistral AI', type: 'openai', region: 'EU', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY',
    models: ['mistral-large-4', 'mistral-large-latest', 'mistral-medium-3-5', 'mistral-small-latest', 'codestral-latest'],
    visionModels: ['mistral-large-4', 'mistral-large-latest', 'mistral-medium-3-5', 'mistral-small-latest'],
    catalog: reviewed(['https://docs.mistral.ai/models', 'https://docs.mistral.ai/models/mistral-large-4'], 'Large 4 为公开预览；latest 别名跟随厂商更新。', 'Large 4 is in public preview; latest aliases follow provider updates.'),
  },
  {
    id: 'groq', name: 'Groq', type: 'openai', region: 'US', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], visionModels: ['qwen/qwen3.8-27b'],
    catalog: reviewed(['https://console.groq.com/docs/models'], 'Qwen 为预览模型；Llama 需要企业权限。', 'Qwen is a preview model; Llama requires enterprise access.'),
  },
  {
    id: 'perplexity', name: 'Perplexity', type: 'openai', region: 'US', baseUrl: '', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://docs.perplexity.ai/docs/agent-api/quickstart'],
      '新 Agent API 不是 Chat Completions；原生适配未启用，不再预填旧 Sonar 模型。',
      'The new Agent API is not Chat Completions. Native support is not enabled; legacy Sonar IDs are no longer preset.', { setup: 'reference' }),
  },
  {
    id: 'openrouter', name: 'OpenRouter', type: 'openai', region: 'US', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY',
    models: ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna', 'anthropic/claude-fable-5.1', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash', 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-flash', 'z-ai/glm-5.3-flash', 'stepfun/step-5-preview'],
    visionModels: ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna', 'anthropic/claude-fable-5.1', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash', 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-flash', 'z-ai/glm-5.3-flash', 'stepfun/step-5-preview'],
    catalog: reviewed(['https://openrouter.ai/api/v1/models'], aggregateNote, aggregateNoteEn),
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', type: 'openai', region: 'US', baseUrl: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY',
    models: ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-ultra-550b-a55b', 'stepfun-ai/step-5-preview'],
    visionModels: ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'deepseek-ai/deepseek-v4.1-flash', 'stepfun-ai/step-5-preview'],
    catalog: reviewed(['https://build.nvidia.com/explore/discover', 'https://docs.api.nvidia.com/nim/reference/stepfun-ai-step-5-preview'], aggregateNote, aggregateNoteEn),
  },
  {
    id: 'together', name: 'Together AI', type: 'openai', region: 'US', baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY',
    models: ['deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4.1-Flash', 'MiniMaxAI/MiniMax-M3', 'moonshotai/Kimi-K3', 'Qwen/Qwen3.8-Flash', 'zai-org/GLM-5.3', 'zai-org/GLM-5.3-Flash', 'openai/gpt-oss-120b'],
    visionModels: ['deepseek-ai/DeepSeek-V4.1-Flash', 'MiniMaxAI/MiniMax-M3', 'moonshotai/Kimi-K3', 'Qwen/Qwen3.8-Flash', 'zai-org/GLM-5.3-Flash'],
    catalog: reviewed(['https://docs.together.ai/docs/serverless-models'], aggregateNote, aggregateNoteEn,
      { references: ['black-forest-labs/FLUX.2-pro', 'ideogram/ideogram-4.0'].map(id => ({ id, kind: 'image' as const })) }),
  },
  {
    id: 'vertex', name: 'Google Vertex AI', type: 'anthropic', region: 'US', baseUrl: '', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://cloud.google.com/vertex-ai/generative-ai/docs/model-garden/explore-models', 'https://platform.claude.com/docs/en/models/overview'],
      '原生 Vertex 需要 Google Cloud 身份、项目与区域；请使用兼容 Messages 网关，不能将服务账号文件当成 API Key。',
      'Native Vertex requires Google Cloud identity, project and region. Use a Messages-compatible gateway; a service-account file is not an API key.', { setup: 'gateway' }),
  },
  {
    id: 'qwen', name: '通义千问 Qwen (阿里)', type: 'openai', region: 'CN', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY',
    models: [...qwenVision, ...bailianPartnerVision, 'qwen3.7-max', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen-long'], visionModels: [...qwenVision, ...bailianPartnerVision], mediaProviderId: 'dashscope',
    imageModels: media('wan2.7-image-pro', 'wan2.7-image'), imageProtocol: 'dashscope', imageBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    videoModels: media('wan2.7-t2v', 'wan2.7-i2v'), videoProtocol: 'dashscope', videoBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    catalog: reviewed(['https://help.aliyun.com/zh/model-studio/model-pricing', 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference', 'https://help.aliyun.com/zh/model-studio/newly-released-models'],
      '默认北京区域；MiniMax、MiMo、DeepSeek 等合作模型须先在百炼开通。Wan 3.0 需要 WorkspaceId 专属端点与新输入格式，暂列为参考。',
      'Defaults to Beijing; enable partner models in Bailian before use. Wan 3.0 requires a workspace endpoint and a new input format; reference only.',
      { checkedAt: '2026-10-27', references: [{ id: 'qwen-image-3.0-pro', kind: 'image' }, { id: 'wan3.0-video', kind: 'video' }, { id: 'wan3.0-video-prime', kind: 'video' }, { id: 'happyhorse-1.1-t2v', kind: 'video' }] }),
  },
  {
    id: 'glm', name: '智谱 GLM (Zhipu)', type: 'openai', region: 'CN', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'ZHIPU_API_KEY',
    models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6v'],
    visionModels: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6v'], mediaProviderId: 'glm',
    imageModels: media('glm-image'), imageProtocol: 'zhipu', imageBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    catalog: reviewed(['https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash', 'https://docs.bigmodel.cn/api-reference/模型-api/图像生成'],
      'FlashX 不包含在当前 Coding Plan 中；FlashX Legal 面向企业定向开放，须申请开通，暂列参考。',
      'FlashX is not included in the current Coding Plan; FlashX Legal requires enterprise approval and is listed for reference.',
      { checkedAt: '2026-10-27', references: [{ id: 'glm-5.3-flashx-legal', kind: 'chat' }] }),
  },
  {
    id: 'deepseek', name: 'DeepSeek (深度求索)', type: 'openai', region: 'CN', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-flash', 'deepseek-v4-pro'], visionModels: ['deepseek-flash'],
    catalog: reviewed(['https://api-docs.deepseek.com/guides/vision/', 'https://api-docs.deepseek.com/quick_start/pricing'],
      'deepseek-flash 当前对应 DeepSeek-V4.1-Flash-1017；此处使用 DeepSeek 原厂 Key，不能混用华为云模型 ID。',
      'deepseek-flash currently serves DeepSeek-V4.1-Flash-1017. Use a DeepSeek API key and native model IDs.', { checkedAt: '2026-10-27' }),
  },
  {
    id: 'moonshot', name: '月之暗面 Kimi (Moonshot)', type: 'openai', region: 'CN', baseUrl: 'https://api.moonshot.cn/v1', envKey: 'MOONSHOT_API_KEY', models: kimi, visionModels: kimi,
    catalog: reviewed(['https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart', 'https://platform.kimi.com/docs/pricing/chat'],
      'K3.1 Pro / Highspeed 使用按量 API Key，需充值解锁；始终开启思考。不要使用 Kimi Code 订阅 Key。K2 系列计划于 2026 年底下线，请迁移。',
      'K3.1 Pro / Highspeed require a funded pay-as-you-go API key and always use thinking. Kimi Code subscription keys are separate. K2 retirement is planned for late 2026.', { checkedAt: '2026-10-27' }),
  },
  {
    id: 'qianfan', name: '百度文心 (Qianfan)', type: 'openai', region: 'CN', baseUrl: 'https://qianfan.baidubce.com/v2', envKey: 'QIANFAN_ACCESS_KEY',
    models: ['ernie-5.1', 'ernie-5.0', 'ernie-4.5-turbo-128k', 'ernie-4.5-turbo-vl'], visionModels: ['ernie-5.1', 'ernie-5.0', 'ernie-4.5-turbo-vl'],
    catalog: reviewed(['https://cloud.baidu.com/product/model.html', 'https://intl.cloud.baidu.com/en/doc/qianfan/s/7m95lyy43-intl-en'],
      '国内与国际站模型目录不同，请以千帆控制台授权的模型 ID 为准。', 'Mainland and international catalogs differ. Use model IDs authorized in your Qianfan console.'),
  },
  {
    id: 'doubao', name: '火山引擎 豆包 (Doubao)', type: 'openai', region: 'CN', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', envKey: 'VOLCENGINE_API_KEY',
    models: ['doubao-seed-evolving', 'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'],
    visionModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'], mediaProviderId: 'ark',
    imageModels: media('doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-260128'), imageProtocol: 'openai-compatible', imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    videoModels: media('doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'), videoProtocol: 'ark', videoBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    catalog: reviewed(['https://docs.volcengine.com/docs/ark/model-list?lang=zh', 'https://docs.volcengine.com/docs/ark/seedance-2-0?lang=en']),
  },
  {
    id: 'minimax', name: 'MiniMax (海螺AI)', type: 'openai', region: 'CN', baseUrl: 'https://api.minimax.cn/v1', envKey: 'MINIMAX_API_KEY', models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'], visionModels: ['MiniMax-M3.1-Flash', 'MiniMax-M3'], mediaProviderId: 'minimax',
    imageModels: media('image-01', 'image-01-live'), imageProtocol: 'minimax', imageBaseUrl: 'https://api.minimax.cn/v1',
    videoModels: media('MiniMax-H3', 'MiniMax-H3-Max'), videoProtocol: 'minimax', videoBaseUrl: 'https://api.minimax.cn/v2',
    catalog: reviewed(['https://platform.minimax.cn/docs/guides/models-intro', 'https://platform.minimax.cn/docs/api-reference/text-openai-api', 'https://platform.minimax.cn/docs/api-reference/video-generation-v2-create'],
      'M3.1 Flash 使用正式模型 ID MiniMax-M3.1-Flash，始终开启思考；按量和订阅 Key 的额度独立，模型权限以控制台为准。M2.5 / M2.7 将于 11 月 18 日下线。',
      'M3.1 Flash uses MiniMax-M3.1-Flash and always thinks. Pay-as-you-go and subscription keys have separate quotas; access depends on your console. M2.5 / M2.7 retire on Nov 18.',
      { checkedAt: '2026-10-27' }),
  },
  {
    id: 'hunyuan', name: '腾讯混元 Hunyuan / TokenHub', type: 'openai', region: 'CN', baseUrl: 'https://tokenhub.tencentcloudmaas.com/v1', envKey: 'HUNYUAN_API_KEY',
    models: ['hy4-preview', 'hy3', 'hunyuan-role-latest', 'hy-mt2-pro', 'hy-mt2-plus', 'hy-mt2-lite'], visionModels: [],
    catalog: reviewed(['https://cloud.tencent.com/document/product/1823/130051', 'https://intl.cloud.tencent.com/document/product/1300/78941?lang=en'],
      '使用 TokenHub 的 API Key；不同地区 Key 不互通。图片和视频原生接口尚未启用。',
      'Use a TokenHub API key for the selected region. Native image and video adapters are not enabled.',
      { references: [{ id: 'hy-image-v3.5-preview', kind: 'image' }, { id: 'hy-image-v3', kind: 'image' }, { id: 'minimax-video-h3', kind: 'video' }] }),
  },
  {
    id: 'xunfei', name: '讯飞星火 XunfeiSpark', type: 'openai', region: 'CN', baseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2', envKey: 'SPARK_API_KEY',
    models: ['spark-x2.5', 'spark-x2.5-4b', 'spark-x2.5-1.7b'], visionModels: [],
    catalog: reviewed(['https://www.xfyun.cn/doc/spark/Spark-X2.5.html'], '使用星辰 MaaS 按量 API Key；Token Plan 的地址不同。', 'Use a pay-as-you-go Astron MaaS key. Token Plan uses a different endpoint.'),
  },
  {
    id: 'xiaomi', name: '小米 MiMo', type: 'openai', region: 'CN', baseUrl: 'https://api.xiaomimimo.com/v1', envKey: 'XIAOMI_API_KEY', models: mimo, visionModels: mimo,
    catalog: reviewed(['https://mimo.mi.com/docs/zh-CN/updates/model', 'https://mimo.mi.com/docs/zh-CN'], 'V2.5 于 10 月 21 日停用，新模板使用 V2.6。', 'V2.5 retires on Oct 21; new templates use V2.6.'),
  },
  {
    id: 'baichuan', name: '百川 Baichuan', type: 'openai', region: 'CN', baseUrl: 'https://api.baichuan-ai.com/v1', envKey: 'BAICHUAN_API_KEY',
    models: ['Baichuan4-Turbo', 'Baichuan4-Air', 'Baichuan4'], visionModels: [], catalog: reviewed(['https://platform.baichuan-ai.com/docs-v2/api']),
  },
  {
    id: 'stepfun', name: '阶跃星辰 StepFun', type: 'openai', region: 'CN', baseUrl: 'https://api.stepfun.com/v1', envKey: 'STEPFUN_API_KEY',
    models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash', 'step-3.5-flash-2603'], visionModels: ['step-5-preview'],
    catalog: reviewed(['https://platform.stepfun.com/', 'https://github.com/stepfun-ai/Step-5-Preview']),
  },
  {
    id: 'siliconflow', name: 'SiliconFlow (硅基流动)', type: 'openai', region: 'CN', baseUrl: 'https://api.siliconflow.cn/v1', envKey: 'SILICONFLOW_API_KEY',
    models: ['deepseek-ai/DeepSeek-V4-Pro', 'zai-org/GLM-5.3', 'zai-org/GLM-5.2', 'moonshotai/Kimi-K2.7-Code', 'Pro/moonshotai/Kimi-K2.6', 'Qwen/Qwen3.8-27B'],
    visionModels: ['moonshotai/Kimi-K2.7-Code', 'Pro/moonshotai/Kimi-K2.6', 'Qwen/Qwen3.8-27B'], mediaProviderId: 'siliconflow',
    imageModels: media('Qwen/Qwen-Image', 'Kwai-Kolors/Kolors'), imageProtocol: 'siliconflow', imageBaseUrl: 'https://api.siliconflow.cn/v1',
    catalog: reviewed(['https://docs.siliconflow.cn/docs/release-notes/overview', 'https://docs.siliconflow.cn/docs/userguide/capabilities/vision'],
      '目录会随平台调整；可用模型请核对模型广场。编辑专用模型不作为文生图默认项。',
      'Availability changes with the platform catalog. Image-edit-only models are not text-to-image defaults.'),
  },
  {
    id: 'cohere', name: 'Cohere', type: 'openai', region: 'CA', baseUrl: 'https://api.cohere.ai/compatibility/v1', envKey: 'COHERE_API_KEY',
    models: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-reasoning-08-2025', 'command-a-vision-07-2025', 'command-r7b-12-2024'],
    visionModels: ['command-a-plus-05-2026', 'command-a-vision-07-2025'],
    catalog: reviewed(['https://docs.cohere.com/docs/models', 'https://docs.cohere.com/docs/compatibility-api']),
  },
  {
    id: 'cerebras', name: 'Cerebras', type: 'openai', region: 'US', baseUrl: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY',
    models: ['gpt-oss-120b', 'qwen-3.8-27b'], visionModels: ['qwen-3.8-27b'],
    catalog: reviewed(['https://inference-docs.cerebras.ai/models/overview'], '图像输入为预览能力，以账户权限为准。', 'Image input is a preview capability subject to account access.'),
  },
  {
    id: 'modelscope', name: 'ModelScope (魔搭)', type: 'openai', region: 'CN', baseUrl: 'https://api-inference.modelscope.cn/v1', envKey: 'MODELSCOPE_API_KEY',
    models: ['inclusionAI/Ling-2.6-1T:inclusionAI', 'inclusionAI/Ling-2.6-flash:inclusionAI'], visionModels: [],
    catalog: reviewed(['https://www.modelscope.cn/models/inclusionAI/Ling-2.6-1T/', 'https://www.modelscope.cn/models/inclusionAI/Ling-2.6-flash'], aggregateNote, aggregateNoteEn),
  },
  {
    id: 'runway', name: 'Runway', type: 'openai', region: 'US', baseUrl: 'https://api.dev.runwayml.com/v1', envKey: 'RUNWAY_API_KEY', models: [], visionModels: [], mediaProviderId: 'runway',
    videoModels: media('gen4.5', 'gen4_turbo'), videoProtocol: 'runway', videoBaseUrl: 'https://api.dev.runwayml.com/v1',
    catalog: reviewed(['https://docs.dev.runwayml.com/guides/models/'], '仅用于视频生成；Gen-4 Turbo 需要输入图片。', 'Video generation only; Gen-4 Turbo requires an input image.'),
  },
  {
    id: 'ideogram', name: 'Ideogram', type: 'openai', region: 'US', baseUrl: 'https://api.ideogram.ai/v2', envKey: 'IDEOGRAM_API_KEY', models: [], visionModels: [],
    imageModels: media('ideogram-4-5', 'ideogram-4'), imageProtocol: 'ideogram', imageBaseUrl: 'https://api.ideogram.ai/v2',
    catalog: reviewed(['https://developer.ideogram.ai/ideogram-api/api-overview'], '仅用于图片生成，使用 Ideogram 原生接口。', 'Image generation only, using the native Ideogram API.'),
  },
  {
    id: 'bfl', name: 'Black Forest Labs (FLUX)', type: 'openai', region: 'EU', baseUrl: '', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://docs.bfl.ai/quick_start/generating_images'],
      '原厂接口使用异步图片任务，当前尚未启用；如使用聚合平台，请按该平台的模型 ID 与协议配置。',
      'The native asynchronous image API is not enabled. For aggregator access, use that platform’s model IDs and protocol.',
      { setup: 'reference', references: ['flux-2-max', 'flux-2-pro-preview', 'flux-2-pro', 'flux-2-flex', 'flux-2-klein-9b-preview', 'flux-2-klein-4b'].map(id => ({ id, kind: 'image' as const })) }),
  },
  {
    id: 'vidu', name: 'Vidu (生数)', type: 'openai', region: 'CN', baseUrl: '', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://platform.vidu.com/docs/model-map', 'https://platform.vidu.com/docs/reference-to-video'],
      '已收录 Vidu 最新模型，原生视频任务协议尚未启用。',
      'Current Vidu models are listed; the native video task protocol is not enabled.',
      { setup: 'reference', references: ['viduq4-preview', 'viduq3-pro', 'viduq3-mix', 'viduq3-drama', 'viduq3-ad', 'viduq3-turbo'].map(id => ({ id, kind: 'video' as const })) }),
  },
  {
    id: 'ollama', name: 'Ollama (本地)', type: 'local', region: 'LOCAL', baseUrl: 'http://localhost:11434/v1', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://docs.ollama.com/api/openai-compatibility'], '填写本机已下载模型的名称；云端模型名单不代表本机已经安装。', 'Enter the names of locally installed models. A cloud catalog does not indicate what is installed.', { setup: 'local' }),
  },
  {
    id: 'lmstudio', name: 'LM Studio (本地)', type: 'local', region: 'LOCAL', baseUrl: 'http://localhost:1234/v1', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://lmstudio.ai/docs/developer/openai-compat'], '填写本地服务已加载的模型 ID，并按该模型能力填写视觉列表。', 'Enter loaded model IDs and explicitly configure supported vision models.', { setup: 'local' }),
  },
  {
    id: 'vllm', name: 'vLLM (自托管)', type: 'local', region: 'LOCAL', baseUrl: 'http://localhost:8000/v1', envKey: '', models: [], visionModels: [],
    catalog: reviewed(['https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html'], '使用服务启动时的 served-model-name；远程服务可配置 API Key。', 'Use the server’s served-model-name; remote servers may require an API key.', { setup: 'local' }),
  },
];

/** Fresh copies: form edits must never mutate the global catalog. */
export function providerCapabilityDefaults(reg?: ProviderRegistryEntry) {
  return {
    visionModels: [...(reg?.visionModels || [])],
    imageModels: reg?.imageModels?.map(m => m.id) || [],
    videoModels: reg?.videoModels?.map(m => m.id) || [],
    imageProtocol: reg?.imageProtocol || 'none', videoProtocol: reg?.videoProtocol || 'none',
    imageBaseUrl: reg?.imageBaseUrl || '', videoBaseUrl: reg?.videoBaseUrl || '',
  };
}
