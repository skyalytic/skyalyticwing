import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createBashTool } from './tools/bash.js';
import { createPowerShellTool } from './tools/powershell.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security }=host;
 return {tools:[createBashTool(security),
createPowerShellTool(security)]};
}
