import { Injectable, Optional } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolContext } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { getDefaultDataDir, resolveWebDataDir } from '../../core/utils/web-data.util.js';
import {
  COMMAND_TOOLS,
  READ_ONLY_TOOLS,
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  SANDBOX_PRESETS,
  WRITE_TOOLS,
  extractPathArg,
  isSandboxMode,
  type SandboxGateDecision,
  type SandboxMode,
  type SandboxPreset,
} from './sandbox-profiles.js';

/** 本地持久化配置（dataDir/sandbox-profile.json） */
export interface SandboxProfileConfig {
  /** 全局默认档位 */
  mode: SandboxMode;
  /** 当前应用的权限预设 id（null = 自定义档位） */
  presetId: string | null;
}

/** 会话级档位覆盖（内存态，随进程生命周期） */
interface SessionOverride {
  mode: SandboxMode;
  createdAt: number;
}

/**
 * SandboxProfileService - 三级沙箱档位服务
 *
 * 维护全局档位（持久化）与会话级覆盖（内存），提供工具执行前的档位判定：
 *   - danger-full-access：全部放行（不改变既有行为，默认档位）
 *   - read-only：写类工具与命令面工具一律拦截（可经审批一次性提权）
 *   - workspace-write：写类工具按路径判定，仅放行工作区内写入
 *
 * 判定根与写工具实现保持一致：ctx.workspace || process.cwd()。
 */
@Injectable()
export class SandboxProfileService {
  private config: SandboxProfileConfig = { mode: DEFAULT_SANDBOX_MODE, presetId: null };
  private readonly sessionOverrides = new Map<string, SessionOverride>();

  constructor(
    private readonly logger: LoggerService,
    /**
     * 数据目录（可注入用于测试隔离；缺省为用户数据目录）。
     * 必须标注 @Optional()：string 是原生类型，DI 元数据 emit 为 String，
     * 容器无对应 provider；不标注会让 Nest 启动即抛
     * "can't resolve dependencies ... argument String at index [1]"（打包 smoke 已实锤）。
     * 单测直接 new 传参不经过 DI，不受影响。
     */
    @Optional()
    private readonly dataDir?: string,
  ) {
    this.config = this.loadConfig();
    this.logger.info(
      `sandbox-profile: mode=${this.config.mode}, preset=${this.config.presetId ?? 'custom'}`,
    );
  }

  /** 当前配置（全局） */
  getConfig(): SandboxProfileConfig {
    return { ...this.config };
  }

  /** 内置预设清单 */
  listPresets(): SandboxPreset[] {
    return SANDBOX_PRESETS.map((p) => ({ ...p }));
  }

  /** 合法档位清单 */
  listModes(): SandboxMode[] {
    return [...SANDBOX_MODES];
  }

  /** 设置全局档位（presetId 给出时同步取预设，mode 缺省取预设档位） */
  setMode(patch: { mode?: SandboxMode; presetId?: string | null }): SandboxProfileConfig {
    const previous = this.config;
    if (patch.mode !== undefined && !isSandboxMode(patch.mode)) throw new Error('需要有效的 mode');
    if (typeof patch.presetId === 'string') {
      const preset = SANDBOX_PRESETS.find((p) => p.id === patch.presetId);
      if (!preset) throw new Error(`未知权限预设: ${patch.presetId}`);
      this.config = {
        mode: patch.mode && isSandboxMode(patch.mode) ? patch.mode : preset.mode,
        presetId: preset.id,
      };
    } else {
      if (!patch.mode || !isSandboxMode(patch.mode))
        throw new Error('需要有效的 mode（read-only / workspace-write / danger-full-access）');
      this.config = { mode: patch.mode, presetId: null };
    }
    try { this.persistConfig(); }
    catch (error) { this.config = previous; throw error; }
    this.logger.info(
      `sandbox-profile: mode=${this.config.mode}, preset=${this.config.presetId ?? 'custom'}`,
    );
    return { ...this.config };
  }

  /** 设置会话级档位覆盖（mode=null 清除覆盖，回落全局） */
  setSessionMode(sessionId: string, mode: SandboxMode | null): void {
    if (mode === null) {
      this.sessionOverrides.delete(sessionId);
      return;
    }
    if (!isSandboxMode(mode)) throw new Error('需要有效的 mode');
    this.sessionOverrides.set(sessionId, { mode, createdAt: Date.now() });
  }

