import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LoggerService } from '../logger/logger.service.js';
import { SecurityManagerService } from '../security/security-manager.service.js';
import { getDefaultDataDir, loadJsonFile, resolveWebDataDir } from '../utils/web-data.util.js';
import type { CreateBackupDto } from './dto/backup.dto.js';
import { writeJsonAtomicSync } from '../utils/atomic-json.util.js';

/**
 * BackupService - 备份系统
 *
 * 移植自 start.cjs BackupSystem：
 *   - 打包 data 目录核心 JSON + 可选 workspaces / memory / dreams 文件
 *   - 备份写入 packages/web/data/backups/backup-<ts>.json，自动保留最近 10 份
 *   - 完整性校验（schemaVersion / timestamp / config / sessions 等）
 *   - 恢复（逐文件回写 + 路径安全校验）
 *   - 名称清洗（剥离 .. 与路径分隔符，防目录穿越）
 */

/** 备份文件名清洗 */
function sanitizeBackupName(name: string): string {
  return String(name ?? '')
    .replace(/\.\./g, '')
    .replace(/[\\/]/g, '');
}

/** 备份元数据结构 */
interface BackupFile {
  schemaVersion: number;
  version?: string;
  createdAt: number;
  timestamp: string;
  platform?: string;
  nodeVersion?: string;
  config?: unknown;
  sessions?: unknown;
  memory?: unknown;
  agents?: unknown;
  permissions?: unknown;
  cronJobs?: unknown;
  subAgents?: unknown;
  customAgents?: unknown;
  mcp?: unknown;
  bindings?: unknown;
  toolPolicies?: unknown;
  plugins?: unknown;
  acp?: unknown;
  sandbox?: unknown;
  usage?: unknown;
  workspaceFiles?: Record<string, string>;
  memoryFiles?: Record<string, string>;
  dreamFiles?: Record<string, string>;
}

/** 备份保留份数 */
const KEEP_COUNT = 10;
/** 单文件收录上限（100KB，对齐旧版） */
const MAX_FILE_SIZE = 102_400;

@Injectable()
export class BackupService implements OnModuleInit {
  /** 旧版数据目录（packages/web/data）——兼容读取来源 */
  private readonly webDataDir = resolveWebDataDir();
  /** 运行时用户数据目录（SKYALYTICWING_DATA_DIR 或 %APPDATA%/SkyalyticWing）——优先读写目标 */
  private readonly userDataDir = getDefaultDataDir();
  /** 备份目录：优先用户数据目录；仅旧目录存在而新目录不存在时沿用旧目录 */
  private readonly backupDir = existsSync(join(this.userDataDir, 'backups')) || !existsSync(join(this.webDataDir, 'backups'))
    ? join(this.userDataDir, 'backups')
    : join(this.webDataDir, 'backups');

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  onModuleInit(): void {
    // 备份需读写用户数据目录（通常位于 cwd 之外），启动时加入路径白名单
    try {
      this.security.addAllowedPath(this.userDataDir, 'readwrite');
      if (this.backupDir.startsWith(this.webDataDir)) {
        this.security.addAllowedPath(this.webDataDir, 'readwrite');
      }
    } catch {
      // 白名单注册失败不阻断启动，后续操作按现有策略判定
    }
  }

  /**
   * 解析数据文件路径：优先用户数据目录，不存在再回退 packages/web/data；
   * 两处均不存在时返回用户数据目录路径（作为默认写入目标）。
   */
  private resolveDataFile(filename: string): string {
    const userPath = join(this.userDataDir, filename);
    if (existsSync(userPath)) return userPath;
    const webPath = join(this.webDataDir, filename);
    if (existsSync(webPath)) return webPath;
    return userPath;
  }

  /** 解析数据子目录（workspaces/memory/dreams）：优先存在的目录 */
  private resolveDataSubDir(subDir: string): string {
    const userDir = join(this.userDataDir, subDir);
    if (existsSync(userDir)) return userDir;
    return join(this.webDataDir, subDir);
  }

