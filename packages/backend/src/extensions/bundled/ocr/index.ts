import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createOcrTools } from './tools/ocr-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createOcrTools(resolve)]};
}
