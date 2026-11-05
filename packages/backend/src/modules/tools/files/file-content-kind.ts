import { open } from 'node:fs/promises';

/** Inspect bytes before decoding: a PNG is an image, never UTF-8 tool output. */
export async function fileContentKind(path: string): Promise<'image' | 'binary' | 'text'> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    const b = buffer.subarray(0, bytesRead);
    const ascii = b.subarray(0, 16).toString('latin1');
    if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        (b[0]===255 && b[1]===216 && b[2]===255) || /^GIF8[79]a/.test(ascii) ||
        (ascii.startsWith('RIFF') && ascii.slice(8,12)==='WEBP') ||
        ascii.startsWith('BM') || ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'image';
    if (b.includes(0) || /^%PDF-|^PK\x03\x04|^MZ|^RIFF|^ID3|^OggS|^fLaC/.test(ascii)) return 'binary';
    try { new TextDecoder('utf-8', {fatal:true}).decode(b, {stream:true}); }
    catch { return 'binary'; }
    return 'text';
  } finally { await file.close(); }
}

/** Repair only demonstrably corrupt legacy binary reads in outgoing context.
 * The saved history and original file are not modified or truncated. */
export function repairBinaryFileReadContent(content: string, toolName?: string): string {
  if (toolName !== 'file-read' && toolName !== 'file_read') return content;
  let result: {output?: unknown; data?: {path?: unknown}};
  try { result = JSON.parse(content); } catch { return content; }
  if (!result || typeof result !== 'object') return content;
  if (typeof result.output !== 'string' || typeof result.data?.path !== 'string') return content;
  if (!/\.(png|jpe?g|gif|webp|bmp|tiff?|mp4|mov|webm|wav|mp3|pdf|zip|exe)$/i.test(result.data.path)) return content;
  const sample = result.output.slice(0,8192);
  const replacements = [...sample].filter(c=>c==='\uFFFD').length;
  if (!sample.includes('\0') && replacements < Math.max(8,sample.length*0.05)) return content;
  return JSON.stringify({success:false,error:'历史工具曾把二进制文件错误解码为文本；乱码已从本次模型上下文排除，原文件和保存的历史未改动。请重新读取图片，或使用对应格式的解析工具。',data:{path:result.data.path,binary:true,recovered:true}});
}
