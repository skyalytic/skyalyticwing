import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createAutomationTools } from './tools/automation.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,ws,resolve }=host;
 return {tools:[...createAutomationTools(security,ws,resolve).filter(t=>t.name!=="computer_use")]};
}
