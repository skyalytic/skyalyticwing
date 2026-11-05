import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createSessionAgentTools } from './tools/session-agent.js';
import { createAcpTools } from './tools/acp-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createSessionAgentTools(resolve),
...createAcpTools(resolve)]};
}
