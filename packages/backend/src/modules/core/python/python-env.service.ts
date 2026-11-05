import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IS_WIN } from './platform.util.js';

/** 解析结果 */
export interface PythonEnvInfo {
  /** 可执行文件（bundled 为绝对路径；system 为命令名，走 PATH） */
  bin: string;
  source: 'bundled' | 'system';
}

/** 探测捆绑解释器：从基准目录向上最多 8 级，逐级尝试 deploy/python 与 build/python-embed
 *  两种形态（dev 与打包态目录深度不同，递归向上与层级无关）。独立导出便于单测。 */
export function detectBundledPython(fromDir: string): string | null {
  const exe = IS_WIN ? 'python.exe' : join('bin', 'python3');
  let dir = fromDir;
  for (let i = 0; i < 8; i += 1) {
    const candidates = [
      join(dir, 'python', exe), // 打包态：deploy/python/
      join(dir, 'build', 'python-embed', exe), // 仓库根形态：build/python-embed/
    ];
    for (const c of candidates) {
      try {
        if (existsSync(c)) return c;
      } catch {
        /* 忽略非法路径 */
      }
    }
    // A source checkout owns its runtime inputs; never use a parent checkout's
    // build cache when this repository has not prepared Python yet.
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 系统解释器探测：win 依次 python/py；unix 依次 python3/python */
export function detectSystemPython(): string | null {
  const candidates = IS_WIN ? ['python', 'py'] : ['python3', 'python'];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { timeout: 1500, stdio: 'pipe', windowsHide: true });
      return bin;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

/**
 * PythonEnvService - 捆绑 Python 环境解析（全局服务）
 *
 * 安装包内置嵌入式 Python（prepare-python.cjs 产出到 deploy/python），
 * AI 的 python 工具/桌面自动化优先使用捆绑解释器（用户零配置即用），
 * 未捆绑或损坏时回退系统解释器。
 */
@Injectable()
export class PythonEnvService {
  private readonly logger = new Logger('PythonEnvService');
  private cache: PythonEnvInfo | null | undefined;
  /** 解析基准目录（bundled 探测起点；测试可覆写） */
  private baseDir = __dirname;

  /** 测试/特殊部署：覆盖解析基准目录 */
  withBaseDir(dir: string): this {
    this.baseDir = dir;
    this.cache = undefined;
    return this;
  }

  /** 解析可用解释器；都不可用时返回 null（调用方给出引导文案） */
  resolve(): PythonEnvInfo | null {
    if (this.cache !== undefined) return this.cache;
    const envBin = process.env['SKYWING_PYTHON'];
    if (envBin && existsSync(envBin)) {
      this.cache = { bin: envBin, source: 'bundled' };
      this.logger.log(`Python（环境变量指定）: ${envBin}`);
      return this.cache;
    }
    const bundled = detectBundledPython(this.baseDir);
    if (bundled) {
      this.cache = { bin: bundled, source: 'bundled' };
      this.logger.log(`Python（捆绑）: ${bundled}`);
      return this.cache;
    }
    const system = detectSystemPython();
    if (system) {
      this.cache = { bin: system, source: 'system' };
      this.logger.log(`Python（系统）: ${system}`);
      return this.cache;
    }
    this.cache = null;
    return null;
  }

  /** 未找到时的用户引导文案（AI 工具返回给模型转述） */
  missingHint(): string {
    return (
      '未找到可用的 Python 解释器。可在终端执行官方安装（https://www.python.org/downloads/），' +
      '安装时勾选 "Add python.exe to PATH"，或改用 node/powershell 工具完成任务。'
    );
  }
}
