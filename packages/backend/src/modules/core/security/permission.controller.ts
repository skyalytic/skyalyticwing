import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { ApiTags } from '../swagger/swagger-decorators.js';
import { ConfigService } from '../config/config.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { SecurityManagerService } from './security-manager.service.js';
import { CommandGuardService } from './command-guard.service.js';
import { YoloClassifierService } from '../../tools/executor/yolo-classifier.service.js';
import { ApprovalService } from '../../tools/executor/approval.service.js';
import {
  type CommandRuleType,
  type PermissionMode,
  type PermissionRuleType,
  ChangePermissionRuleDto,
  ClassifyCommandDto,
  CreateCommandRuleDto,
  CreatePermissionRuleDto,
  DeleteAuditDto,
  DeleteCommandRuleDto,
  DeletePermissionRuleDto,
  SandboxRunDto,
  SwitchPermissionModeDto,
} from './dto/permission.dto.js';
import {
  SecurityApproveDto,
  SecurityAuditDto,
  SecurityFixDto,
  SecurityPairingDto,
  SecurityScanSkillDto,
} from './dto/security.dto.js';

/**
 * PermissionController - 权限/安全管理 REST API（路由前缀 /api）
 *
 * 全量对齐旧版 start.cjs 中的权限/安全相关路由，覆盖多个路径前缀：
 *   /permissions/*  - 权限模式、路径规则、命令规则、分类、审计
 *   /yolo/*         - YOLO 模式命令分类
 *   /secretref/*    - 密钥引用审计与解析
 *   /security/*     - 安全扫描、沙箱执行、设备配对、审计修复
 *
 * 安全特性：
 *   - 19 种危险模式检测（rm -rf、format、mkfs、dd、fork bomb 等）
 *   - 6 种 Shell 转义检测（; & | ` $() &&）
 *   - 25 个敏感路径保护（/etc、/root、C:\Windows、~/.ssh 等）
 *   - 路径操作调用 SecurityManagerService.isPathAllowed()
 *   - 命令操作调用 SecurityManagerService.isCommandAllowed()
 *   - 响应经全局 RedactInterceptor 自动脱敏敏感字段
 */

// ─── 危险命令模式（19 种） ──────────────────────────────────────────────────

const DANGEROUS_PATTERNS: readonly string[] = [
  'rm -rf',
  'del /s',
  'format',
  'mkfs',
  'dd if=',
  'chmod 777',
  'chown',
  '> /etc/',
  'curl|sh',
  'wget|sh',
  ':(){:|:&};:',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'taskkill /f',
  'reg delete',
  'net user',
  'net localgroup',
];

// ─── Shell 转义字符（6 种） ─────────────────────────────────────────────────

const SHELL_ESCAPE_CHARS: readonly string[] = [';', '&', '|', '`', '$()', '&&'];

// ─── 敏感路径（25 个） ──────────────────────────────────────────────────────

const SENSITIVE_PATHS: readonly string[] = [
  '/etc',
  '/root',
  '/var/log',
  '/var/run',
  '/usr/local/etc',
  '/opt',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/hosts',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config',
  '~/.docker',
  '~/.kube',
  '~/.bash_history',
];

// ─── 正常命令列表 ────────────────────────────────────────────────────────────

const NORMAL_COMMANDS: readonly string[] = [
  'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'find',
  'which', 'where', 'echo', 'pwd', 'whoami', 'hostname',
  'date', 'uname', 'df', 'du', 'free', 'top', 'ps',
  'env', 'printenv', 'git', 'node', 'npm', 'python',
];

// ─── 技能注入扫描模式（7 种，对齐 .cjs SecurityGuard.scanSkill） ────────────

