import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Reject sibling-prefix escapes and links out of the private memory root. */
export function checkedMemoryPath(root: string, path: string): string {
  const base = resolve(root), target = resolve(path);
  if (target !== base && !target.startsWith(base + sep)) throw new Error('记忆路径不允许');
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (existsSync(base)) {
    const physicalBase = realpathSync(base), physical = realpathSync(ancestor);
    if (physical !== physicalBase && !physical.startsWith(physicalBase + sep)) throw new Error('记忆链接不能指向目录外');
  }
  return target;
}

/** Write a complete Markdown file or leave the previous file intact. */
export function writeMemoryText(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive:true});
  const temp = path + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = openSync(temp,'wx',0o600);
    writeFileSync(fd,text,'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp,path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
