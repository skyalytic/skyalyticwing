import { Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { createRequire } from 'node:module';
import { LoggerService } from '../logger/logger.service.js';
import { SecurityManagerService } from '../security/security-manager.service.js';
import { parseCommandSegments } from '../utils/exec-args.util.js';

/**
 * DepsService - 依赖检查服务
 *
 * 移植自 start.cjs 的 DependencyChecker（行 624-826）：
 *   - check：平台二进制依赖（which/where 探测）+ npm 依赖（require.resolve 探测）
 *   - autoInstall：SKYALYTICWING_AUTO_INSTALL_DEPS=1 时按安装命令自动安装
 *   - getReport：文本化依赖报告
 *
 * 安全约束：所有命令执行前必须通过 SecurityManagerService.isCommandAllowed 校验。
 */

/** 平台二进制依赖定义 */
interface PlatformDep {
  name: string;
  check: string | null;
  install: string | null;
  desc: string;
  builtin?: boolean;
  altCheck?: string;
  altInstall?: string;
}

/** npm 依赖定义 */
interface NpmDep {
  name: string;
  desc: string;
  installHint: string;
}

/** 依赖检查结果（对齐 .cjs check() 结构） */
export interface DepsCheckResult {
  platform: string;
  installed: Array<{ name: string; desc?: string }>;
  missing: Array<{ name: string; desc: string; install: string | null }>;
  builtin: Array<{ name: string; desc: string }>;
  npmMissing: Array<{ name: string; desc: string; installHint: string }>;
}

/** 顶层 require 重命名为 dynamicRequire（ES2022 约束） */
const dynamicRequire = createRequire(__filename);

/** 平台依赖注册表（与 .cjs _deps 对齐） */
const PLATFORM_DEPS: Record<string, PlatformDep[]> = {
  mac: [
    { name: 'cliclick', check: 'which cliclick', install: 'brew install cliclick', desc: '桌面鼠标/键盘控制' },
    { name: 'screencapture', check: null, install: null, desc: '屏幕截图（系统内置）', builtin: true },
  ],
  linux: [
    {
      name: 'xdotool',
      check: 'which xdotool',
      install: 'sudo apt install -y xdotool',
      desc: '桌面鼠标/键盘控制',
      altInstall: 'sudo yum install -y xdotool || sudo pacman -S xdotool',
    },
    {
      name: 'scrot',
      check: 'which scrot',
      install: 'sudo apt install -y scrot',
      desc: '屏幕截图',
      altCheck: 'which import',
      altInstall: 'sudo apt install -y imagemagick',
    },
    {
      name: 'libnotify',
      check: 'which notify-send',
      install: 'sudo apt install -y libnotify-bin',
      desc: '桌面通知',
      altInstall: 'sudo yum install -y libnotify || sudo pacman -S libnotify',
    },
    { name: 'curl', check: 'which curl', install: 'sudo apt install -y curl', desc: '网络请求（技能市场等）' },
  ],
  win: [
    { name: 'powershell', check: null, install: null, desc: '命令执行（系统内置）', builtin: true },
  ],
};

/** npm 依赖注册表（与 .cjs _npmDeps 对齐） */
const NPM_DEPS: NpmDep[] = [
  { name: 'playwright-core', desc: '浏览器控制', installHint: 'npm install playwright-core' },
];

/** 检查结果缓存（与 .cjs _results 语义一致，autoInstall 后失效重算） */
let cachedResults: DepsCheckResult | null = null;

@Injectable()
export class DepsService {
  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  /** 依赖检查（结果缓存） */
  check(): DepsCheckResult {
    if (cachedResults) return cachedResults;
    const plat = this.getPlatform();
    const deps = PLATFORM_DEPS[plat] || [];
    const result: DepsCheckResult = {
      platform: plat,
      missing: [],
      installed: [],
      builtin: [],
      npmMissing: [],
    };

    for (const dep of deps) {
      if (dep.builtin) {
        result.builtin.push({ name: dep.name, desc: dep.desc });
        continue;
      }
      let available = this.runProbe(dep.check);
      if (!available && dep.altCheck) {
        available = this.runProbe(dep.altCheck);
      }
      if (available) {
        result.installed.push({ name: dep.name, desc: dep.desc });
      } else {
        result.missing.push({ name: dep.name, desc: dep.desc, install: dep.install });
      }
    }

    for (const nd of NPM_DEPS) {
      try {
        dynamicRequire.resolve(nd.name);
        result.installed.push({ name: nd.name, desc: nd.desc });
      } catch {
        result.npmMissing.push(nd);
      }
    }

    cachedResults = result;
    return result;
  }

  /**
   * 自动安装缺失依赖
   * - 需设置 SKYALYTICWING_AUTO_INSTALL_DEPS 环境变量
   * - 安装命令须通过 SecurityManager.isCommandAllowed 校验
   */
  autoInstall(): boolean {
    const results = this.check();
    if (results.missing.length === 0) {
      this.logger.info('[deps] 所有依赖已满足');
      return true;
    }
    this.logger.warn('[deps] 检测到缺失依赖', { count: results.missing.length });
    if (!process.env['SKYALYTICWING_AUTO_INSTALL_DEPS']) {
      this.logger.info('[deps] 设置环境变量 SKYALYTICWING_AUTO_INSTALL_DEPS=1 可自动安装缺失依赖');
      return false;
    }

    this.logger.info('[deps] 开始自动安装');
    let allOk = true;
    for (const d of results.missing) {
      const cmd = PLATFORM_DEPS[results.platform]?.find((p) => p.name === d.name)?.install || null;
      if (!cmd) continue;
      this.logger.info('[deps] 安装 ' + d.name);
      const ok = this.runInstall(cmd, 120_000);
      if (ok) {
        this.logger.info('[deps] ' + d.name + ' 安装成功');
        continue;
      }
      const altCmd = PLATFORM_DEPS[results.platform]?.find((p) => p.name === d.name)?.altInstall;
      if (altCmd) {
        this.logger.info('[deps] 主安装失败，尝试备选方案');
        if (this.runInstall(altCmd, 120_000)) {
          this.logger.info('[deps] ' + d.name + ' 备选安装成功');
          continue;
        }
      }
      this.logger.warn('[deps] ' + d.name + ' 安装失败');
      allOk = false;
    }
    cachedResults = null;
    return allOk;
  }

  /** 文本化依赖报告（对齐 .cjs getReport） */
  getReport(): string {
    const r = this.check();
    const lines: string[] = ['平台: ' + r.platform];
    if (r.builtin.length > 0) {
      lines.push('内置: ' + r.builtin.map((d) => d.name).join(', '));
    }
    if (r.installed.length > 0) {
      lines.push('已安装: ' + r.installed.map((d) => d.name).join(', '));
    }
    if (r.missing.length > 0) {
      lines.push('缺失: ' + r.missing.map((d) => `${d.name}(${d.desc})`).join(', '));
    }
    if (r.npmMissing.length > 0) {
      lines.push('npm缺失: ' + r.npmMissing.map((d) => `${d.name}(${d.desc}) → ${d.installHint}`).join(', '));
    }
    return lines.join('\n');
  }

  /** 探测命令是否存在（探测命令须经 SecurityManager.isCommandAllowed；execFileSync 数组参数防注入） */
  private runProbe(command: string | null): boolean {
    if (!command) return false;
    if (!this.security.isCommandAllowed(command)) {
      this.logger.warn('[deps] 探测命令被安全策略拒绝', { command });
      return false;
    }
    const segments = parseCommandSegments(command);
    if (!segments) {
      this.logger.warn('[deps] 探测命令含不支持的 shell 特性', { command });
      return false;
    }
    return this.runSegments(segments, 5000);
  }

  /** 执行安装命令（须经 SecurityManager.isCommandAllowed；execFileSync 数组参数防注入） */
  private runInstall(command: string, timeoutMs: number): boolean {
    if (!this.security.isCommandAllowed(command)) {
      this.logger.warn('[deps] 安装命令被安全策略拒绝', { command });
      return false;
    }
    const segments = parseCommandSegments(command);
    if (!segments) {
      this.logger.warn('[deps] 安装命令含不支持的 shell 特性', { command });
      return false;
    }
    return this.runSegments(segments, timeoutMs);
  }

  /** 按段顺序 execFileSync 执行。seg.joiner = 与前段的连接符（首段占位恒执行）：&& 前段失败则跳过 / || 前段成功则跳过 */
  private runSegments(
    segments: Array<{ argv: string[]; joiner: '&&' | '||' }>,
    timeoutMs: number,
  ): boolean {
    let ok = true;
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx] as { argv: string[]; joiner: '&&' | '||' };
      if (idx > 0 && ((seg.joiner === '&&' && !ok) || (seg.joiner === '||' && ok))) continue;
      try {
        execFileSync(seg.argv[0] as string, seg.argv.slice(1), {
          timeout: timeoutMs,
          stdio: 'ignore',
        });
        ok = true;
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  private getPlatform(): string {
    const plat = platform();
    if (plat === 'win32') return 'win';
    if (plat === 'darwin') return 'mac';
    return 'linux';
  }
}
