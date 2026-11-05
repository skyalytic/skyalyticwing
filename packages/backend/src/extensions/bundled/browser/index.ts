import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createBuiltinBrowserTools } from './tools/builtin-browser.js';
import { BuiltInBrowserService } from '../../../modules/browser/browser.service.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createBuiltinBrowserTools(resolve)], dispose: () => resolve(BuiltInBrowserService)?.stopAgentOperations()};
}
