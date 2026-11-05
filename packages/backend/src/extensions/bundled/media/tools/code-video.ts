import { mkdir, mkdtemp, readFile, realpath, stat, link, unlink, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {ToolDefinition} from '@skyalyticwing/shared';
import type {SecurityManagerService} from '../../../../modules/core/security/security-manager.service.js';
import type {ConfigService} from '../../../../modules/core/config/config.service.js';
import {resolveMediaBinary} from '../../../../modules/core/utils/ffmpeg-runtime.util.js';
import {runShell} from '../../shared/tools/shell-runner.js';
import type {CodeVideoJob} from '../../shared/tools/code-video-worker.js';

export function createCodeVideoTool(security: SecurityManagerService,config: ConfigService): ToolDefinition {
  return {
    name:'render_code_video',category:'media',dangerous:true,
    description:'用代码制作视频，无需视频模型或生成 API。先用 file-write 写一个 UTF-8 JavaScript 文件，内容是同步函数表达式，例如 ({time,width,height}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${40+time*50}" cy="100" r="20" fill="red"/></svg>`。函数每帧收到 frame、time（秒）、width、height、fps、duration，返回完整 SVG。支持 Math、字符串和纯 JavaScript 运算；没有 require/process/fetch/DOM，不能导入库或联网；图片须嵌入 PNG/JPEG/WebP base64 data URL。可制作字幕、歌词、图表、教学和程序动画。用本地素材做真实拍摄效果需先取得素材，不得把简单动画冒充真实场景。使用内置 FFmpeg 输出 MP4，可选已有音轨 audio_path，不调用配音服务。时长由 duration_seconds 指定，无视频模型单段时长限制。返回文件直接进入对话预览，不要重复发送同一文件。失败后修改脚本重试；停止会取消渲染。',
    parameters:{type:'object',properties:{
      script_path:{type:'string',description:'工作区内绘图函数文件路径（只包含函数表达式，不要 CommonJS/ESM 导出）'},
      output:{type:'string',description:'新 MP4 路径，不覆盖已有文件'},
      duration_seconds:{type:'number',description:'成片时长，必须大于 0；先用短样片确认复杂场景'},
      width:{type:'integer',description:'偶数宽度，默认 1280'},height:{type:'integer',description:'偶数高度，默认 720'},
      fps:{type:'integer',description:'正整数帧率，默认 24'},audio_path:{type:'string',description:'可选已有本地音频；裁剪或补静音到成片时长'},
    },required:['script_path','output','duration_seconds']},
    async execute(raw,ctx){
      let temporary:string|undefined;
      try {
        const a=raw as Record<string,unknown>;
        if(!a||typeof a['script_path']!=='string'||typeof a['output']!=='string'||!a['output'].toLowerCase().endsWith('.mp4'))throw new Error('需要绘图脚本路径和新的 .mp4 输出路径');
        const width=a['width']??1280,height=a['height']??720,fps=a['fps']??24,duration=a['duration_seconds'];
        if(![width,height].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n%2===0)||typeof fps!=='number'||!Number.isSafeInteger(fps)||fps<=0||typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||!Number.isSafeInteger(Math.ceil(duration*fps)))throw new Error('宽高需为正偶数，fps 需为正整数，时长需为有限正数');
        if(ctx.signal?.aborted)return {success:false,error:'cancelled'};
        const allowedFile=async(value:string)=>{
          const absolute=resolve(ctx.workspace,value);
          if(!security.isPathAllowed(absolute,'read'))throw new Error('输入路径不可读取');
          const actual=await realpath(absolute);
          if(!security.isPathAllowed(actual,'read')||!(await stat(actual)).isFile())throw new Error('输入文件不可读取');
          return actual;
        };
        const script=await allowedFile(a['script_path']);
        const audio=a['audio_path']===undefined?undefined:typeof a['audio_path']==='string'?await allowedFile(a['audio_path']):(()=>{throw new Error('audio_path 必须是文件路径')})();
        const output=resolve(ctx.workspace,a['output']);
        if(!security.isPathAllowed(output,'write'))throw new Error('输出路径不可写入');
        await mkdir(dirname(output),{recursive:true});
        if(!security.isPathAllowed(await realpath(dirname(output)),'write'))throw new Error('输出目录不可写入');
        try {await stat(output);throw new Error('输出文件已存在，请使用新的文件名')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        const settings=config.getAll() as {automation?:{media?:{video?:{ffmpeg?:{ffmpegPath?:string;ffprobePath?:string}}}}};
        const overrides=settings.automation?.media?.video?.ffmpeg;
        const ffmpeg=resolveMediaBinary('ffmpeg',overrides?.ffmpegPath).path,ffprobe=resolveMediaBinary('ffprobe',overrides?.ffprobePath).path;
        temporary=await mkdtemp(join(dirname(output),'.wing-code-video-'));
        const rendered=join(temporary,'render.mp4'),report=join(temporary,'report.json'),request=join(temporary,'request.json');
        const job:CodeVideoJob={script,output:rendered,report,ffmpeg,ffprobe,width:width as number,height:height as number,fps,duration,...(audio?{audio}:{})};
        await writeFile(request,JSON.stringify(job),'utf8');
        // The drawing worker needs OS/font settings, never application API keys.
        const env:NodeJS.ProcessEnv={};
        for(const key of Object.keys(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|FONTCONFIG_PATH|LANG|LC_ALL)$/i.test(key))env[key]=process.env[key];
        const result=await runShell(process.execPath,[join(__dirname,'../../shared/tools/code-video-worker.js'),request],{cwd:ctx.workspace,sessionId:ctx.sessionId,readOnly:true,env,...(ctx.signal?{signal:ctx.signal}:{})});
        if(!result.success)return {...result,error:`代码视频渲染失败：${result.error || '请查看执行日志'}。不要改用付费视频模型重试；请根据日志修复代码。`};
        if(ctx.signal?.aborted)return {success:false,error:'cancelled'};
        const metadata=JSON.parse(await readFile(report,'utf8'));
        if(!(await stat(rendered)).size)throw new Error('渲染未产生有效视频');
        // Same-directory hard link publishes atomically and never overwrites a file.
        await link(rendered,output);
        return {success:true,output:`代码视频已完成：${output}（${duration} 秒；未调用视频模型）`,data:{...(result.data as object),file:output,kind:'video',method:'code',duration,width,height,fps,videoModelCalls:0,metadata}};
      }catch(error){return {success:false,error:error instanceof Error?error.message:String(error)}}
      finally{if(temporary){for(const name of ['request.json','render.mp4','report.json'])await unlink(join(temporary,name)).catch(()=>{});await rmdir(temporary).catch(()=>{})}}
    },
  };
}
