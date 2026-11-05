/**
 * 内置工具工厂统一导出。
 *
 * 每个内置工具是一个工厂函数，接收所需依赖（SecurityManagerService /
 * HttpClientService / WebSocketService）并返回 ToolDefinition。
 * built-in-tools.ts 的 createBuiltInTools 负责注入依赖并聚合为数组。
 */
export { createFileReadTool } from './file-read.js';
export { createFileWriteTool } from './file-write.js';
export { createTodoTools } from './todo.js';
export { createFileEditTool } from './file-edit.js';
export { createFileDeleteTool } from './file-delete.js';
export { createDirectoryListTool } from './directory-list.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createBashTool, formatExecError } from './bash.js';
export { createPowerShellTool } from './powershell.js';
export { createWebFetchTool } from './web-fetch.js';
export { createNotifyTool } from './notify.js';
export { createMediaTools } from './media.js';
export { createAutomationTools } from './automation.js';
export { createMemoryTools } from './memory.js';
export { createSystemTools } from './system.js';
export { createCronMcpTools } from './cron-mcp.js';

// ─── 第二批：跨会话协作 / agent-reach / 渠道 / 杂项 / ACP / 守护进程域 ───
export type { ServiceResolver } from './service-resolver.js';
export { createSessionAgentTools } from './session-agent.js';
export { createAgentReachTools } from './agent-reach.js';
export { createChannelTools } from './channel-tools.js';
export { createMiscTools } from './misc-tools.js';
export { createAcpTools } from './acp-tools.js';
export { createDaemonTools } from './daemon-tools.js';
export { createBackgroundTaskTools } from './background-task-tools.js';

// ─── 第三批：文档生成 / 网页搜索 / 平台域（蜂群/提供商/沙箱/会话/插件） ───
export { createDocTools } from './doc-tools.js';
export { createWebSearchTool } from './web-search.js';
export { createPlatformTools } from './platform-tools.js';

// ─── 第四批：旧版（1.3.3）遗留工具补齐（python/node/code_build/git_operation 等） ───
export { createLegacyTools } from './legacy-tools.js';

// ─── 本地 OCR（文字识别，与媒体 API 生成无关，旧媒体套件清理时保留） ───
export { createOcrTools } from './ocr-tools.js';

// ─── 内置浏览器（自托管 headless + 元素标记引擎，AI 可驱动的应用内浏览器） ───
export { createBuiltinBrowserTools } from './builtin-browser.js';

// （旧媒体套件的语音 TTS/STT、音乐生成、媒体分析工具已清理移除——现仅保留
//  统一模型体系的图片/视频 API 生成（media.ts）；uia_diagnostics 迁入 automation.ts）
