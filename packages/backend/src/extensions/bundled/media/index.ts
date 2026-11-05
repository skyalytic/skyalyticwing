import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createMediaTools } from './tools/media.js';
import { createVideoComposeTool, createVideoInspectionTool } from './tools/video-compose.js';
import { createCodeVideoTool } from './tools/code-video.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security,http,config,resolve }=host;
 return {tools:[...createMediaTools(security,http,resolve),
createVideoComposeTool(security,config),
createVideoInspectionTool(security,config),
createCodeVideoTool(security,config)]};
}
