import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { loadJsonFile, resolveWebDataDir, saveJsonFile } from '../../core/utils/web-data.util.js';
import type { UpdateSandboxEnhancedDto } from './dto/sandbox.dto.js';

const execFileAsync = promisify(execFile);

/**
 * SandboxEnhancedService - 增强沙箱（持久容器）
 *
 * 移植自 start.cjs SandboxEnhanced：
 *   - 配置持久化 packages/web/data/sandbox.json（mode/backend/scope/workspaceAccess）
 *   - 按会话创建常驻容器（docker run -d ... tail -f /dev/null）
 *   - 容器内执行 / 销毁（execFile 数组参数，镜像与工作目录白名单正则校验）
 *   - 执行前经 SecurityManager.isCommandAllowed 校验
 */

/** 增强沙箱配置 */
export interface SandboxEnhancedConfig {
  mode: 'off' | 'non-main' | 'all';
  backend: 'docker' | 'ssh';
  scope: 'session' | 'global';
  workspaceAccess: 'none' | 'ro' | 'rw';
  docker?: { image?: string; workdir?: string; workspaceRoot?: string };
  ssh?: { host?: string; port?: number; username?: string };
}

/** 容器记录 */
interface ContainerRecord {
  name: string;
  id: string;
  createdAt: number;
  backend: 'docker';
}

/** 容器名 / 镜像 / 工作目录合法字符 */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE_RE = /^[a-zA-Z0-9._/:-]+$/;
const WORKDIR_RE = /^[a-zA-Z0-9._/-]+$/;

@Injectable()
export class SandboxEnhancedService implements OnModuleInit {
  private readonly configPath = join(resolveWebDataDir(), 'sandbox.json');
  private config: SandboxEnhancedConfig = {
    mode: 'off',
    backend: 'docker',
    scope: 'session',
    workspaceAccess: 'none',
  };
  private containers: Record<string, ContainerRecord> = {};

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  onModuleInit(): void {
    const raw = loadJsonFile<Partial<SandboxEnhancedConfig>>(this.configPath, {});
    if (raw && raw.mode) this.config = { ...this.config, ...raw };
    this.logger.info(
      `sandbox-enhanced: 已初始化 mode=${this.config.mode}, backend=${this.config.backend}`,
    );
  }

  /** 读取配置 */
  getConfig(): SandboxEnhancedConfig {
    return { ...this.config };
  }

  /** 更新配置（镜像 / 工作目录正则校验防注入） */
  updateConfig(dto: UpdateSandboxEnhancedDto): SandboxEnhancedConfig {
    if (dto.docker?.image && !IMAGE_RE.test(dto.docker.image)) {
      throw new Error(`Invalid docker image name: ${dto.docker.image}`);
    }
    if (dto.docker?.workdir && !WORKDIR_RE.test(dto.docker.workdir)) {
      throw new Error(`Invalid workdir: ${dto.docker.workdir}`);
    }
    this.config = { ...this.config, ...dto } as SandboxEnhancedConfig;
    if (!this.security.isPathAllowed(this.configPath, 'write')) {
      this.logger.warn('sandbox-enhanced: 配置写入被路径安全策略拒绝');
    } else {
      saveJsonFile(this.configPath, this.config);
    }
    this.logger.info(`sandbox-enhanced: 配置已更新 mode=${this.config.mode}`);
    return this.getConfig();
  }

