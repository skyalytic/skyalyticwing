import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { parseSkillDocument } from './skill-document.js';

export const SKILL_ZIP_MAX_BYTES = 64 * 1024 * 1024;
export const SKILL_FILES_MAX_BYTES = 256 * 1024 * 1024;
export function safeSkillPath(name: string): boolean {
  return !!name && !name.includes('\\') && name.split('/').every(part =>
    !!part && !['.', '..'].includes(part) && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** Inspect original ZIP directory names before JSZip's path sanitization/deduplication. */
function inspectDirectory(bytes: Buffer) {
  if (bytes.length > SKILL_ZIP_MAX_BYTES) throw Error('ZIP 文件不能超过 64 MB');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error('请上传完整、未分卷的 ZIP 技能包');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  if (!count || count > 10000 || cursor + length !== end) throw Error('ZIP 目录无效或文件数量过多');
  const seen = new Set<string>(), files = new Set<string>();
  const declared = new Map<string, { bytes: number; crc: number }>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw Error('ZIP 目录损坏');
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    if (cursor + 46 + nameLength + extra + comment > end) throw Error('ZIP 目录损坏');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const directory = name.endsWith('/'), normalized = (directory ? name.slice(0, -1) : name).normalize('NFC').toLowerCase();
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if (!safeSkillPath(directory ? name.slice(0, -1) : name) || name.includes('\ufffd') || seen.has(normalized) ||
        (mode & 0xf000) === 0xa000 || (bytes.readUInt16LE(cursor + 8) & 1)) throw Error('ZIP 包含不安全、重复、加密或符号链接文件');
    if (normalized.split('/').some(part => part === '.skyalytic-install.json')) throw Error('请移除安装管理元数据后重新分享');
    seen.add(normalized);
    if (!directory) files.add(normalized);
    if (!directory) declared.set(name, { bytes: bytes.readUInt32LE(cursor + 24), crc: bytes.readUInt32LE(cursor + 16) });
    total += bytes.readUInt32LE(cursor + 24);
    if (total > SKILL_FILES_MAX_BYTES) throw Error('技能解压后不能超过 256 MB');
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) throw Error('ZIP 目录损坏');
  for (const name of seen) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (files.has(parts.join('/'))) throw Error('ZIP 文件和目录路径冲突'); parts.pop(); }
  }
  return declared;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let c = value; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
async function inflateBounded(file: JSZip.JSZipObject, expected: { bytes: number; crc: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let length = 0, crc = 0xffffffff, failed = false;
    const chunks: Buffer[] = [], stream = file.nodeStream('nodebuffer') as Readable;
    stream.on('data', (chunk: Buffer) => {
      if (failed) return;
      length += chunk.length;
      if (length > expected.bytes || length > SKILL_FILES_MAX_BYTES) { failed = true; stream.destroy(Error('ZIP 解压大小校验失败')); return; }
      for (const value of chunk) crc = crcTable[(crc ^ value) & 255]! ^ (crc >>> 8);
      chunks.push(chunk);
    }).on('error', reject).on('end', () => {
      if (failed) return;
      if (length !== expected.bytes || ((crc ^ 0xffffffff) >>> 0) !== expected.crc) reject(Error('ZIP 文件内容校验失败'));
      else resolve(Buffer.concat(chunks, length));
    }).resume();
  });
}

export async function readSkillZip(bytes: Buffer, fileName: string) {
  const declared = inspectDirectory(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir);
  const definitions = files.filter(f => f.name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(f.name));
  if (definitions.length !== 1) throw Error('ZIP 必须包含一个 SKILL.md（位于根目录或单层技能目录内）');
  const definition = definitions[0]!;
  const prefix = definition.name.slice(0, -'SKILL.md'.length);
  if (Object.values(zip.files).some(f => !f.name.startsWith(prefix))) throw Error('ZIP 中存在技能目录以外的文件，请分别打包技能');
  const directories = Object.values(zip.files).filter(f => f.dir && f.name !== prefix).map(f => f.name.slice(prefix.length).replace(/\/$/, ''));
  const entries: Array<{ path: string; data: Buffer; mode: number }> = [];
  let total = 0;
  for (const file of files) {
    const expected = declared.get(file.name);
    if (!expected) throw Error('ZIP 路径解析不一致');
    const data = await inflateBounded(file, expected);
    total += data.length;
    if (total > SKILL_FILES_MAX_BYTES) throw Error('技能解压后不能超过 256 MB');
    entries.push({ path: file.name.slice(prefix.length), data, mode: Number(file.unixPermissions || 0) & 0o777 });
  }
  const content = entries.find(f => f.path === 'SKILL.md')!.data.toString('utf8');
  if (!content.trim() || content.includes('\0')) throw Error('SKILL.md 必须是非空文本');
  const { metadata } = parseSkillDocument(content);
  const name = prefix ? prefix.slice(0, -1) : typeof metadata['name'] === 'string' ? metadata['name'] : fileName.replace(/\.zip$/i, '');
  if (!safeSkillPath(name) || name.includes('/') || name.includes('..')) throw Error('技能名称无效');
  return { name, content, entries, directories };
}
