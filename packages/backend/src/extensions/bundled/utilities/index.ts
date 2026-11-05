import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createMiscTools } from './tools/misc-tools.js';
import { createLegacyTools } from './tools/legacy-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,http,ws,safety,resolve }=host;
 return {tools:[...createMiscTools(security,safety,resolve),
...createLegacyTools(security,http,resolve,ws)]};
}
