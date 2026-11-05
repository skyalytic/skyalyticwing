import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createMemoryTools } from './tools/memory.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createMemoryTools(resolve)]};
}
