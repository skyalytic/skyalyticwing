import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LoggerService } from '../core/logger/logger.service.js';

/** 平台标识：是否为 Windows */
const IS_WIN = platform() === 'win32';

/** Pi helper 协议版本 */
const PI_PROTOCOL_VERSION = 4;

/** Pi helper 命令默认超时（15s） */
const PI_COMMAND_TIMEOUT_MS = 15000;

/** look 操作选项 */
export interface LookOptions {
  rootRef?: string;
  windowRef?: string;
  windowId?: number;
  includeImage?: boolean;
  maxDimension?: number;
  readText?: 'auto' | 'always' | 'never';
  scopeRef?: string;
  baseLookId?: string;
  timeoutMs?: number;
}

/** act 操作选项 */
export interface ActOptions {
  lookId: string;
  action: string;
  target?: { ref?: string; x?: number; y?: number };
  params?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  timeoutMs?: number;
}

/** readText 操作选项 */
export interface ReadTextOptions {
  lookId: string;
  elementRef: string;
  offset?: number;
  limit?: number;
  timeoutMs?: number;
}

/** waitFor 操作选项 */
export interface WaitForOptions {
  text?: string;
  role?: string;
  value?: string;
  gone?: boolean;
  timeoutMs?: number;
  windowId?: number;
  rootRef?: string;
  pid?: number;
}

/** listRoots 操作选项 */
export interface ListRootsOptions {
  pid?: number;
  timeoutMs?: number;
}

/** pending 请求结构 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * UiaService - Windows UIA（UI Automation）服务
 *
 * 全量移植自 packages/web/desktop-manager.cjs 中的 PiComputerUseClient。
 * 通过 stdin/stdout JSON 行协议与 windows-bridge.exe（Rust helper）通信，
 * 提供 UIA 能力：精确查找 UI 元素、事务性操作、遮挡检测等。
 *
 * 所有操作均添加 IS_WIN 平台守卫：非 Windows 平台返回错误。
 *
 * 协议版本: 4
 */
@Injectable()
export class UiaService implements OnModuleDestroy {
  /** helper 子进程 */
  private child: ChildProcess | null = null;
  /** stdout 缓冲区（按行解析 JSON） */
  private buffer = '';
  /** pending 请求映射（id → resolve/reject/timer） */
  private pending: Map<string, PendingRequest> = new Map();
  /** bridge.exe 路径缓存 */
  private bridgePath: string | null | undefined;
  private generation = 0;

  

  /**
   * 模块销毁时清理 helper 进程
   */
  constructor(_logger: LoggerService) { void _logger; }

  onModuleDestroy(): void {
    this.dispose();
  }

  /** 生成唯一请求 id */
  private genId(): string {
    return randomUUID();
  }

