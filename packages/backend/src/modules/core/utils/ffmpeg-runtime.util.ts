import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

/** Resolve relative to the backend module, never the current project or user's PATH. */
export function resolveMediaBinary(name: 'ffmpeg' | 'ffprobe', override?: string): { path: string; source: string } {
  if (override?.trim()) return {path:override,source:'configured'};
  const binary = name + (process.platform === 'win32' ? '.exe' : '');
  for (const directory of [resolve(__dirname,'../../../../vendor/ffmpeg'),resolve(__dirname,'../../../../deploy/vendor/ffmpeg')]) {
    const file = join(directory,'bin',binary);
    if (existsSync(file)) return {path:file,source:'bundled'};
  }
  if (process.env['SKYALYTICWING_DESKTOP'] === '1') throw new Error(`Wing 内置 ${name} 缺失，请修复安装；无需设置系统 PATH`);
  return {path:name,source:'system'};
}

export async function readMediaTool(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execute(binary,args,{windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,timeout:30_000,...(signal?{signal}:{})});
  return result.stdout;
}
