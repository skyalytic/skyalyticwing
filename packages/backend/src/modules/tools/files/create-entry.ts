import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { trackDocumentMutationSync } from './document-history.js';

/** Create exactly one child, exclusively, in an authorized existing directory. */
export function createEntry(directory: string, name: string, type: 'file' | 'dir', allowed: (path: string) => boolean) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0'))
    throw new BadRequestException('请选择有效的项目文件夹');
  if (type !== 'file' && type !== 'dir') throw new BadRequestException('请选择文件或文件夹');
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 180 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    throw new BadRequestException('名称无效：不能包含路径分隔符、特殊字符或结尾空格/句点');
  const dir = resolve(directory);
  if (!allowed(dir)) throw new ForbiddenException('文件夹没有写入权限');
  let canonical: string;
  try {
    canonical = realpathSync(dir);
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch { throw new NotFoundException('目标文件夹不存在'); }
  const target = join(canonical, name);
  if (!allowed(canonical) || !allowed(target)) throw new ForbiddenException('文件夹没有写入权限');
  try {
    if (type === 'dir') mkdirSync(target);
    else trackDocumentMutationSync(target, () => writeFileSync(target, '', { flag: 'wx' }), '新建文件');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ConflictException('已存在同名文件或文件夹，请修改名称');
    if (['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code || '')) throw new ForbiddenException('系统拒绝写入此文件夹');
    throw e;
  }
  return { path: join(dir, name), name, type };
}
