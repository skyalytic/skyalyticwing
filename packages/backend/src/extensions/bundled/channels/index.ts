import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createChannelTools } from './tools/channel-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,http,ws,config }=host;
 return {tools:[...createChannelTools(security,http,ws,config)]};
}
