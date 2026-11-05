import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { LoggerService } from '../logger/logger.service.js';
import { SecurityManagerService } from '../security/security-manager.service.js';
import { resolveWebDataDir } from '../utils/web-data.util.js';

/**
 * WorkspaceService - 工作区文件系统
 *
 * 移植自 start.cjs /workspace 路由：
 *   - 列出 packages/web/workspace 下的 SOUL.md / AGENTS.md / IDENTITY.md / USER.md / MEMORY.md
 *   - 附带 skills 目录清单（含 SKILL.md 的子目录）
 *   - 写入受路径穿越防护 + isPathAllowed 校验 + 100KB 大小限制
 */

/** 工作区关注的规则文件 */
const WORKSPACE_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md'] as const;
/** 内容上限（100KB，对齐旧版） */
const MAX_CONTENT_SIZE = 100_000;

/** 工作区根目录解析 */
function resolveWorkspaceDir(): string {
  const dataDir = resolveWebDataDir();
  const candidates = [
    join(dataDir, '..', 'workspace'),
    join(process.cwd(), 'packages', 'web', 'workspace'),
    join(process.cwd(), 'workspace'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return resolve(candidates[0]!);
}

/** 技能目录解析 */
function resolveSkillsDir(): string {
  const dataDir = resolveWebDataDir();
  const candidates = [
    join(dataDir, '..', 'skills'),
    join(process.cwd(), 'packages', 'web', 'skills'),
    join(process.cwd(), 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return resolve(candidates[0]!);
}

@Injectable()
export class WorkspaceService {
  private readonly workspaceDir = resolveWorkspaceDir();
  private readonly skillsDir = resolveSkillsDir();

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  /** 工作区文件列表 + 技能清单 */
  listFiles(): { files: Record<string, string>; skills: string[] } {
    const files: Record<string, string> = {};
    for (const name of WORKSPACE_FILES) {
      try {
        const content = readFileSync(join(this.workspaceDir, name), 'utf-8').trim();
        if (content) files[name] = content;
      } catch {
        // 文件不存在则跳过
      }
    }
    const memoryPath = join(this.workspaceDir, 'MEMORY.md');
    try {
      const content = readFileSync(memoryPath, 'utf-8').trim();
      if (content) files['MEMORY.md'] = content;
    } catch {
      // MEMORY.md 可选
    }
    return { files, skills: this.listSkills() };
  }

  /** 写入工作区文件（路径穿越防护 + 大小限制） */
  writeFile(file: string, content: string): { success: true } | { success: false; error: string } {
    if (!file || !content) return { success: false, error: '缺少file或content参数' };
    if (content.length > MAX_CONTENT_SIZE) return { success: false, error: '内容过大，最大100KB' };
    const root = resolve(this.workspaceDir);
    const filePath = resolve(root, file);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return { success: false, error: '路径不允许超出workspace目录' };
    }
    if (!this.security.isPathAllowed(filePath, 'write')) {
      return { success: false, error: '路径安全策略拒绝写入' };
    }
    try {
      writeFileSync(filePath, content, 'utf-8');
      this.logger.info(`workspace: 已写入 ${file}`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 技能清单（含 SKILL.md 的目录名） */
  private listSkills(): string[] {
    if (!existsSync(this.skillsDir)) return [];
    try {
      return readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(this.skillsDir, d.name, 'SKILL.md')))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }
}
