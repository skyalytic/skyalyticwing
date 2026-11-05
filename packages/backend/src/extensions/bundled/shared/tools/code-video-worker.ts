import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import sharp from 'sharp';
import { DOMParser } from '@xmldom/xmldom';

export interface CodeVideoJob {
  script: string; output: string; report: string; ffmpeg: string; ffprobe: string;
  width: number; height: number; fps: number; duration: number; audio?: string;
}

// SVG frames may embed raster assets, but must not fetch remote or local resources.
export function validateVideoSvg(svg: string): void {
  if (/<!DOCTYPE|<!ENTITY|@import/i.test(svg)) throw new Error('SVG 不支持外部实体或样式导入');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.documentElement?.localName !== 'svg') throw new Error('绘图函数必须返回完整 SVG 字符串');
  for (const node of Array.from(document.getElementsByTagName('*'))) {
    if (['script','foreignObject'].includes(node.localName || '')) throw new Error('SVG 不支持脚本或嵌入网页');
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.localName === 'href' && !/^(#|data:image\/(png|jpeg|webp);base64,)/i.test(attribute.value))
        throw new Error('图片素材请嵌入 PNG/JPEG/WebP data URL，不能在渲染时访问网络或本地路径');
      for (const match of attribute.value.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi))
        if (!match[1]?.startsWith('#')) throw new Error('SVG 样式只能引用内部定义');
    }
    if (node.localName === 'style' && /url\s*\(|@import/i.test(node.textContent || ''))
      throw new Error('样式引用请使用 SVG 元素的属性和内部定义');
  }
}

export async function renderCodeVideo(job: CodeVideoJob): Promise<void> {
  const source = readFileSync(job.script,'utf8').trim().replace(/;\s*$/,'');
  // Only primitives cross into the drawing context. No require, fetch, process,
  // host functions or Node objects are exposed; arbitrary shell code is not accepted.
  const context = createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  new Script(`globalThis.renderFrame = (${source}\n); if (typeof renderFrame !== 'function') throw new Error('脚本需为一个绘图函数表达式');`,{filename:job.script}).runInContext(context);
  const draw = new Script('renderFrame({frame,time,width,height,fps,duration})');
  context['width']=job.width;context['height']=job.height;context['fps']=job.fps;context['duration']=job.duration;
  const frames=Math.ceil(job.duration*job.fps);
  const encoders=execFileSync(job.ffmpeg,['-hide_banner','-encoders'],{encoding:'utf8',windowsHide:true});
  const codec=['libopenh264','libx264','h264_videotoolbox','h264_mf'].find(name=>new RegExp(`\\b${name}\\b`).test(encoders));
  if (!codec) throw new Error('内置 FFmpeg 缺少可用的 H.264 编码器，请修复安装');
  const args=['-nostdin','-hide_banner','-loglevel','error','-n','-f','rawvideo','-pix_fmt','rgb24','-s',`${job.width}x${job.height}`,'-r',String(job.fps),'-i','pipe:0'];
  if(job.audio) args.push('-protocol_whitelist','file','-i',job.audio,'-map','0:v:0','-map','1:a:0','-af','apad','-c:a','aac');
  else args.push('-an');
  args.push('-c:v',codec,'-b:v','4000k','-pix_fmt','yuv420p','-t',String(job.duration),'-movflags','+faststart',job.output);
  const child=spawn(job.ffmpeg,args,{windowsHide:true,stdio:['pipe','ignore','pipe']});
  let diagnostic='';let processError: Error | undefined;let closed=false;
  child.stderr.on('data',(chunk: Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(-12000)});
  const finished=new Promise<number|null>(resolve=>{child.on('error',error=>{processError=error;closed=true;resolve(null)});child.on('close',code=>{closed=true;resolve(code)})});
  child.stdin.on('error',error=>{processError=error});
  try {
    for(let frame=0;frame<frames;frame++) {
      if(closed||processError)throw processError || new Error(diagnostic || '编码器提前退出');
      context['frame']=frame;context['time']=frame/job.fps;
      const svg:unknown=draw.runInContext(context);
      if(typeof svg!=='string')throw new Error(`第 ${frame} 帧未返回 SVG 字符串`);
      validateVideoSvg(svg);
      const rgb=await sharp(Buffer.from(svg)).resize(job.width,job.height,{fit:'fill'}).flatten({background:'#000000'}).removeAlpha().toColourspace('srgb').raw().toBuffer();
      if(closed||processError)throw processError || new Error(diagnostic || '编码器提前退出');
      if(!child.stdin.write(rgb))await new Promise<void>((resolve,reject)=>{
        const clean=()=>{child.stdin.off('drain',drain);child.stdin.off('error',fail);child.off('close',close)};
        const drain=()=>{clean();resolve()};
        const fail=(error:Error)=>{clean();reject(error)};
        const close=()=>fail(processError || new Error(diagnostic || '编码器提前退出'));
        child.stdin.once('drain',drain);child.stdin.once('error',fail);child.once('close',close);
        if(closed||processError)close();
      });
      if(frame % job.fps===0)console.log(JSON.stringify({event:'render_progress',frame,totalFrames:frames,percent:Math.floor(frame/frames*100)}));
    }
    child.stdin.end();
    const exit=await finished;
    if(exit!==0||processError)throw new Error(diagnostic || processError?.message || `编码失败: ${exit}`);
    const metadata=JSON.parse(execFileSync(job.ffprobe,['-v','error','-protocol_whitelist','file','-show_format','-show_streams','-of','json',job.output],{encoding:'utf8',windowsHide:true}));
    const video=metadata.streams?.find((stream:{codec_type:string})=>stream.codec_type==='video');
    if(!video || video.codec_name!=='h264' || video.width!==job.width || video.height!==job.height || Math.abs(Number(metadata.format?.duration)-job.duration)>Math.max(0.1,1/job.fps))
      throw new Error('输出视频的编码、尺寸或时长校验未通过');
    if(job.audio&&!metadata.streams.some((stream:{codec_type:string})=>stream.codec_type==='audio'))throw new Error('输出视频缺少指定音轨');
    writeFileSync(job.report,JSON.stringify({method:'code',videoModelCalls:0,frames,...metadata}));
    console.log(JSON.stringify({event:'render_progress',frame:frames,totalFrames:frames,percent:100}));
  } finally {
    if(!closed){child.stdin.destroy();child.kill();await finished;}
  }
}

if(require.main===module) {
  renderCodeVideo(JSON.parse(readFileSync(process.argv[2]!,'utf8')) as CodeVideoJob)
    .catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1});
}
