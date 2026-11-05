import { writeJsonAtomicSync, readJsonRecover } from './atomic-json.util.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  copyFileSync,
  statSync,
  symlinkSync,
  readlinkSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { desktopEdition } from './desktop-edition.js';

/**
 * Web 数据目录（packages/web/data）解析工具
 *
 * 新旧版本共存期间的统一数据落盘位置。按以下顺序探测：
 *   1. SKYALYTICWING_WEB_DATA_DIR 环境变量
 *   2. <cwd>/packages/web/data          （monorepo 根目录启动）
 *   3. <cwd>/../../packages/web/data    （packages/backend 目录启动）
 *   4. <cwd>/web/data                   （packages/web 目录启动）
 *   5. <cwd>/data                       （兜底）
 */
export function resolveWebDataDir(): string {
  if (process.env['SKYALYTICWING_WEB_DATA_DIR']) return process.env['SKYALYTICWING_WEB_DATA_DIR']!;
  if (desktopEdition()) return join(getDefaultDataDir(), 'web');
  // __dirname = <backend>/dist/modules/core/utils（开发态）或
  // <backend>/deploy/dist/modules/core/utils（打包态）。上溯 5 级到 packages/（开发态），
  // 上溯 6 级到 _up_/packages/（打包态）——使解析不依赖 cwd（守护进程场景
  // cwd 可能为 deploy/ 目录，cwd 基准候选全部失配）。
  const candidates = [
    process.env['SKYALYTICWING_WEB_DATA_DIR'],
    join(process.cwd(), 'packages', 'web', 'data'),
    join(process.cwd(), '..', '..', 'packages', 'web', 'data'),
    join(process.cwd(), 'web', 'data'),
    join(process.cwd(), 'data'),
    join(__dirname, '..', '..', '..', '..', '..', 'web', 'data'),
    join(__dirname, '..', '..', '..', '..', '..', '..', 'web', 'data'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** 运行时用户数据目录解析（与 SessionService.getDefaultDataDir 一致）。
 * 按以下顺序解析：
 *   1. SKYALYTICWING_DATA_DIR 环境变量（SkyalyticWing 改名后的新变量）
 *   2. SKYALYTICCLAW_DATA_DIR 环境变量（SkyalyticClaw 时期旧变量，向后兼容）
 *   3. Windows: %APPDATA%/SkyalyticWing
 *      macOS:  ~/Library/Application Support/SkyalyticWing
 *      Linux:  $XDG_CONFIG_HOME/skyalyticwing 或 ~/.config/skyalyticwing
 */
export function getDefaultDataDir(): string {
  const envDir = process.env['SKYALYTICWING_DATA_DIR'] || process.env['SKYALYTICCLAW_DATA_DIR'];
  if (envDir) return envDir;

  const plat = platform();
  const edition = desktopEdition();
  const directory = edition === 'community' ? 'SkyalyticWingCommunity' : edition === 'enterprise' ? 'SkyalyticWingEnterprise' : 'SkyalyticWing';
  if (plat === 'win32') {
    const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appData, directory);
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', directory);
  }
  const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(xdg, edition ? directory : 'skyalyticwing');
}

/**
 * 历史数据目录迁移（两段链，对齐此前 com.skyalyticclaw.desktop → SkyalyticClaw 的迁移模式）。
 *
 * 数据目录历史沿革：
 *   1.1.x~1.3.3  com.skyalyticclaw.desktop （Tauri identifier 目录）
 *   1.3.3 之后   SkyalyticClaw
 *   本次改名起   SkyalyticWing
 *
 * 首次启动（新目录不存在且某个旧目录存在）时整体复制旧目录内容到新目录，
 * 成功后保留旧目录作为升级备份；新版本只读写 Wing 目录。
 * 旧目录按"较新优先"顺序探测（SkyalyticClaw 在前），只迁第一个命中的；
 * 若两者同时存在（罕见：多版本混装），未迁移的一个保留原样不删，不丢数据。
 *
 * 注意：设置 SKYALYTICWING_DATA_DIR / SKYALYTICCLAW_DATA_DIR（测试/自定义环境）时
 * 跳过——测试目录不存在不应触发对真实旧目录的迁移。
 */
export function migrateLegacyAppData(): void {
  if (desktopEdition()) return;
  if (process.env['SKYALYTICWING_DATA_DIR'] || process.env['SKYALYTICCLAW_DATA_DIR']) return;
  const target = getDefaultDataDir();
  if (existsSync(target) && readdirSync(target).length > 0) return;

  // 硬编码历史目录名字面量——这些是磁盘上的真实旧目录名，不随品牌改名变化
  const LEGACY_DIRS = ['SkyalyticClaw', 'skyalyticclaw', 'com.skyalyticclaw.desktop'];
  const plat = platform();
  const baseDirs = (() => {
    if (plat === 'win32') {
      return [process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming')];
    }
    if (plat === 'darwin') {
      return [join(homedir(), 'Library', 'Application Support')];
    }
    return [
      process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
      join(homedir(), '.config'),
    ];
  })();

  let legacy: string | null = null;
  for (const name of LEGACY_DIRS) {
    for (const base of baseDirs) {
      const candidate = join(base, name);
      if (existsSync(candidate)) {
        legacy = candidate;
        break;
      }
    }
    if (legacy) break;
  }
  if (!legacy) return;

  // 原子迁移：先复制到临时目录，全部成功后 rename 到目标——
  // 避免中途 crash 留下"部分数据的 target"，下次启动 existsSync(target) 跳过
  // 迁移导致旧数据永久无法迁移（数据丢失窗口）
  const staging = `${target}.migrating`;
  try {
    rmSync(staging, { recursive: true, force: true });
    copyDirRecursive(legacy, staging);
    // Only remove an empty destination; never overwrite an existing Wing profile.
    if (existsSync(target)) rmdirSync(target);
    renameSync(staging, target);
    console.log(`[init] Migrated appData from ${legacy} to ${target}`);
    console.log('[init] Previous Claw profile preserved as an upgrade backup');
  } catch (e) {
    console.error('[init] appData migration failed:', (e as Error).message);
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // 清理失败不影响启动；.migrating 残留不会被读，下次启动重试
    }
    throw new Error('Unable to migrate the Claw profile; original data is preserved', { cause: e });
  }
}

/**
 * 预设代理工作区种子拷贝（对齐旧版 start.cjs 522-551）。
 *
 * 启动时将内置预设（packages/web/data/workspaces，打包后为捆绑资源）拷贝到
 * 用户数据目录 workspaces/：
 *   - 目标不存在 → 整体拷贝（首次运行）
 *   - 目标存在   → 仅拷贝缺失的代理目录，绝不覆盖用户已有内容
 *
 * 注意：设置 SKYALYTICWING_DATA_DIR / SKYALYTICCLAW_DATA_DIR（测试/自定义环境）时跳过，与
 * migrateLegacyAppData 的跳过条件一致。
 */
export function seedPresetWorkspaces(): void {
  if (process.env['SKYALYTICWING_DATA_DIR'] || process.env['SKYALYTICCLAW_DATA_DIR']) return;

  const source = join(resolveWebDataDir(), 'workspaces');
  if (!existsSync(source)) return;

  const dest = join(getDefaultDataDir(), 'workspaces');
  try {
    if (!existsSync(dest)) {
      copyDirRecursive(source, dest);
      console.log(`[init] Copied preset workspaces to ${dest}`);
      return;
    }
    // 同步新增代理目录，不覆盖已有（对齐旧版逐目录增量同步）
    let copied = 0;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcAgent = join(source, entry.name);
      const dstAgent = join(dest, entry.name);
      if (!existsSync(dstAgent)) {
        copyDirRecursive(srcAgent, dstAgent);
        copied++;
      }
    }
    if (copied > 0) console.log(`[init] Copied ${copied} new agent workspaces`);
  } catch (e) {
    console.error('[init] Failed to copy workspaces:', (e as Error).message);
  }
}

/** 递归复制目录（对齐旧版 _copyDirRecursive；symlink 按链接复制而非 follow，避免 EISDIR/循环） */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isSymbolicLink()) {
      // 按链接原样复制（junction 会被识别为目录走递归分支，仅 symlink 到达此处）
      try {
        symlinkSync(readlinkSync(from), to);
      } catch {
        // 链接创建失败（权限/跨设备）→ 降级复制目标内容（statSync follow 链接判断目标类型）
        if (statSync(from).isDirectory()) copyDirRecursive(from, to);
        else copyFileSync(from, to);
      }
    } else {
      copyFileSync(from, to);
    }
  }
}

/** 读取 JSON 文件（不存在或解析失败时返回 fallback） */
export function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const parsed = readJsonRecover<T>(filePath, fallback);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** 写入 JSON 文件（自动创建父目录） */
export function saveJsonFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeJsonAtomicSync(filePath, data);
}
