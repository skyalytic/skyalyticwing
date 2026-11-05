/** AI 提供商 ID */
export const PROVIDER_IDS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  QWEN: 'qwen',
  DEEPSEEK: 'deepseek',
  MOONSHOT: 'moonshot',
  ZHIPU: 'zhipu',
  BAICHUAN: 'baichuan',
  MINIMAX: 'minimax',
  YI: 'yi',
  GROQ: 'groq',
  TOGETHER: 'together',
  OPENROUTER: 'openrouter',
  XAI: 'xai',
  /** TypeSafe AI：System One 决策模型（Jev，非 OpenAI 兼容 /v1/systemone 接口） */
  TYPESAFE: 'typesafe',
} as const;

/**
 * 视觉模型关键词（按模型 id 前缀/关键词判断是否支持图像输入）。
 * 2026-09-27 按各家官方文档校正：Claude 全系支持图像（官方声明 all current models
 * support text and image input）；GLM 视觉为 5v / 4.6v / 4.5v / 5.3-flash 系
 * （glm-5.3 / glm-5 旗舰为纯文本，官方定价页明确无图像输入）；
 * DeepSeek 官方视觉 id 为 deepseek-flash（deepseek-v4-pro 官方明确无视觉）。
 */
export const VISION_MODEL_KEYWORDS = [
  'vision',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-5',
  'gpt-6',
  'claude-3',
  'claude-sonnet',
  'claude-opus',
  'claude-haiku',
  'claude-fable',
  'claude-mythos',
  'gemini',
  'qwen-vl',
  'qwen3-vl',
  'qwen3.8',
  'glm-4v',
  'glm-4.5v',
  'glm-4.6v',
  'glm-5v',
  'glm-5.3-flash',
  'kimi-k',
  'yi-vision',
  'minimax-vision',
  'deepseek-flash',
  'muse-spark',
];

/** 不支持视觉的模型 */
export const NON_VISION_MODELS = [
  'gpt-3.5',
  'deepseek-chat',
  'deepseek-coder',
  'deepseek-v4-pro',
  'qwen-turbo',
  'qwen-plus',
  'qwen-max',
  'glm-3',
  'glm-4-flash',
  'baichuan-7b',
  'baichuan-13b',
  'jev',
];

/** 提供商默认 API URL */
export const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  baichuan: 'https://api.baichuan-ai.com/v1',
  minimax: 'https://api.minimax.chat/v1',
  yi: 'https://api.lingyiwanwu.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  /** Jev 走专用 System One 接口（POST /v1/systemone），不可当 OpenAI 兼容聊天模型用 */
  typesafe: 'https://api.typesafe.ai/v1',
};

/**
 * 2026-09 推荐模型清单（2026-09-27 逐家官方文档核实后修订：
 * docs.claude.com / platform.openai.com/docs/models / ai.google.dev / docs.x.ai /
 * docs.bigmodel.cn / platform.kimi.com / help.aliyun.com / api-docs.deepseek.com / typesafe.ai）。
 * 用途：前端"推荐模型"引导 / CLI models --recommended / 新装用户快速选择。
 * 注意：这是**提示清单**而非可用性保证——实际可用以用户配置的 provider 为准；
 * Jev 属于 System One 决策模型（kind: 'decision'），只用于 choice/score/noul 决策调用。
 */