  /** 解析生效档位：会话覆盖 > 全局 */
  effectiveMode(sessionId?: string): SandboxMode {
    if (sessionId) {
      const override = this.sessionOverrides.get(sessionId);
      if (override) return override.mode;
    }
    return this.config.mode;
  }

  /**
   * 工具执行前档位判定。
   * approvalGranted（一次性提权）由调用方（tool-executor）处理，本方法只做纯判定。
   */
  check(input: { toolName: string; args: unknown; ctx: ToolContext }): SandboxGateDecision {
    const mode = this.effectiveMode(input.ctx.sessionId);
    if (mode === 'danger-full-access') {
      return { allowed: true, rule: 'pass' };
    }

    const name = input.toolName.replace(/_/g, '-');
    const isWriteTool = WRITE_TOOLS.includes(name);
    const isReadTool = READ_ONLY_TOOLS.includes(name);
    const isCommandTool = COMMAND_TOOLS.includes(name) || (!isWriteTool && !isReadTool);

    if (mode === 'read-only') {
      if (isWriteTool) {
        return {
          allowed: false,
          rule: 'write-tool',
          reason: `只读沙箱：工具 ${input.toolName} 会修改文件，需要一次性提权审批`,
        };
      }
      if (isCommandTool) {
        return {
          allowed: false,
          rule: 'command-tool',
          reason: `只读沙箱：工具 ${input.toolName} 属命令/控制面，可产生任意副作用，需要一次性提权审批`,
        };
      }
      return { allowed: true, rule: 'pass' };
    }

    // workspace-write：写类工具按路径判定工作区边界
    if (isWriteTool) {
      const root = input.ctx.workspace || process.cwd();
      const pathArg = extractPathArg(input.args);
      if (pathArg === undefined) {
        return {
          allowed: false,
          rule: 'outside-workspace',
          reason: `工作区沙箱：工具 ${input.toolName} 未提供可判定的目标路径，需要一次性提权审批`,
        };
      }
      const target = isAbsolute(pathArg) ? pathArg : resolve(root, pathArg);
      if (!this.isInsideWorkspace(target, root)) {
        return {
          allowed: false,
          rule: 'outside-workspace',
          reason: `工作区沙箱：目标路径 ${target} 位于工作区 ${root} 之外，需要一次性提权审批`,
        };
      }
      return { allowed: true, rule: 'pass' };
    }

    // bash is routed through the container executor. Other side effects require explicit approval.
    if (isCommandTool && name !== 'bash')
      return {
        allowed: false,
        rule: 'command-tool',
        reason: `工具 ${input.toolName} 未声明可验证的工作区权限，需要逐次审批`,
      };
    return { allowed: true, rule: 'pass' };
  }

  /** 工作区边界判定（规范化相对路径；跨盘/绝对回落判外，方向保守） */
  private isInsideWorkspace(target: string, workspace: string): boolean {
    const canonical = (path: string): string => {
      const absolute = resolve(path);
      if (existsSync(absolute)) return realpathSync(absolute);
      const parent = dirname(absolute);
      return parent === absolute
        ? absolute
        : resolve(canonical(parent), relative(parent, absolute));
    };
    try {
      const rel = relative(canonical(workspace), canonical(target));
      return (
        rel === '' ||
        (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel))
      );
    } catch {
      return false;
    }
  }

  // ────────────────────────── 持久化 ──────────────────────────

  private profilePath(): string {
    return resolve(this.dataDir || getDefaultDataDir(), 'sandbox-profile.json');
  }

  private loadConfig(): SandboxProfileConfig {
    const candidates = [this.profilePath(), resolve(resolveWebDataDir(), 'sandbox-profile.json')];
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
        const mode = isSandboxMode(raw['mode']) ? raw['mode'] : DEFAULT_SANDBOX_MODE;
        const presetId = typeof raw['presetId'] === 'string' ? raw['presetId'] : null;
        return {
          mode,
          presetId: presetId && SANDBOX_PRESETS.some((x) => x.id === presetId) ? presetId : null,
        };
      } catch {
        // 解析失败尝试下一个候选
      }
    }
    return { mode: DEFAULT_SANDBOX_MODE, presetId: null };
  }

  private persistConfig(): void {
    const p = this.profilePath();
    const temporary = `${p}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.config, null, 2), 'utf-8');
      renameSync(temporary, p);
    } catch (err) {
      try { unlinkSync(temporary); } catch {}
      this.logger.warn(
        `sandbox-profile: 配置写入失败 ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
