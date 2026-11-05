import type { LlmToolDefinition } from '../types.js';

export function toolAvailabilityPrompt(tools?: LlmToolDefinition[]): string {
  const names = (tools || []).filter(tool => tool.name !== 'task_verify').map(tool => tool.name);
  const contract = '本轮请求实际提供的工具定义是唯一的可执行能力依据。历史对话、工作目录、完全访问权限和示例都不能证明某个工具存在。只能通过结构化工具调用执行操作；不要把 DSML、<tool_call> 或伪造的调用 JSON 写成普通回答来代替执行，也不能凭这些文字宣称操作成功。用户明确讨论这些格式时可以解释或引用，但必须区分示例和实际执行。';
  return names.length
    ? contract + '\n本轮可调用工具：' + names.join(', ') + '。任务需要的工具不在此列表时，说明缺少该能力，引导用户在工具页安装或启用；如果已安装，检查权限或当前智能体的工具选择。'
    : contract + '\n本轮没有可调用的操作工具。你可以直接回答、解释或在聊天里提供代码，但不能读取文件、创建文件、运行程序或操作浏览器和桌面。用户要求实际操作时，先明确说明当前没有可用工具，并引导用户在工具页安装或启用所需工具；如果已安装，检查权限或当前智能体的工具选择。不要声称已经开始执行，也不要把完全访问误认为工具已安装。';
}
