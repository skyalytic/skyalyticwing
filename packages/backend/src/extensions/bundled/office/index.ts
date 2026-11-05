import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createOfficeTools } from './tools/office-tools.js';
import { createDocTools } from './tools/doc-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,resolve }=host;
 return {tools:[...createOfficeTools(resolve),
...createDocTools(security)]};
}
