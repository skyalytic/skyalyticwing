import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createTodoTools } from './tools/todo.js';
import { createNotifyTool } from './tools/notify.js';
import { createBackgroundTaskTools } from './tools/background-task-tools.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { ws,resolve }=host;
 return {tools:[...createTodoTools(),
createNotifyTool(ws),
...createBackgroundTaskTools(resolve)]};
}
