import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createAgentReachTools } from './tools/agent-reach.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,http,config }=host;
 return {tools:[...createAgentReachTools(security,http,config)]};
}
