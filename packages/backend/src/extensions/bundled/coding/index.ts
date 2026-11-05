import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createLanguageTools } from './tools/language-tools.js';
import { createRepositoryTools } from './tools/repository-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,resolve }=host;
 return {tools:[...createLanguageTools(resolve),
...createRepositoryTools(security,resolve)]};
}
