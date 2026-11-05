import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, stat, unlink, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ToolDefinition } from '@skyalyticwing/shared';
import type { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import type { ConfigService } from '../../../../modules/core/config/config.service.js';
import { runShell } from '../../shared/tools/shell-runner.js';
import { resolveMediaBinary, readMediaTool } from '../../../../modules/core/utils/ffmpeg-runtime.util.js';

export function createVideoInspectionTool(security: SecurityManagerService, config: ConfigService): ToolDefinition {
  return {
    name: 'inspect_video', category: 'media', dangerous: false,
    description: '只读检查 Wing 内置 FFmpeg/ffprobe 是否可用；传入本地视频 path 时读取时长、分辨率、编码、音轨等技术信息。不生成视频、不修改文件、不调用模型。此工具不分析画面语义或识别对白。',
    parameters: {type:'object',properties:{path:{type:'string',description:'可选，本地已有视频路径；不填时仅检查内置工具'}}},
    async execute(raw, ctx) {
      try {
        const settings = config.getAll() as {automation?:{media?:{video?:{ffmpeg?:{ffmpegPath?:string;ffprobePath?:string}}}}};
        const overrides = settings.automation?.media?.video?.ffmpeg;
        const ffmpeg = resolveMediaBinary('ffmpeg',overrides?.ffmpegPath);
        const ffprobe = resolveMediaBinary('ffprobe',overrides?.ffprobePath);
        const [mpegVersion,probeVersion] = await Promise.all([
          readMediaTool(ffmpeg.path,['-version'],ctx.signal),readMediaTool(ffprobe.path,['-version'],ctx.signal),
        ]);
        const file = (raw as {path?:unknown})?.path;
        if (file !== undefined && typeof file !== 'string') throw new Error('path 必须是本地文件路径');
        let metadata: unknown;
        if (typeof file === 'string' && file) {
          const absolute = await realpath(resolve(ctx.workspace,file));
          if (!security.isPathAllowed(absolute,'read') || !(await stat(absolute)).isFile()) throw new Error('视频文件不可读取');
          metadata = JSON.parse(await readMediaTool(ffprobe.path,['-v','error','-protocol_whitelist','file','-show_format','-show_streams','-of','json',absolute],ctx.signal));
        }
        return {success:true,output:file?'已读取视频技术信息（未分析画面语义）':'FFmpeg 与 ffprobe 可用',data:{ffmpeg:{...ffmpeg,version:mpegVersion.split('\n')[0]},ffprobe:{...ffprobe,version:probeVersion.split('\n')[0]},...(metadata?{metadata}:{})}};
      } catch (e) { return {success:false,error:e instanceof Error?e.message:String(e)}; }
    },
  };
}

/** Concatenate existing compatible clips only; no model call, payment, or implicit generation. */
export function createVideoComposeTool(security: SecurityManagerService, config: ConfigService): ToolDefinition {
  return {
    name: 'concat_videos', category: 'media', dangerous: true,
    description: '用 Wing 内置 FFmpeg 按顺序拼接已有视频片段，输出一个 MP4；不调用生成模型、不计生成费用，用户无需另装 FFmpeg 或配置 PATH。可先用 inspect_video 检查内置工具和片段信息。输入须具有相同编码、分辨率、帧率和音轨布局。成片可长于单次生成时长（如 30 分钟），但拼接不保证跨镜头人物/场景连续性。长视频若需新生成片段，先说明分镜、数量和预计费用，获用户同意后再生成，不能因单次生成时长有限就声称无法制作长片。',
    parameters: { type: 'object', properties: {
      files: { type: 'array', items: { type: 'string' }, minItems: 2, description: '按播放顺序排列的已有视频路径' },
      output: { type: 'string', description: '新的 MP4 输出路径，不覆盖已有文件' },
    }, required: ['files', 'output'] },
    async execute(raw, ctx) {
      let temporary: string | undefined;
      try {
        const args = raw as { files?: unknown; output?: unknown };
        if (!Array.isArray(args?.files) || args.files.length < 2 || args.files.some(f => typeof f !== 'string') || typeof args.output !== 'string' || !args.output.toLowerCase().endsWith('.mp4')) throw new Error('需要至少两个已有视频路径，以及 .mp4 输出路径');
        const files: string[] = [];
        for (const input of args.files as string[]) {
          const file = await realpath(resolve(ctx.workspace, input));
          if (!security.isPathAllowed(file, 'read') || !(await stat(file)).isFile() || /[\r\n\0]/.test(file)) throw new Error('视频路径不可读取');
          files.push(file);
        }
        const output = resolve(ctx.workspace, args.output);
        if (!security.isPathAllowed(output, 'write')) throw new Error('输出路径不可写入');
        await mkdir(dirname(output), { recursive: true });
        if (!security.isPathAllowed(await realpath(dirname(output)), 'write')) throw new Error('输出目录不可写入');
        try { await stat(output); throw new Error('输出文件已存在，请使用新的文件名'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (ctx.signal?.aborted) return { success: false, error: 'cancelled' };
        temporary = await mkdtemp(join(dirname(output), '.wing-concat-'));
        const list = join(temporary, 'clips.txt');
        await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
        const settings = config.getAll() as { automation?: { media?: { video?: { ffmpeg?: { ffmpegPath?: string } } } } };
        const executable = resolveMediaBinary('ffmpeg',settings.automation?.media?.video?.ffmpeg?.ffmpegPath).path;
        const merged = join(temporary, 'merged.mp4');
        const result = await runShell(executable, ['-nostdin', '-hide_banner', '-n', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-i', list, '-map', '0', '-c', 'copy', '-movflags', '+faststart', merged], {
          cwd: ctx.workspace, sessionId: ctx.sessionId, readOnly: true, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!result.success) return { ...result, error: `${result.error || 'FFmpeg 拼接失败'}；请确认 FFmpeg 已安装且片段编码/音轨一致。完整输出见执行日志。` };
        if (ctx.signal?.aborted) return { success: false, error: 'cancelled' };
        if (!(await stat(merged)).size) throw new Error('FFmpeg 未产生有效输出');
        await copyFile(merged, output, constants.COPYFILE_EXCL);
        return { success: true, output: `已拼接 ${files.length} 个片段：${output}`, data: { file: output, segments: files.length, ...(result.data as object) } };
      } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
      finally {
        if (temporary) {
          // Only remove the two files owned by this invocation; never recurse over user paths.
          await unlink(join(temporary, 'clips.txt')).catch(() => {});
          await unlink(join(temporary, 'merged.mp4')).catch(() => {});
          await rmdir(temporary).catch(() => {});
        }
      }
    },
  };
}
