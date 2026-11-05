import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createDatabaseTools } from './tools/database-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { resolve }=host;
 return {tools:[...createDatabaseTools(resolve)]};
}