  /** 创建备份 */
  create(options: CreateBackupDto): { success: boolean; filename: string; name: string; size: number; path: string } | { success: false; error: string } {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `backup-${ts}.json`;
      if (!existsSync(this.backupDir)) mkdirSync(this.backupDir, { recursive: true });
      if (!this.security.isPathAllowed(join(this.backupDir, backupName), 'write')) {
        return { success: false, error: '备份目录不在路径安全策略允许范围' };
      }

      // agents 与 customAgents 字段同源（custom-agents.json），只读一次文件
      const agentsData = loadJsonFile(this.resolveDataFile('custom-agents.json'), {});
      const backup: BackupFile = {
        schemaVersion: 1,
        createdAt: Date.now(),
        timestamp: ts,
        platform: process.platform,
        nodeVersion: process.version,
        config: options.includeConfig !== false ? loadJsonFile(this.resolveDataFile('config.json'), null) : null,
        sessions: options.includeSessions !== false ? loadJsonFile(this.resolveDataFile('sessions.json'), null) : null,
        memory: options.includeMemory !== false ? loadJsonFile(this.resolveDataFile('memory.json'), {}) : null,
        agents: options.includeAgents !== false ? agentsData : null,
        permissions: options.includePermissions !== false ? loadJsonFile(this.resolveDataFile('permissions.json'), {}) : null,
        cronJobs: options.includeCron !== false ? loadJsonFile<{ jobs?: unknown[] }>(this.resolveDataFile('cron.json'), {}).jobs ?? null : null,
        subAgents: options.includeSubAgents !== false ? loadJsonFile(this.resolveDataFile('subagents.json'), {}) : null,
        customAgents: agentsData,
        mcp: loadJsonFile(this.resolveDataFile('mcp.json'), {}),
        bindings: loadJsonFile(this.resolveDataFile('bindings.json'), []),
        toolPolicies: loadJsonFile(this.resolveDataFile('tool-policies.json'), {}),
        plugins: loadJsonFile(this.resolveDataFile('plugins.json'), {}),
        acp: loadJsonFile(this.resolveDataFile('acp.json'), {}),
        sandbox: loadJsonFile(this.resolveDataFile('sandbox.json'), {}),
        usage: loadJsonFile(this.resolveDataFile('usage.json'), {}),
      };

      if (options.includeWorkspace) backup.workspaceFiles = this.collectDirFiles(this.resolveDataSubDir('workspaces'));
      if (options.includeMemoryFiles) backup.memoryFiles = this.collectFlatFiles(this.resolveDataSubDir('memory'));
      if (options.includeDreams) backup.dreamFiles = this.collectFlatFiles(this.resolveDataSubDir('dreams'));

      const backupPath = join(this.backupDir, backupName);
      writeJsonAtomicSync(backupPath, backup);
      const stat = statSync(backupPath);
      this.logger.info(`backup: 备份已创建 ${backupName}（${Math.round(stat.size / 1024)}KB）`);
      this.cleanupOld();
      return { success: true, filename: backupName, name: backupName, size: stat.size, path: backupPath };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 备份列表 */
  list(): Array<{ name: string; filename: string; size: number; createdAt: number }> {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const stat = statSync(join(this.backupDir, f));
          return { name: f, filename: f, size: stat.size, createdAt: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; filename: string; size: number; createdAt: number } => x !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 校验备份完整性 */
  verify(name: string): Record<string, unknown> {
    const backupName = sanitizeBackupName(name);
    const backupPath = join(this.backupDir, backupName);
    if (!backupName || !existsSync(backupPath)) {
      return { valid: false, error: `备份文件不存在: ${backupName}` };
    }
    try {
      const data = JSON.parse(readFileSync(backupPath, 'utf-8')) as BackupFile;
      const checks: Array<{ item: string; valid: boolean; count?: number }> = [];
      checks.push({ item: 'schemaVersion', valid: !!data.schemaVersion || !!data.version });
      checks.push({ item: 'timestamp', valid: !!data.createdAt });
      checks.push({ item: 'config', valid: data.config !== null && data.config !== undefined });
      checks.push({ item: 'sessions', valid: data.sessions !== null && data.sessions !== undefined });
      const sessionCount = data.sessions && typeof data.sessions === 'object' ? Object.keys(data.sessions).length : 0;
      checks.push({ item: 'session_count', valid: true, count: sessionCount });
      checks.push({ item: 'permissions', valid: data.permissions !== null && data.permissions !== undefined });
      checks.push({ item: 'agents', valid: data.agents !== null && data.agents !== undefined });
      return {
        valid: checks.every((c) => c.valid),
        checks,
        backupName,
        sessionCount,
        platform: data.platform,
        nodeVersion: data.nodeVersion,
      };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 恢复备份 */
  restore(name: string): { success: boolean; error?: string } {
    const backupName = sanitizeBackupName(name);
    const backupPath = join(this.backupDir, backupName);
    if (!backupName || !existsSync(backupPath)) return { success: false, error: '备份文件不存在' };
    try {
      const data = JSON.parse(readFileSync(backupPath, 'utf-8')) as BackupFile;
      const restoreMap: Array<[unknown, string]> = [
        [data.config, 'config.json'],
        [data.sessions, 'sessions.json'],
        [data.memory, 'memory.json'],
        [data.agents, 'custom-agents.json'],
        [data.permissions, 'permissions.json'],
        // 备份中 cronJobs 是纯 jobs 映射；cron.service 读取 { jobs } 包装格式，
        // 恢复时必须包一层 jobs，否则恢复后 cron 任务全部丢失
        [data.cronJobs ? { jobs: data.cronJobs } : undefined, 'cron.json'],
        [data.subAgents, 'subagents.json'],
        [data.mcp, 'mcp.json'],
        [data.bindings, 'bindings.json'],
        [data.toolPolicies, 'tool-policies.json'],
        [data.plugins, 'plugins.json'],
        [data.acp, 'acp.json'],
        [data.sandbox, 'sandbox.json'],
        [data.usage, 'usage.json'],
      ];
      for (const [value, filename] of restoreMap) {
        if (value === null || value === undefined) continue;
        const target = join(this.userDataDir, filename);
        if (!this.security.isPathAllowed(target, 'write')) {
          throw new Error(`恢复未完成：${filename} 被路径安全策略拒绝；可能已恢复部分文件`);
        }
        this.ensureDirOf(target);
        writeFileSync(target, JSON.stringify(value), 'utf-8');
      }
      this.restoreDirFiles('workspaceFiles', data.workspaceFiles, 'workspaces');
      this.restoreDirFiles('memoryFiles', data.memoryFiles, 'memory');
      this.restoreDirFiles('dreamFiles', data.dreamFiles, 'dreams');
      this.logger.info(`backup: 备份已恢复 ${backupName}`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 删除备份 */
  delete(name: string): { success: boolean; error?: string } {
    const backupName = sanitizeBackupName(name);
    const backupPath = join(this.backupDir, backupName);
    if (!backupName || !existsSync(backupPath)) {
      return { success: false, error: '备份不存在' };
    }
    if (!this.security.isPathAllowed(backupPath, 'write')) {
      return { success: false, error: '备份目录不在路径安全策略允许范围' };
    }
    unlinkSync(backupPath);
    this.logger.info(`backup: 备份已删除 ${backupName}`);
    return { success: true };
  }

  /** 确保文件父目录存在 */
  private ensureDirOf(filePath: string): void {
    const dir = resolve(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** 递归收集目录文件（≤100KB，value 为文本内容） */
  private collectDirFiles(dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    if (!existsSync(dir)) return files;
    const walk = (current: string, prefix: string): void => {
      for (const f of readdirSync(current)) {
        const fp = join(current, f);
        const st = statSync(fp);
        if (st.isDirectory()) {
          walk(fp, `${prefix}${f}/`);
        } else {
          // The legacy JSON backup cannot safely embed arbitrary binary/large files.
          // Fail before producing a "successful" incomplete backup; streaming archives are separate work.
          if (st.size >= MAX_FILE_SIZE) throw new Error(`备份未完成：旧版备份格式无法收录 ${prefix}${f}（${st.size} 字节），未生成不完整备份`);
          const bytes = readFileSync(fp);
          if (bytes.includes(0)) throw new Error(`备份未完成：${prefix}${f} 包含二进制内容`);
          files[`${prefix}${f}`] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        }
      }
    };
    walk(dir, '');
    return files;
  }

  /** 平铺收集目录文件 */
  private collectFlatFiles(dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    if (!existsSync(dir)) return files;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) throw new Error(`备份未完成：${name} 包含二进制内容`);
      files[name] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    return files;
  }

  /** 恢复目录文件（路径穿越防护 + isPathAllowed 校验），写入用户数据目录 */
  private restoreDirFiles(label: string, files: Record<string, string> | undefined, subDir: string): void {
    if (!files) return;
    const root = join(this.userDataDir, subDir);
    const rootResolved = resolve(root);
    for (const [relPath, content] of Object.entries(files)) {
      const safeRel = relPath.replace(/\.\./g, '').replace(/[\\/]/g, '/');
      const fp = resolve(root, safeRel);
      if (fp === rootResolved || !fp.startsWith(rootResolved + (process.platform === 'win32' ? '\\' : '/'))) throw new Error(`恢复路径无效：${relPath}`);
      if (!this.security.isPathAllowed(fp, 'write')) {
        throw new Error(`恢复未完成：${label}/${relPath} 被路径安全策略拒绝；可能已恢复部分文件`);
      }
      mkdirSync(resolve(fp, '..'), { recursive: true });
      writeFileSync(fp, content, 'utf-8');
    }
  }

  /** 清理旧备份（保留最近 KEEP_COUNT 份） */
  private cleanupOld(): void {
    if (!existsSync(this.backupDir)) return;
    const files = readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, time: statSync(join(this.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (let i = KEEP_COUNT; i < files.length; i++) {
      try {
        unlinkSync(join(this.backupDir, files[i]!.name));
      } catch {
        // 清理失败可忽略
      }
    }
  }
}