  /** 解析 windows-bridge.exe 路径 */
  private resolveBridgePath(): string | null {
    if (this.bridgePath !== undefined) return this.bridgePath;
    // 候选路径（与 core/utils/web-data.util.ts 同一套布局约定）：
    //   - 开发态：__dirname = <backend>/dist/modules/automation，上溯 4 级到 packages/，
    //     命中 packages/web/binaries/windows-bridge.exe
    //   - 打包态：__dirname = <resources>/_up_/packages/backend/deploy/dist/modules/automation，
    //     上溯 5 级到 _up_/packages/，命中 _up_/packages/web/binaries/windows-bridge.exe
    //     （tauri.conf.json resources 将 ../packages/web/binaries/ 映射到 _up_/packages/web/binaries/）
    //   - cwd 相对：Tauri sidecar 以 _up_/packages/backend 为工作目录启动后端，
    //     ../web/binaries 即 _up_/packages/web/binaries；开发态 cwd=工程根命中 packages/web/binaries
    // 注：不再使用 process.resourcesPath —— 该属性是 Electron 专属 API，
    // 纯 Node.js 运行时下恒为 undefined，原分支为永不生效的死代码。
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'web', 'binaries', 'windows-bridge.exe'),
      join(__dirname, '..', '..', '..', '..', '..', 'web', 'binaries', 'windows-bridge.exe'),
      join(process.cwd(), 'packages', 'web', 'binaries', 'windows-bridge.exe'),
      join(process.cwd(), '..', 'web', 'binaries', 'windows-bridge.exe'),
      join(process.cwd(), 'web', 'binaries', 'windows-bridge.exe'),
      join(process.cwd(), 'binaries', 'windows-bridge.exe'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        this.bridgePath = p;
        return p;
      }
    }
    this.bridgePath = null;
    return null;
  }

  /** 检查 UIA 是否可用（仅 Windows + bridge.exe 存在） */
  isAvailable(): boolean {
    if (!IS_WIN) return false;
    return !!this.resolveBridgePath();
  }

  /** 销毁 helper 进程，清理所有 pending 请求 */
  dispose(): void {
    this.generation++;
    const err = new Error('UiaService disposed');
    for (const [_id, p] of this.pending) {
      try {
        clearTimeout(p.timer);
      } catch {
        // 忽略
      }
      try {
        p.reject(err);
      } catch {
        // 忽略
      }
    }
    this.pending.clear();
    this.buffer = '';
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin?.destroy();
      } catch {
        // 忽略
      }
      try {
        child.stdout?.destroy();
      } catch {
        // 忽略
      }
      try {
        child.stderr?.destroy();
      } catch {
        // 忽略
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略
      }
      try {
        child.unref();
      } catch {
        // 忽略
      }
    }
  }

  /** 处理 stdout 数据：按行解析 JSON 响应，匹配 pending 请求 */
  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: { id?: string; protocolVersion?: number; ok?: boolean; result?: unknown; error?: { message?: string; code?: string } } | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || !parsed.id) continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      this.pending.delete(parsed.id);
      try {
        clearTimeout(pending.timer);
      } catch {
        // 忽略
      }
      if (parsed.protocolVersion !== PI_PROTOCOL_VERSION) {
        pending.reject(
          new Error('Pi helper protocol mismatch: expected ' + PI_PROTOCOL_VERSION + ', got ' + parsed.protocolVersion),
        );
      } else if (parsed.ok === true) {
        pending.resolve(parsed.result);
      } else {
        const errMsg = parsed.error?.message ? parsed.error.message : 'Pi helper command failed';
        const e = new Error(errMsg);
        if (parsed.error?.code) (e as Error & { code?: string }).code = parsed.error.code;
        pending.reject(e);
      }
    }
  }

  /** 获取或懒启动 helper 进程 */
  private getProcess(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      if (this.child && this.child.exitCode === null && !this.child.killed) {
        return resolve(this.child);
      }
      if (!IS_WIN) {
        return reject(new Error('UIA operations are only available on Windows'));
      }
      const bridgePath = this.resolveBridgePath();
      if (!bridgePath) {
        return reject(
          new Error('windows-bridge.exe not found. Please ensure PiComputerUse helper is installed in binaries/ directory.'),
        );
      }
      // 设置子进程创建逻辑，支持 EAGAIN 重试 + error 后 dispose
      const setupChild = (child: ChildProcess): void => {
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdin?.setDefaultEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          this.onStdout(chunk);
        });
        child.on('exit', () => {
          if (this.child === child) this.dispose();
        });
        child.on('error', (err: Error) => {
          // promise 可能已 resolve，reject 是 no-op；
          // 但还需 dispose 以 reject 所有 pending 请求，避免悬挂后重复创建
          try {
            if (this.child === child) this.dispose();
          } catch {
            // 忽略
          }
          reject(err);
        });
        this.child = child;
        this.buffer = '';
        resolve(child);
      };
      try {
        const child = spawn(bridgePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        setupChild(child);
      } catch (err) {
        // spawn EAGAIN（系统进程数/文件描述符限制）时短暂延迟后重试一次
        const e = err as Error & { code?: string };
        if (e.code === 'EAGAIN' || e.code === 'ENOMEM') {
          setTimeout(() => {
            try {
              const child2 = spawn(bridgePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
              setupChild(child2);
            } catch (err2) {
              reject(err2 as Error);
            }
          }, 200);
        } else {
          reject(e);
        }
      }
    });
  }

  /** 发送命令到 helper（底层 API） */
  async command(cmd: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    const finalArgs = args || {};
    const timeoutMs = options?.timeoutMs || PI_COMMAND_TIMEOUT_MS;
    const generation = this.generation;
    const child = await this.getProcess();
    if (generation !== this.generation || child !== this.child || child.killed) throw new Error('Desktop request interrupted before dispatch');
    return new Promise((resolve, reject) => {
      const id = this.genId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时说明 bridge 很可能卡死（UIA 调用挂在无响应的应用上）。
        // 必须杀掉整个 helper 进程：否则后续所有命令都排在卡死命令后面逐个超时，
        // 用户感知就是"永远卡着不动"。杀掉后下一条命令会自动重新 spawn 新进程。
        try {
          this.dispose();
        } catch {
          // 忽略
        }
        reject(
          new Error("Pi helper command '" + cmd + "' timed out after " + timeoutMs + 'ms (bridge killed, will respawn on next command)'),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const payload =
        JSON.stringify({
          protocolVersion: PI_PROTOCOL_VERSION,
          id,
          cmd,
          args: finalArgs,
        }) + '\n';
      child.stdin?.write(payload, (err?: Error | null) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // ============================================================
  // 高级 API
  // ============================================================

  /** 诊断信息：返回协议版本、架构版本、invariants、pid、os、arch */
  async diagnostics(): Promise<unknown> {
    return this.command('diagnostics', {});
  }

  /** 列出所有窗口（roots） */
  async listRoots(opts?: ListRootsOptions): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (opts?.pid !== undefined) args['pid'] = opts.pid;
    return this.command('listRoots', args, opts);
  }

  /** listRoots 别名 */
  async listWindows(opts?: ListRootsOptions): Promise<unknown> {
    return this.listRoots(opts);
  }

  /**
   * 观察 UI：截图 + UIA 元素树
   * opts.rootRef: 窗口引用（来自 listRoots）
   * opts.windowId: 窗口 ID（备选）
   * opts.includeImage: 是否包含截图（默认 true）
   * opts.maxDimension: 截图最大边长（1-16384）
   * opts.readText: 文本读取策略（'auto'|'always'|'never'）
   * opts.scopeRef: 限定子树范围
   * opts.baseLookId: 基础 look id（用于增量）
   */
  async look(opts?: LookOptions): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (opts?.rootRef) args['rootRef'] = opts.rootRef;
    if (opts?.windowRef) args['windowRef'] = opts.windowRef;
    if (opts?.windowId !== undefined) args['windowId'] = opts.windowId;
    if (opts?.includeImage !== undefined) args['includeImage'] = opts.includeImage;
    if (opts?.maxDimension !== undefined) args['maxDimension'] = opts.maxDimension;
    if (opts?.readText) args['readText'] = opts.readText;
    if (opts?.scopeRef) args['scopeRef'] = opts.scopeRef;
    if (opts?.baseLookId) args['baseLookId'] = opts.baseLookId;
    return this.command('look', args, opts);
  }

  /** look 别名 */
  async screenshot(opts?: LookOptions): Promise<unknown> {
    return this.look(opts);
  }

  /** 聚焦窗口（rootRef: 窗口引用，如 '@r1'） */
  async focusWindow(rootRef: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return this.command('focusWindow', { rootRef }, opts);
  }

  /**
   * 执行单一操作（click/type/keypress/scroll/drag/moveMouse 等）
   * opts.lookId: 来自 look 的 lookId
   * opts.action: 'press'|'click'|'moveMouse'|'drag'|'scroll'|'typeText'|'setText'|'keypress'
   * opts.target: 元素引用或坐标
   * opts.params: 操作参数（如 text、key、button、deltaX、deltaY 等）
   * opts.policy: 操作策略
   */
  async act(opts: ActOptions): Promise<unknown> {
    const args: Record<string, unknown> = {
      lookId: opts.lookId,
      action: opts.action,
      target: opts.target || {},
      params: opts.params || {},
    };
    if (opts.policy) args['policy'] = opts.policy;
    return this.command('act', args, opts);
  }

  /** 批量事务操作：失败即停（stoppedAt 标记停止位置） */
  async actBatch(actions: Array<{ lookId: string; action: string; target?: unknown; params?: unknown }>, opts?: { timeoutMs?: number }): Promise<unknown> {
    return this.command('actBatch', { actions }, opts);
  }

  /**
   * 读取元素文本（支持滚动文本框）
   * opts.lookId: look 返回的 lookId
   * opts.elementRef: 元素引用
   * opts.offset: 偏移量
   * opts.limit: 限制条数
   */
  async readText(opts: ReadTextOptions): Promise<unknown> {
    const args: Record<string, unknown> = {
      lookId: opts.lookId,
      elementRef: opts.elementRef,
    };
    if (opts.offset !== undefined) args['offset'] = opts.offset;
    if (opts.limit !== undefined) args['limit'] = opts.limit;
    return this.command('uiaReadText', args, opts);
  }

  /**
   * 等待元素出现/消失（轮询检查 UIA 树）
   * opts.text: 元素文本
   * opts.role: 元素角色（如 'Button'、'Edit'）
   * opts.value: 元素值
   * opts.gone: true=等待消失，false/undefined=等待出现
   * opts.timeoutMs: 等待超时（helper 端）
   * opts.windowId: 限定窗口
   * opts.rootRef: 限定根
   * opts.pid: 限定进程
   */
  async waitFor(opts: WaitForOptions): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (opts.text) args['text'] = opts.text;
    if (opts.role) args['role'] = opts.role;
    if (opts.value) args['value'] = opts.value;
    if (opts.gone !== undefined) args['gone'] = opts.gone;
    if (opts.timeoutMs !== undefined) args['timeoutMs'] = opts.timeoutMs;
    if (opts.windowId !== undefined) args['windowId'] = opts.windowId;
    if (opts.rootRef) args['rootRef'] = opts.rootRef;
    if (opts.pid !== undefined) args['pid'] = opts.pid;
    return this.command('uiaWaitFor', args, opts);
  }

  /** 打开浏览器位置 */
  async openBrowserLocation(appName: string, url: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return this.command('openBrowserLocation', { appName, url }, opts);
  }
}
