import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createFileReadTool } from './tools/file-read.js';
import { createFileWriteTool } from './tools/file-write.js';
import { createFileEditTool } from './tools/file-edit.js';
import { createFileDeleteTool } from './tools/file-delete.js';
import { createDirectoryListTool } from './tools/directory-list.js';
import { createGlobTool } from './tools/glob.js';
import { createGrepTool } from './tools/grep.js';
export function activate(host: ExtensionHost): ExtensionInstance {
 const { security }=host;
 return {tools:[createFileReadTool(security),
createFileWriteTool(security),
createFileEditTool(security),
createFileDeleteTool(security),
createDirectoryListTool(security),
createGlobTool(security),
createGrepTool(security)]};
}