interface SkillInjectionPattern {
  pattern: RegExp;
  desc: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

const SKILL_INJECTION_PATTERNS: readonly SkillInjectionPattern[] = [
  {
    pattern: /ignore\s+(previous|above|all)\s+instructions/i,
    desc: 'Prompt注入: 忽略指令',
    severity: 'HIGH',
  },
  {
    pattern: /you\s+are\s+now\s+(DAN|jailbreak|unrestricted)/i,
    desc: 'Prompt注入: 角色逃逸',
    severity: 'CRITICAL',
  },
  {
    pattern: /system\s*prompt|system\s*message/i,
    desc: '尝试读取系统提示',
    severity: 'MEDIUM',
  },
  {
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i,
    desc: '硬编码密钥/密码',
    severity: 'HIGH',
  },
  {
    pattern: /curl\s+.*\|\s*(bash|sh)/i,
    desc: '远程代码执行',
    severity: 'HIGH',
  },
  {
    pattern: /eval\s*\(|Function\s*\(|new\s+Function/i,
    desc: '动态代码执行',
    severity: 'MEDIUM',
  },
  {
    pattern: /child_process|subprocess|os\.system/i,
    desc: '子进程调用',
    severity: 'MEDIUM',
  },
];

/** 技能扫描单条发现 */
interface SkillScanFinding {
  file: string;
  rule: string;
  severity: string;
  desc: string;
}

/** 单文件大小上限（超过则跳过扫描） */
const SKILL_SCAN_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 权限规则存储条目 */
interface PermissionRuleEntry {
  id: string;
  type: PermissionRuleType;
  tool: string;
  reason: string;
  createdAt: number;
}

/** 命令分类结果 */
interface CommandClassification {
  level: 'normal' | 'dangerous' | 'unknown';
  cmdName: string;
  matchedRules: string[];
}

/** 密钥引用审计问题 */
interface SecretRefIssue {
  severity: string;
  message: string;
  line?: number;
  content?: string;
}

@ApiTags('Permissions')
@Controller()
export class PermissionController {
  /** 权限规则 ID 计数器 */
  private ruleCounter = 0;

  constructor(
    private readonly security: SecurityManagerService,
    private readonly commandGuard: CommandGuardService,
    private readonly yoloClassifier: YoloClassifierService,
    private readonly approvalService: ApprovalService,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  // ===========================================================================
  // /permissions - 权限配置
  // ===========================================================================

  /** GET /permissions — 获取权限配置 */
  @Get('permissions')
  getPermissions(): ApiResponse<Record<string, unknown>> {
    const mode = this.getPermissionMode();
    const rules = this.getPermissionRules();
    const commandRules = this.commandGuard.listCommandRules().map((r) => ({
      ...r,
      createdAt: Date.now(),
    }));

    const allow = rules.filter((r) => r.type === 'allow');
    const deny = rules.filter((r) => r.type === 'deny');
    const ask = rules.filter((r) => r.type === 'ask');

    // 审计日志从 ApprovalService 历史获取（最近 50 条）
    const auditLog = this.approvalService.getApprovalHistory().map((e) => ({
      id: e.id,
      tool: e.tool ?? e.toolName,
      status: e.status,
      decision: e.decision,
      reason: e.reason,
      createdAt: e.createdAt,
    }));

    return {
      success: true,
      data: {
        mode,
        allow,
        deny,
        ask,
        commandRules,
        /** 内置安全命令（只读白名单，任何模式免审批；移出需在命令规则中配置） */
        builtinSafeCommands: this.yoloClassifier.getSafeCommands(),
        auditLog,
        dangerousPatterns: DANGEROUS_PATTERNS.length,
        shellEscapeChecks: SHELL_ESCAPE_CHARS.length,
        sensitivePaths: SENSITIVE_PATHS.length,
      },
    };
  }

  /** PUT /permissions/mode — 切换权限模式（写 security.yolo，AgentLoop 安全闸门实时读取） */
  @Put('permissions/mode')
  @HttpCode(HttpStatus.OK)
  switchMode(@Body() dto: SwitchPermissionModeDto): ApiResponse<{ mode: PermissionMode }> {
    try {
      if (!['ask', 'auto', 'yolo'].includes(dto.mode)) throw new Error('Invalid permission mode');
      const previous = this.safeGetConfig<Record<string, unknown>>('security');
      const security = { ...previous, yolo: dto.mode };
      this.config.set('security', security);
      try { this.config.save(); }
      catch (error) { this.config.set('security', previous); throw error; }
      if (dto.mode === 'yolo') this.approvalService.approvePendingForFullAccess();
      this.approvalService.notifyPermissionsChanged();
      this.logger.info('Permission mode switched', { mode: dto.mode, scope: 'permission' });
      return { success: true, data: { mode: dto.mode } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── 路径/工具权限规则 ──────────────────────────────────────────────────────

  /** POST /permissions/rules — 创建权限规则 */
  @Post('permissions/rules')
  @HttpCode(HttpStatus.OK)
  createPermissionRule(@Body() dto: CreatePermissionRuleDto): ApiResponse<PermissionRuleEntry> {
    try {
      const rules = this.getPermissionRules();
      this.ruleCounter++;
      const entry: PermissionRuleEntry = {
        id: `perm-${this.ruleCounter}-${Date.now().toString(36)}`,
        type: dto.type,
        tool: dto.tool,
        reason: dto.reason ?? '',
        createdAt: Date.now(),
      };
      rules.push(entry);
      this.savePermissionRules(rules);
      this.logger.info('Permission rule created', { tool: dto.tool, type: dto.type, scope: 'permission' });
      return { success: true, data: entry };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** DELETE /permissions/rules — 删除权限规则（按 id 或 tool） */
  @Delete('permissions/rules')
  @HttpCode(HttpStatus.OK)
  deletePermissionRule(@Body() dto: DeletePermissionRuleDto): ApiResponse<{ deleted: string }> {
    try {
      const rules = this.getPermissionRules();
      const idx = rules.findIndex((r) =>
        (dto.id && r.id === dto.id) || (dto.tool && r.tool === dto.tool),
      );
      if (idx === -1) {
        return { success: false, error: 'Rule not found', code: 'NOT_FOUND' };
      }
      const removed = rules.splice(idx, 1)[0]!;
      this.savePermissionRules(rules);
      return { success: true, data: { deleted: removed.id } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /permissions/rules/change — 修改规则 */
  @Post('permissions/rules/change')
  @HttpCode(HttpStatus.OK)
  changePermissionRule(@Body() dto: ChangePermissionRuleDto): ApiResponse<PermissionRuleEntry> {
    try {
      const rules = this.getPermissionRules();
      const rule = rules.find((r) => r.id === dto.id);
      if (!rule) {
        return { success: false, error: 'Rule not found', code: 'NOT_FOUND' };
      }
      if (dto.type) rule.type = dto.type;
      if (dto.tool) rule.tool = dto.tool;
      if (dto.reason !== undefined) rule.reason = dto.reason;
      this.savePermissionRules(rules);
      return { success: true, data: rule };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** DELETE /permissions/rules/:id — 删除指定规则 */
  @Delete('permissions/rules/:id')
  @HttpCode(HttpStatus.OK)
  deletePermissionRuleById(@Param('id') id: string): ApiResponse<{ deleted: string }> {
    try {
      const rules = this.getPermissionRules();
      const idx = rules.findIndex((r) => r.id === id);
      if (idx === -1) {
        return { success: false, error: 'Rule not found', code: 'NOT_FOUND' };
      }
      rules.splice(idx, 1);
      this.savePermissionRules(rules);
      return { success: true, data: { deleted: id } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── 命令规则 ───────────────────────────────────────────────────────────────

  /** POST /permissions/command-rules — 创建命令规则 */
  @Post('permissions/command-rules')
  @HttpCode(HttpStatus.OK)
  createCommandRule(@Body() dto: CreateCommandRuleDto): ApiResponse<{ id: string }> {
    try {
      const id = this.commandGuard.addCommandRule(
        dto.type as CommandRuleType,
        dto.command,
        dto.reason,
      );
      this.logger.info('Command rule created', { command: dto.command, type: dto.type, scope: 'permission' });
      return { success: true, data: { id } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** DELETE /permissions/command-rules — 删除命令规则 */
  @Delete('permissions/command-rules')
  @HttpCode(HttpStatus.OK)
  deleteCommandRule(@Body() dto: DeleteCommandRuleDto): ApiResponse<{ deleted: string }> {
    try {
      let removed = false;
      if (dto.id) {
        removed = this.commandGuard.removeCommandRule(dto.id);
      } else if (dto.command) {
        const rules = this.commandGuard.listCommandRules();
        const rule = rules.find((r) => r.command === dto.command);
        if (rule) {
          removed = this.commandGuard.removeCommandRule(rule.id);
        }
      }
      if (!removed) {
        return { success: false, error: 'Command rule not found', code: 'NOT_FOUND' };
      }
      return { success: true, data: { deleted: dto.id ?? dto.command ?? '' } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── 命令分类 ───────────────────────────────────────────────────────────────

  /** POST /permissions/classify — 命令分类测试 */
  @Post('permissions/classify')
  @HttpCode(HttpStatus.OK)
  classifyCommand(@Body() dto: ClassifyCommandDto): ApiResponse<CommandClassification> {
    const result = this.classifyCommandInternal(dto.command);
    return { success: true, data: result };
  }

  // ── 审计日志 ───────────────────────────────────────────────────────────────

  /** POST /permissions/audit/clear — 清空审计日志 */
  @Post('permissions/audit/clear')
  @HttpCode(HttpStatus.OK)
  clearAuditLog(): ApiResponse<{ cleared: number }> {
    // 审计日志由 ApprovalService 的内存 history 维护，清空为真实删除
    const { cleared } = this.approvalService.clearHistory();
    this.logger.info('Audit log cleared', { cleared, scope: 'permission' });
    return { success: true, data: { cleared } };
  }

  /** POST /permissions/audit/delete — 删除单条审计 */
  @Post('permissions/audit/delete')
  @HttpCode(HttpStatus.OK)
  deleteAuditEntry(@Body() dto: DeleteAuditDto): ApiResponse<{ deleted: string }> {
    const removed = this.approvalService.deleteHistoryEntry(dto.id);
    if (!removed) {
      return { success: false, error: 'Audit entry not found', code: 'NOT_FOUND' };
    }
    this.logger.info('Audit entry deleted', { id: dto.id, scope: 'permission' });
    return { success: true, data: { deleted: dto.id } };
  }

  // ===========================================================================
  // /yolo - YOLO 模式命令分类
  // ===========================================================================

  /** GET /yolo/classify — YOLO 模式命令分类 */
  @Get('yolo/classify')
  classifyYolo(@Query('command') command: string): ApiResponse<Record<string, unknown>> {
    const decision = this.yoloClassifier.classify(command);
    return {
      success: true,
      data: {
        decision: decision.decision,
        confidence: decision.confidence,
        reason: decision.reason,
        matchedPattern: decision.reason,
      },
    };
  }

  // ===========================================================================
  // /secretref - 密钥引用审计
  // ===========================================================================

  /** GET /secretref/audit — 密钥引用审计 */
  @Get('secretref/audit')
  auditSecretRef(): ApiResponse<Record<string, unknown>> {
    const issues: SecretRefIssue[] = [];
    let totalRefs = 0;

    const config = this.config.getAll();
    const secretPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    const hardcodePattern = /(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;

    const scan = (obj: unknown, path: string): void => {
      if (typeof obj === 'string') {
        let match: RegExpExecArray | null;
        secretPattern.lastIndex = 0;
        while ((match = secretPattern.exec(obj)) !== null) {
          totalRefs++;
          issues.push({
            severity: 'INFO',
            message: `环境变量引用: \${${match[1]}} 在 ${path}`,
            content: `\${${match[1]}}`,
          });
        }
        if (hardcodePattern.test(obj)) {
          issues.push({
            severity: 'CRITICAL',
            message: `检测到硬编码密钥在 ${path}`,
            content: obj.substring(0, 20) + '...',
          });
        }
      } else if (obj !== null && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          scan(v, path ? `${path}.${k}` : k);
        }
      }
    };
    scan(config, '');

    this.logger.info('Secret ref audit completed', { totalRefs, issues: issues.length, scope: 'security' });
    return {
      success: true,
      data: {
        issues,
        totalIssues: issues.length,
        totalRefs,
      },
    };
  }

  /** GET /secretref/resolve — 密钥解析 */
  @Get('secretref/resolve')
  resolveSecretRef(@Query('ref') ref: string): ApiResponse<Record<string, unknown>> {
    if (!ref) {
      return { success: false, error: 'Missing ref parameter' };
    }
    const refPattern = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
    const match = refPattern.exec(ref);
    if (!match) {
      return { success: false, error: `Invalid ref format: ${ref}` };
    }
    const envName = match[1]!;
    const value = process.env[envName];
    if (!value) {
      return { success: false, error: `Environment variable not set: ${envName}` };
    }
    return {
      success: true,
      data: {
        ref,
        envName,
        resolved: true,
        maskedValue: maskSecret(value),
      },
    };
  }

  // ===========================================================================
  // /security - 安全扫描、沙箱、配对、修复
  // ===========================================================================

  /** POST /security/audit — 安全扫描 */
  @Post('security/audit')
  @HttpCode(HttpStatus.OK)
  runSecurityAudit(@Body() dto?: SecurityAuditDto): ApiResponse<Record<string, unknown>> {
    try {
      if (dto?.skillName) {
        const safe = this.security.isPathAllowed(dto.skillName, 'read');
        return {
          success: true,
          data: {
            safe,
            skillName: dto.skillName,
            findings: safe ? [] : [{ desc: `Path not allowed: ${dto.skillName}` }],
          },
        };
      }
      const findings = this.security.runAudit();
      return {
        success: true,
        data: {
          findings: findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            area: f.area,
            description: f.description,
            fixable: f.fixable,
          })),
          total: findings.length,
          report: this.security.getAuditReport(),
        },
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /security/sandbox/run — 沙箱执行 */
  @Post('security/sandbox/run')
  @HttpCode(HttpStatus.OK)
  async runInSandbox(@Body() dto: SandboxRunDto): Promise<ApiResponse<Record<string, unknown>>> {
    try {
      if (!this.security.isCommandAllowed(dto.command)) {
        return { success: false, error: `Command blocked by security guard: ${dto.command}` };
      }
      let sandboxId = dto.sandboxId;
      if (!sandboxId) {
        sandboxId = this.security.createDockerSandbox({ timeout: 30000 });
      }
      const result = await this.security.runInDocker(dto.command, { sandboxId });
      return {
        success: true,
        data: {
          sandboxId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /security/pairing — DM 设备配对（6 位码，5 分钟有效） */
  @Post('security/pairing')
  @HttpCode(HttpStatus.OK)
  generatePairingCode(@Body() dto?: SecurityPairingDto): ApiResponse<Record<string, unknown>> {
    try {
      const pairingOpts: { expiresIn: number; channel?: string } = { expiresIn: 5 * 60 * 1000 };
      if (dto?.channel) pairingOpts.channel = dto.channel;
      const result = this.security.generatePairingCode(dto?.senderId ?? 'api', pairingOpts);
      return {
        success: true,
        data: {
          code: result.code,
          pairingCode: result.code,
          expiresAt: result.expiresAt,
        },
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /security/fix — 修复单个安全问题 */
  @Post('security/fix')
  @HttpCode(HttpStatus.OK)
  fixSecurityIssue(@Body() dto: SecurityFixDto): ApiResponse<Record<string, unknown>> {
    try {
      const result = this.security.fixFinding(dto.id);
      return { success: result.success, data: result, ...(result.reason ? { error: result.reason } : {}) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /security/fix-all — 修复所有安全问题 */
  @Post('security/fix-all')
  @HttpCode(HttpStatus.OK)
  fixAllSecurityIssues(): ApiResponse<Record<string, unknown>[]> {
    try {
      const results = this.security.fixAllFindings();
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** GET /security/devices — 已配对设备列表 */
  @Get('security/devices')
  listPairedDevices(): ApiResponse<Record<string, unknown>> {
    const devices = this.security.listPairedDevices();
    return {
      success: true,
      data: { devices },
    };
  }

  /** DELETE /security/devices/:id — 注销设备 */
  @Delete('security/devices/:id')
  @HttpCode(HttpStatus.OK)
  revokeDevice(@Param('id') id: string): ApiResponse<{ revoked: string }> {
    const success = this.security.revokeDevice(id);
    if (!success) {
      return { success: false, error: `Device not found: ${id}`, code: 'NOT_FOUND' };
    }
    return { success: true, data: { revoked: id } };
  }

  /** GET /security/status — 安全状态总览（权限模式 + 规则数 + 沙箱 + 配对设备聚合） */
  @Get('security/status')
  async getSecurityStatus(): Promise<ApiResponse<Record<string, unknown>>> {
    const rules = this.getPermissionRules();
    const commandRules = this.commandGuard.listCommandRules();
    const auditLog = this.approvalService.getApprovalHistory();
    const devices = this.security.listPairedDevices();

    let dockerAvailable = false;
    try {
      dockerAvailable = await this.security.isDockerAvailable();
    } catch {}

    return {
      success: true,
      data: {
        enabled: true,
        permissionMode: this.getPermissionMode(),
        permissionRulesCount: rules.length,
        permissionRulesAllow: rules.filter((r) => r.type === 'allow').length,
        permissionRulesDeny: rules.filter((r) => r.type === 'deny').length,
        permissionRulesAsk: rules.filter((r) => r.type === 'ask').length,
        commandRulesCount: commandRules.length,
        commandRulesAllow: commandRules.filter((r) => r.type === 'allow').length,
        commandRulesDeny: commandRules.filter((r) => r.type === 'deny').length,
        auditLogCount: auditLog.length,
        sandbox: {
          type: 'docker',
          available: dockerAvailable,
        },
        pairedDevicesCount: devices.length,
        dangerousPatterns: DANGEROUS_PATTERNS.length,
        shellEscapeChecks: SHELL_ESCAPE_CHARS.length,
        sensitivePaths: SENSITIVE_PATHS.length,
      },
    };
  }

  /** POST /security/scan-skill — 技能安全扫描（扫描 skills/<name> 目录中的危险模式） */
  @Post('security/scan-skill')
  @HttpCode(HttpStatus.OK)
  scanSkill(@Body() dto: SecurityScanSkillDto): ApiResponse<Record<string, unknown>> {
    try {
      const skillName = (dto?.skillName || '').trim();
      if (!skillName) {
        return { success: false, error: 'skillName required' };
      }
      if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
        return { success: false, error: '无效的技能名称' };
      }

      const skillsRoot = this.resolveSkillsRoot();
      const skillDir = resolvePath(join(skillsRoot, skillName));
      const rootWithSep = resolvePath(skillsRoot) + sep;
      if (!skillDir.startsWith(rootWithSep)) {
        return { success: false, error: '路径不允许超出skills目录' };
      }
      if (!this.security.isPathAllowed(skillDir, 'read')) {
        return { success: false, error: `路径未在白名单内：${skillDir}` };
      }
      if (!existsSync(skillDir)) {
        return { success: false, error: `Skill not found: ${skillName}`, code: 'NOT_FOUND' };
      }

      const { findings, totalFiles } = this.scanSkillDir(skillDir);
      const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
      this.logger.info('Skill security scan completed', {
        skillName,
        totalFiles,
        findings: findings.length,
        scope: 'security',
      });
      return {
        success: true,
        data: {
          skillName,
          safe: !hasCritical,
          findings,
          totalFiles,
        },
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** POST /security/approve — 安全审批（always → 全局允许列表；session → 会话允许列表） */
  @Post('security/approve')
  @HttpCode(HttpStatus.OK)
  approvePattern(@Body() dto: SecurityApproveDto): ApiResponse<Record<string, unknown>> {
    try {
      const security = this.safeGetConfig<Record<string, unknown>>('security');
      const pattern = dto?.pattern || '';
      const mode = dto?.mode === 'always' ? 'always' : 'session';

      if (mode === 'always') {
        const list = Array.isArray(security['alwaysApproved'])
          ? (security['alwaysApproved'] as string[])
          : [];
        if (pattern) list.push(pattern);
        security['alwaysApproved'] = list;
      } else {
        const sessionId = dto?.sessionId || 'default';
        const map =
          security['sessionApproved'] && typeof security['sessionApproved'] === 'object'
            ? (security['sessionApproved'] as Record<string, string[]>)
            : {};
        const arr = Array.isArray(map[sessionId]) ? map[sessionId]! : [];
        if (pattern) arr.push(pattern);
        map[sessionId] = arr;
        security['sessionApproved'] = map;
      }

      this.config.set('security', security);
      this.config.save();
      this.logger.info('Security pattern approved', { mode, pattern, scope: 'security' });
      return { success: true, data: { approved: true, mode, pattern } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ===========================================================================
  // 内部辅助方法
  // ===========================================================================

  /** 读取权限模式 */
  private getPermissionMode(): PermissionMode {
    try {
      // 与 AgentLoop 安全闸门同源：读 security.yolo（此前读 general.permissionMode
      // 是无人消费的死配置，导致设置页模式切换对实际审批行为无效）
      const security = this.config.get<Record<string, unknown>>('security');
      const mode = security['yolo'];
      if (mode === 'ask' || mode === 'auto' || mode === 'yolo') return mode;
    } catch {}
    return 'ask';
  }

  /** 读取权限规则 */
  private getPermissionRules(): PermissionRuleEntry[] {
    try {
      const security = this.safeGetConfig<Record<string, unknown>>('security');
      const rules = security['permissionRules'];
      if (Array.isArray(rules)) return rules.map(rule => ({ ...rule })) as PermissionRuleEntry[];
    } catch {}
    return [];
  }

  /** 保存权限规则 */
  private savePermissionRules(rules: PermissionRuleEntry[]): void {
    const previous = this.safeGetConfig<Record<string, unknown>>('security');
    const security = { ...previous, permissionRules: rules };
    this.config.set('security', security);
    try { this.config.save(); }
    catch (error) { this.config.set('security', previous); throw error; }
  }

  /** 安全读取配置段（不存在时返回空对象） */
  private safeGetConfig<T>(section: string): T {
    try {
      const v = this.config.get<T>(section);
      if (v !== null && typeof v === 'object') return v;
    } catch {}
    return {} as T;
  }

  /**
   * 命令分类核心逻辑
   * - 19 种危险模式检测
   * - 6 种 Shell 转义检测
   * - 正常/危险/未知 三级分类
   */
  private classifyCommandInternal(command: string): CommandClassification {
    if (!command || typeof command !== 'string') {
      return { level: 'unknown', cmdName: '', matchedRules: [] };
    }

    const cmd = command.trim().toLowerCase();
    const cmdName = cmd.split(/\s+/)[0] ?? '';
    const matchedRules: string[] = [];

    // 6 种 Shell 转义检测
    for (const esc of SHELL_ESCAPE_CHARS) {
      if (cmd.includes(esc.toLowerCase())) {
        matchedRules.push(`shell-escape:${esc}`);
      }
    }

    // 19 种危险模式检测
    for (const pattern of DANGEROUS_PATTERNS) {
      if (cmd.includes(pattern.toLowerCase())) {
        matchedRules.push(`dangerous:${pattern}`);
        return { level: 'dangerous', cmdName, matchedRules };
      }
    }

    // 25 个敏感路径检测
    for (const path of SENSITIVE_PATHS) {
      if (cmd.includes(path.toLowerCase())) {
        matchedRules.push(`sensitive-path:${path}`);
        return { level: 'dangerous', cmdName, matchedRules };
      }
    }

    // 正常命令检测
    for (const normal of NORMAL_COMMANDS) {
      if (cmdName === normal || cmd.startsWith(normal + ' ')) {
        return { level: 'normal', cmdName, matchedRules };
      }
    }

    // 通过 SecurityManager 校验
    if (!this.security.isCommandAllowed(command)) {
      matchedRules.push('blocked-by-command-guard');
      return { level: 'dangerous', cmdName, matchedRules };
    }

    // 通过 YoloClassifier 辅助判断
    const yolo = this.yoloClassifier.classify(command);
    if (yolo.decision === 'deny') {
      matchedRules.push(`yolo-deny:${yolo.reason}`);
      return { level: 'dangerous', cmdName, matchedRules };
    }

    return { level: 'unknown', cmdName, matchedRules };
  }

  /** 解析 skills 根目录（与 SkillService 一致：${dataDir}/skills） */
  private resolveSkillsRoot(): string {
    const dataDir =
      process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    return join(dataDir, 'skills');
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }

  /**
   * 扫描技能目录：遍历全部文件（跳过符号链接、realpath 逃逸、超过 10MB 的文件），
   * 对文本内容执行 7 种注入模式检测（对齐 .cjs SecurityGuard.scanSkill）。
   */
  private scanSkillDir(skillDir: string): { findings: SkillScanFinding[]; totalFiles: number } {
    const findings: SkillScanFinding[] = [];
    const files: string[] = [];
    const rootPrefix = resolvePath(skillDir);

    const walk = (dir: string): void => {
      let items: string[];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of items) {
        const fp = join(dir, name);
        try {
          const st = statSync(fp);
          if (st.isSymbolicLink()) continue;
          const real = realpathSync(fp);
          if (!real.startsWith(rootPrefix)) continue;
          if (st.isDirectory()) walk(fp);
          else if (st.size < SKILL_SCAN_MAX_FILE_SIZE) files.push(fp);
        } catch {}
      }
    };
    walk(skillDir);

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf8');
        for (let p = 0; p < SKILL_INJECTION_PATTERNS.length; p++) {
          const rule = SKILL_INJECTION_PATTERNS[p]!;
          if (rule.pattern.test(content)) {
            findings.push({
              file: relative(skillDir, file),
              rule: `injection_${p}`,
              severity: rule.severity,
              desc: rule.desc,
            });
          }
        }
      } catch {}
    }

    return { findings, totalFiles: files.length };
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 脱敏密钥（只显示前 4 位 + ****） */
function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return value.substring(0, 4) + '****';
}
