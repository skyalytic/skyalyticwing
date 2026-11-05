import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { withFileMutation } from './checkpoint-store.js';
import type { SecurityManagerService } from '../../core/security/security-manager.service.js';

/** Merge pages locally. Never overwrite an existing document or silently ignore encryption. */
export async function mergePdf(security: SecurityManagerService, workspace: string, files: unknown, output: unknown) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 30 || !files.every(p => typeof p === 'string' && p && !p.includes('\0')))
    throw new Error('PDF 合并需要 2–30 个输入文件');
  if (typeof output !== 'string' || !output || output.includes('\0')) throw new Error('请提供 output_path');
  const target = resolve(workspace, output);
  if (extname(target).toLowerCase() !== '.pdf') throw new Error('输出文件扩展名必须为 .pdf');
  if (!security.isPathAllowed(target, 'write') || !security.isPathAllowed(dirname(target), 'write')) throw new Error('输出路径未获写权限');
  const inputs = files.map(p => resolve(workspace, p));
  let total = 0;
  for (const file of inputs) {
    if (!security.isPathAllowed(file, 'read')) throw new Error('输入路径未获读权限');
    const st = statSync(file);
    if (!st.isFile() || extname(file).toLowerCase() !== '.pdf') throw new Error('输入必须为 PDF 文件');
    total += st.size;
    if (total > 100 * 1024 * 1024) throw new Error('输入总大小超过 100 MB');
  }
  return withFileMutation(target, async () => {
    if (existsSync(target)) throw new Error('输出文件已存在，请选择新文件名以保留原文件');
    const merged = await PDFDocument.create();
    for (const file of inputs) {
      const source = await PDFDocument.load(new Uint8Array(readFileSync(file)), { updateMetadata: false });
      if (source.getForm().getFields().length) throw new Error('输入含交互表单，请先在 PDF 编辑器中扁平化，再合并');
      if (merged.getPageCount() + source.getPageCount() > 2000) throw new Error('合并页数超过 2000 页');
      for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
    }
    const bytes = Buffer.from(await merged.save({ useObjectStreams: false }));
    if (!security.isPathAllowed(target, 'write')) throw new Error('输出路径写权限已撤销');
    writeFileSync(target, bytes, { flag: 'wx' });
    return { file: target, pages: merged.getPageCount(), bytes: bytes.length, inputs: inputs.length, note: '按输入顺序合并页面；不合并文档级书签、附件或数字签名。' };
  });
}
