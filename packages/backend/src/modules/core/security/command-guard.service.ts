import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../config/config.service.js';

/** 命令规则类型 */
export type CommandRuleType = 'allow' | 'deny';

/** 用户角色 */
export type UserRole = 'admin' | 'user' | 'viewer';

/** 命令规则 */
export interface CommandRule {
  id: string;
  type: CommandRuleType;
  command: string;
  reason: string;
  pattern: string;
}

/**
 * CommandGuardService - 命令黑白名单载体
 *
 * 命令门控（与用户确认的三层闸门设计对齐）：
 *   - 本服务只承载用户命令白名单（allow）与黑名单（deny），是唯一命令名单事实源
 *   - 名单外命令默认放行——是否需要审批由 AgentLoop 的模式判定决定
 *     （此前实现"未匹配默认拒绝"，导致审批通过的 pip 等命令在执行层被静默拦截）
 *   - 危险命令不预置黑名单：与普通命令一致走审批（用户确认的设计）
 *   - 内置安全命令（ls/cat/git status 等）的免审批判定由 YoloClassifier 承担
 *   - 规则匹配优先级：deny 先于 allow；支持 glob（"pip install *" 等）
 *   - 持久化到 command-rules.json
 *
 * 安全特性：
 *   - H-B7: 防止 ReDoS — 通配符超过 10 个回退到字面比较，使用 [^]* 替代 .*
 *   - M-B14: 原子写入持久化文件
 */
@Injectable()
export class CommandGuardService implements OnModuleInit {
  private readonly logger = new Logger(CommandGuardService.name);

  /** 命令规则列表 */
  private commandRules: CommandRule[] = [];

  /** 安全数据目录 */
  private dataDir: string;

  /** 是否已初始化 */
  private initialized = false;

