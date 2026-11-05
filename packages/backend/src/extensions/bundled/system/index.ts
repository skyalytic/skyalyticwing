import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createSystemTools } from './tools/system.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createSystemTools(resolve)]};
}