  /** 后端可用性（docker --version / ssh -V） */
  async isBackendReady(): Promise<boolean> {
    try {
      if (this.config.backend === 'docker') {
        await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
          timeout: 3000,
          windowsHide: true,
        });
        return true;
      }
      await execFileAsync('ssh', ['-V'], { timeout: 3000 });
      return true;
    } catch {
      return !!(this.config.backend === 'ssh' && this.config.ssh?.host);
    }
  }

  /** 增强沙箱是否可用 */
  async isAvailable(): Promise<boolean> {
    if (this.config.mode === 'off') return false;
    return this.isBackendReady();
  }

  /** 创建容器（已存在则复用） */
  async createContainer(
    sessionKey: string,
  ): Promise<{
    ok: boolean;
    containerName?: string;
    containerId?: string;
    existing?: boolean;
    error?: string;
  }> {
    if (this.config.mode === 'off') {
      return { ok: false, error: '增强沙箱未启用，请在配置中将模式设为 non-main 或 all' };
    }
    if (!(await this.isBackendReady())) {
      return {
        ok: false,
        error:
          this.config.backend === 'docker'
            ? '后端不可用: Docker 未安装或未启动，请先安装 Docker Desktop'
            : '后端不可用: SSH 不可用，请检查 SSH 配置',
      };
    }
    const safeKey = createHash('sha256')
      .update(sessionKey || 'default')
      .digest('hex')
      .slice(0, 32);
    const containerName = `sky-sandbox-${safeKey}`;
    if (!CONTAINER_NAME_RE.test(containerName)) {
      return { ok: false, error: `Invalid container name: ${containerName}` };
    }
    if (this.containers[containerName]) {
      return { ok: true, containerName, existing: true };
    }
    if (this.config.backend !== 'docker') {
      return { ok: false, error: `Unsupported backend: ${this.config.backend}` };
    }
    const image = this.config.docker?.image || 'ubuntu:22.04';
    if (!IMAGE_RE.test(image)) return { ok: false, error: `Invalid docker image name: ${image}` };
    const workdir = this.config.docker?.workdir || '/workspace';
    if (!WORKDIR_RE.test(workdir)) return { ok: false, error: `Invalid workdir: ${workdir}` };

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '-w',
      workdir,
    ];
    if (this.config.workspaceAccess !== 'none') {
      const wsDir =
        this.config.docker?.workspaceRoot || join(resolveWebDataDir(), '..', 'workspace');
      const access = this.config.workspaceAccess === 'rw' ? 'rw' : 'ro';
      if (!this.security.isPathAllowed(realpathSync(wsDir), access === 'rw' ? 'write' : 'read')) {
        return { ok: false, error: '工作区目录不在路径安全策略允许范围' };
      }
      args.push('-v', `${wsDir}:${workdir}:${access}`);
    }
    args.push(image, 'tail', '-f', '/dev/null');
    try {
      const { stdout } = await execFileAsync('docker', args, { timeout: 30_000 });
      const containerId = stdout.trim();
      this.containers[containerName] = {
        name: containerName,
        id: containerId,
        createdAt: Date.now(),
        backend: 'docker',
      };
      this.logger.info(`sandbox-enhanced: 容器已创建 ${containerName}`);
      return { ok: true, containerName, containerId };
    } catch (e) {
      return {
        ok: false,
        error: `Container creation failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** 容器内执行命令（先经 isCommandAllowed 校验） */
  async execInContainer(
    containerName: string,
    command: string,
  ): Promise<{ ok: boolean; output?: string; error?: string; exitCode?: number }> {
    if (!this.containers[containerName]) {
      return { ok: false, error: `Container not found: ${containerName}` };
    }
    if (!CONTAINER_NAME_RE.test(containerName)) {
      return { ok: false, error: `Invalid container name: ${containerName}` };
    }
    if (!this.security.isCommandAllowed(command)) {
      return { ok: false, error: 'Command rejected by security manager' };
    }
    if (this.config.backend !== 'docker') {
      return { ok: false, error: 'Unsupported backend' };
    }
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', containerName, 'sh', '-c', command],
        {
          timeout: 60_000,
          encoding: 'utf8',
        },
      );
      return { ok: true, output: stdout };
    } catch (e) {
      const err = e as { message: string; code?: number };
      const fail: { ok: boolean; error: string; exitCode?: number } = {
        ok: false,
        error: err.message,
      };
      if (err.code !== undefined) fail.exitCode = err.code;
      return fail;
    }
  }

  /** 销毁容器 */
  async destroyContainer(containerName: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.containers[containerName]) {
      return { ok: false, error: 'Container not found' };
    }
    if (this.config.backend === 'docker' && CONTAINER_NAME_RE.test(containerName)) {
      try {
        await execFileAsync('docker', ['stop', containerName], { timeout: 30_000 });
      } catch {
        // 容器可能已停止
      }
      try {
        await execFileAsync('docker', ['rm', containerName], { timeout: 30_000 });
      } catch {
        // 容器可能已移除
      }
    }
    delete this.containers[containerName];
    return { ok: true };
  }

  /** 容器列表 */
  listContainers(): Array<ContainerRecord & { key: string }> {
    return Object.entries(this.containers).map(([key, c]) => ({ key, ...c }));
  }
}
