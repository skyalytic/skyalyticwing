import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createDaemonTools } from './tools/daemon-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,resolve }=host;
 return {tools:[...createDaemonTools(security,resolve)]};
}
