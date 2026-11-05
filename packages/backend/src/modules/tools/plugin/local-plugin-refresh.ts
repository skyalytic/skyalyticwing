import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Only source/config files participate; caches and private runtime data must not trigger reloads. */
export function pluginFingerprint(root: string): string {
  const digest = createHash('sha256');
  let count = 0, bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || ['node_modules', 'data', 'logs'].includes(name)) continue;
      const file = join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('插件源文件不可使用符号链接');
      if (++count > 4000) throw new Error('插件源文件过多');
      if (stat.isDirectory()) walk(file);
      else if (/\.(?:[cm]?js|json|ts)$/i.test(name)) {
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024) throw new Error('插件源文件过大');
        digest.update(file.slice(root.length)).update(readFileSync(file));
      }
    }
  };
  walk(root);
  return digest.digest('hex');
}