  /** 命令注入风险字符 */
  private static readonly INJECTION_PATTERN = /[;&|`$(){}\\\n\r]/;

  constructor(private readonly config: ConfigService) {
    this.dataDir = this.resolveDataDir();
  }

  onModuleInit(): void {
    this.init();
  }

  /** 解析安全数据目录 */
  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'security');
    return join(homedir(), '.skyalyticwing', 'security');
  }

  /** 初始化（幂等） */
  init(): void {
    if (this.initialized) {
      this.logger.log('init() 已初始化，跳过（幂等）');
      return;
    }

    this.ensureDir(this.dataDir);

    // 加载持久化命令规则
    this.loadCommandRules();

    // 标记已初始化（addCommandRule 依赖此标志）
    this.initialized = true;

    // Do not infer ownership from command text: a user may deliberately deny
    // the same command that appeared in an old default rule. Preserve saved rules.

    // 从 ConfigService 读取用户自定义黑名单，合并为 deny 规则
    this.loadConfigBlockedCommands();

    this.logger.log(`CommandGuard 已初始化 (dataDir: ${this.dataDir})`);
  }

  /** 确保已初始化 */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('CommandGuardService 未初始化，请等待 OnModuleInit 完成');
    }
  }

  // ===========================================================================
  // 命令门控核心
  // ===========================================================================

  /**
   * 检查命令是否被允许（执行层防线：仅黑名单拦截）。
   *
   * 纯黑白名单语义：deny 命中 → false；allow 命中 → true；名单外 → true
   * （默认放行。是否需要审批由 AgentLoop 审批闸门按模式判定，
   * 此前的"名单外默认拒绝"曾导致审批通过的命令在执行层被静默拦截）
   *
   * @param command 命令字符串
   * @param _role 用户角色（保留参数兼容旧签名，名单语义下不再参与判定）
   */
  isCommandAllowed(command: string, _role?: UserRole): boolean {
    this.ensureInitialized();
    if (!command) return false;

    // 黑名单优先：任何模式下都拒绝
    if (this.isCommandBlacklisted(command)) return false;
    // 白名单或名单外：执行层放行（审批判定在 AgentLoop）
    return true;
  }

  /** 命令是否命中用户白名单（allow 规则，任何模式直接放行） */
  isCommandWhitelisted(command: string): boolean {
    this.ensureInitialized();
    if (!command) return false;
    for (const rule of this.commandRules) {
      if (rule.type === 'allow' && this.matchCommandPattern(rule.command, command)) {
        return true;
      }
    }
    return false;
  }

  /** 命令是否命中用户黑名单（deny 规则，任何模式直接拒绝） */
  isCommandBlacklisted(command: string): boolean {
    this.ensureInitialized();
    if (!command) return false;
    for (const rule of this.commandRules) {
      if (rule.type === 'deny' && this.matchCommandPattern(rule.command, command)) {
        return true;
      }
    }
    return false;
  }

  /** 添加命令规则（同 type+command 幂等：已存在时直接返回既有规则 ID） */
  addCommandRule(type: CommandRuleType, command: string, reason?: string): string {
    this.ensureInitialized();

    if (type !== 'allow' && type !== 'deny') {
      throw new Error('规则类型必须是 "allow" 或 "deny"');
    }

    // 幂等：审批"始终允许/始终拒绝"可能对同一命令重复触发，避免产生重复规则
    const existing = this.commandRules.find(
      (r) => r.type === type && r.command === command,
    );
    if (existing) return existing.id;

    const rule: CommandRule = {
      id: `rule-${randomUUID()}`,
      type,
      command,
      reason: reason || '',
      pattern: command,
    };

    const previous = this.commandRules;
    this.commandRules = [...previous, rule];
    this.logger.log(`添加命令规则: ${type} ${command}`);
    try { this.persistCommandRules(); }
    catch (error) { this.commandRules = previous; throw error; }

    return rule.id;
  }

  /** 移除命令规则 */
  removeCommandRule(ruleId: string): boolean {
    this.ensureInitialized();

    for (let i = 0; i < this.commandRules.length; i++) {
      if (this.commandRules[i].id === ruleId) {
        const previous = this.commandRules;
        this.commandRules = previous.filter((_, index) => index !== i);
        try { this.persistCommandRules(); }
        catch (error) { this.commandRules = previous; throw error; }
        this.logger.log(`移除命令规则: ${ruleId}`);
        return true;
      }
    }
    return false;
  }

  /** 列出所有命令规则（副本） */
  listCommandRules(): CommandRule[] {
    this.ensureInitialized();
    return this.commandRules.slice();
  }

  /** 检测字符串中是否包含 shell 元字符（命令注入风险） */
  hasInjectionRisk(input: string): boolean {
    if (!input) return false;
    return CommandGuardService.INJECTION_PATTERN.test(input);
  }

  // ===========================================================================
  // 内部辅助方法
  // ===========================================================================

  /**
   * 匹配命令模式（glob 风格）
   * H-B7 修复：防止 ReDoS
   *   - 通配符 * 超过 10 个时回退到字面比较
   *   - 使用 [^]* 替代 .* 避免灾难性回溯
   *   - 仅使用单个贪婪量词
   * 裸命令兼容：模式 "X *"（如 "pip install *"）额外精确匹配 "X"
   *   ——"始终允许 pip --version" 生成的 "pip --version *" 若不兼容裸命令，
   *   二次执行同命令仍会弹审批（regex ^pip --version [^]*$ 要求尾随空格）
   */
  private matchCommandPattern(pattern: string, command: string): boolean {
    // "X *" 形模式：裸命令 "X"（无尾随参数）也应命中
    if (pattern.endsWith(' *')) {
      const bare = pattern.slice(0, -2);
      if (bare.toLowerCase() === command.toLowerCase()) return true;
    }

    // 统计通配符数量
    let starCount = 0;
    for (let s = 0; s < pattern.length; s++) {
      if (pattern.charAt(s) === '*') starCount++;
    }
    if (starCount > 10) {
      return pattern.toLowerCase() === command.toLowerCase();
    }

    // 转换 glob 为正则
    const regexStr = '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^]*')
      .replace(/\?/g, '.') + '$';
    try {
      const regex = new RegExp(regexStr, 'i');
      return regex.test(command);
    } catch {
      return pattern.toLowerCase() === command.toLowerCase();
    }
  }

  /** 从 ConfigService 读取用户自定义黑名单 */
  private loadConfigBlockedCommands(): void {
    try {
      const security = this.config.get<Record<string, unknown>>('security');
      const userBlocked = security['blockedCommands'];
      if (Array.isArray(userBlocked)) {
        for (const cmd of userBlocked) {
          if (typeof cmd === 'string' && cmd.length > 0) {
            // 用户自定义黑名单作为 deny 规则添加
            this.addCommandRule('deny', cmd, '用户自定义黑名单');
          }
        }
      }
    } catch {
      // 配置读取失败不影响初始化
    }
  }

  // ===========================================================================
  // 持久化
  // ===========================================================================

  private persistCommandRules(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'command-rules.json');
    this.saveJson(filePath, this.commandRules);
  }

  private loadCommandRules(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'command-rules.json');
    this.commandRules = this.loadJson<CommandRule[]>(filePath, []);
  }

  // ===========================================================================
  // 通用文件持久化辅助（原子写入，M-B14 修复）
  // ===========================================================================

  private ensureDir(dirPath: string): void {
    try {
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`创建目录失败 ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadJson<T>(filePath: string, defaultValue: T): T {
    try {
      if (existsSync(filePath)) {
        const data = readFileSync(filePath, 'utf8');
        return JSON.parse(data) as T;
      }
    } catch (err) {
      this.logger.error(`加载文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return defaultValue;
  }

  private saveJson(filePath: string, data: unknown): void {
    try {
      this.ensureDir(dirname(filePath));
      const content = JSON.stringify(data, null, 2);
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, content, 'utf8');
      try {
        renameSync(tmpPath, filePath);
      } catch (error) {
        try { unlinkSync(tmpPath); } catch {}
        throw error;
      }
    } catch (err) {
      this.logger.error(`保存文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
