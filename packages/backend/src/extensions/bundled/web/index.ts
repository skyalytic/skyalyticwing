import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,http,config }=host;
 return {tools:[createWebFetchTool(security,http),
createWebSearchTool(security,http,config)]};
}
