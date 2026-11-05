// 应用版本解析（唯一事实源：monorepo 根 package.json，与 tauri.conf.json 一致）
// 不使用 config.version——其默认值 '1.0.0' 是配置模板值，非应用版本
// （曾导致监控页/系统信息显示错误版本 1.0.0）。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/** 版本回退值（与根 package.json / tauri.conf.json 保持同步） */
export const APP_VERSION_FALLBACK = '2.1.0';

/** 向上查找 monorepo 根 package.json（根包名 skyalyticwing）并读取版本 */
export function resolveAppVersion(): string {
  try {
    const manifest = resolvePath(__dirname, '../../../../app-version.json');
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
      if (value.version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version)) return value.version;
    }
    let cur = __dirname;
    for (let i = 0; i < 9; i++) {
      const pkgPath = join(cur, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        // 根包无 workspace 子包名（backend/frontend 等子包版本不是应用版本）
        if (['skyalyticwing', 'skyalyticwing-community', 'skyalyticwing-enterprise'].includes(pkg.name || '')) {
          if (typeof pkg.version === 'string' && pkg.version.length > 0) {
            return pkg.version;
          }
        }
      }
      const parent = resolvePath(cur, '..');
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    /* 解析失败使用回退值 */
  }
  return APP_VERSION_FALLBACK;
}
