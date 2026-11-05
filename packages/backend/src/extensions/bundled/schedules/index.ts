import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createCronMcpTools } from './tools/cron-mcp.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createCronMcpTools(resolve)]};
}
