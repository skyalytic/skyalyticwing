import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createPlatformTools } from './tools/platform-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,resolve }=host;
 return {tools:[...createPlatformTools(security,resolve)]};
}