export const RECOMMENDED_MODELS: Array<{
  providerId: string;
  id: string;
  name: string;
  kind: 'chat' | 'reasoning' | 'decision';
  note?: string;
}> = [
  // Anthropic（2026-10-03 重扫：opus-4-1 已于 8-05 退役、3-7-sonnet-latest 已退役，
  // 新增 opus-5-5 / sonnet-5-5（2026-09-22 发布）；Mythos 5 走 Project Glasswing 受控
  // 访问不对普通 API 开放，故不列；全系支持视觉）
  { providerId: 'anthropic', id: 'claude-fable-5-1', name: 'Claude Fable 5.1', kind: 'reasoning', note: '当前旗舰，1M 上下文，长任务/编码最强，$10/$50' },
  { providerId: 'anthropic', id: 'claude-fable-5', name: 'Claude Fable 5', kind: 'reasoning', note: '上一代旗舰（2026-06-09 发布，7 月恢复开放）' },
  { providerId: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', kind: 'reasoning', note: '最强 Opus 级（2026-09-22 发布）' },
  { providerId: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', kind: 'reasoning', note: '最新 Sonnet 级（2026-09-22 发布）' },
  { providerId: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', kind: 'reasoning', note: '上一代主力' },
  { providerId: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8', kind: 'reasoning', note: 'Fable 安全降级的回退模型' },
  { providerId: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', kind: 'chat', note: '快速轻量' },
  // OpenAI（2026-10-03 重扫：新增 gpt-6.1-sol；o3-pro 已下线；gpt-5.3-codex 标 Deprecated 仍可调）
  { providerId: 'openai', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', kind: 'reasoning', note: 'Sol 系最新档' },
  { providerId: 'openai', id: 'gpt-6-astra', name: 'GPT-6 Astra', kind: 'reasoning', note: 'GPT-6 系旗舰' },
  { providerId: 'openai', id: 'gpt-6-sol', name: 'GPT-6 Sol', kind: 'reasoning', note: '$2/$10，GPT-6 系中档' },
  { providerId: 'openai', id: 'gpt-6-luna', name: 'GPT-6 Luna', kind: 'chat', note: 'GPT-6 系轻量档' },
  { providerId: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', kind: 'reasoning' },
  { providerId: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', kind: 'chat' },
  { providerId: 'openai', id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', kind: 'reasoning', note: 'Codex 编程专用' },
  // Google（经 OpenAI 兼容网关接入；gemini-3.1-pro 处于 Preview，官方 id 带 -preview 后缀）
  { providerId: 'openai', id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat', note: 'Stable Flash，多模态；Gemini 4 Argon 的 Wing 工具连续调用尚未验证' },
  { providerId: 'openai', id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', kind: 'chat', note: 'Stable，多模态性价比主力' },
  { providerId: 'openai', id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', kind: 'reasoning', note: 'Preview 阶段，id 带 -preview 后缀' },
  // xAI（全系 Text+Image 输入）
  { providerId: 'xai', id: 'grok-4.7', name: 'Grok 4.7', kind: 'reasoning', note: '当前旗舰' },
  { providerId: 'xai', id: 'grok-4.6', name: 'Grok 4.6', kind: 'reasoning', note: '$2/$6，500K 上下文' },
  // 国产
  { providerId: 'zhipu', id: 'glm-5.3', name: 'GLM-5.3', kind: 'reasoning', note: '旗舰，1M 上下文（纯文本）' },
  { providerId: 'zhipu', id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', kind: 'chat', note: '原生多模态，支持图片/视频/文件输入，1M 上下文' },
  { providerId: 'zhipu', id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', kind: 'chat', note: '同 Flash 多模态能力，推理速度 200 tokens/s' },
  { providerId: 'zhipu', id: 'glm-5', name: 'GLM-5', kind: 'reasoning', note: '200K 上下文（纯文本）' },
  { providerId: 'moonshot', id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', kind: 'reasoning', note: '原生视觉，1M 上下文，按量 Key，始终开启思考' },
  { providerId: 'minimax', id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', kind: 'reasoning', note: '原厂 API，原生视觉，1M 上下文，始终开启思考；权限以控制台为准' },
  { providerId: 'moonshot', id: 'kimi-k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', kind: 'reasoning', note: '高速版，原生视觉，1M 上下文' },
  { providerId: 'moonshot', id: 'kimi-k3', name: 'Kimi K3', kind: 'reasoning', note: '原生视觉，1M 上下文' },
  { providerId: 'moonshot', id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', kind: 'reasoning', note: '编码特化，256K，支持视觉' },
  { providerId: 'qwen', id: 'qwen3.8-max', name: 'Qwen3.8 Max', kind: 'reasoning', note: '支持视觉，1M 上下文' },
  { providerId: 'qwen', id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', kind: 'chat', note: '支持视觉，1M 上下文' },
  { providerId: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash 1017', kind: 'chat', note: '原厂 API id 为 deepseek-flash；1M 上下文，支持视觉' },
  { providerId: 'qwen', id: 'MiniMax/MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash（百炼）', kind: 'reasoning', note: '百炼北京区域，支持视觉，始终开启思考' },
  { providerId: 'qwen', id: 'xiaomi/mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed（百炼）', kind: 'reasoning', note: '百炼北京区域，支持视觉，1M 上下文' },
  { providerId: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', kind: 'reasoning', note: '1M 上下文，不支持视觉；2026-10-03 官方定价页仍在售（调用报错多为账号并发/区域问题）' },
  // TypeSafe（System One 决策模型：非对话，choice/score/noul 结构化决策；官方公告+文档已核实）
  {
    providerId: 'typesafe',
    id: 'jev-1.13.0',
    name: 'Jev 1.13（System One）',
    kind: 'decision',
    note: '类型化决策模型：$0.042/M 输入、输出免费；钉版本号勿用 jev-latest（别名漂移会改变答案）',
  },
];
