import { BadRequestException } from '@nestjs/common';
import { statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { trackDocumentMutationSync } from './document-history.js';

/** Exclusive create prevents a new document from overwriting an existing user file. */
export function createWorkfile(
  directory: string,
  name: string,
  extension: string,
  data: string | Buffer,
  allowed: (path: string) => boolean,
) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0'))
    throw new BadRequestException('请选择项目文件夹');
  const dir = resolve(directory);
  if (!allowed(dir) || !statSync(dir).isDirectory())
    throw new BadRequestException('项目文件夹未授权或不存在');
  const title = typeof name === 'string' ? name.trim() : '';
  if (
    !title ||
    title.length > 80 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(title) ||
    /[. ]$/.test(title) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)
  )
    throw new BadRequestException('文件名称无效');
  for (let n = 0; n < 1000; n++) {
    const filename = title + (n ? ` (${n + 1})` : '') + '.' + extension;
    const path = join(dir, filename);
    if (!allowed(path)) throw new BadRequestException('文件路径未授权');
    try {
      trackDocumentMutationSync(path, () => writeFileSync(path, data, { flag: 'wx' }), '新建文档');
      return { path, name: filename };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new BadRequestException('同名文件过多，请修改文件名称');
}
