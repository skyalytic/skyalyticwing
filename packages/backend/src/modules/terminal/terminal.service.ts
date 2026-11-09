import { updateMaintenance } from '../core/system/update-maintenance.js';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn as spawnPty, type IPty } from 'node-pty';
import {
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import { watchProjectChanges } from '../tools/files/project-history-watch.js';

/** 终端会话内部结构 */
interface TerminalSession {
  id: string;
  cwd: string;
  proc: IPty | null;
  /** 累计输出缓冲（含历史），按追加序号供增量拉取 */
  outputPath: string;
  outputLength: number;
  outputError?: string;

  exited: boolean;
  createdAt: number;
  tracking?: ReturnType<typeof watchProjectChanges>;
  exitReady?: Promise<void>;
  guard?: () => void;
}

/** 输出返回上限（单次拉取，字节） */
const MAX_CHUNK = 256 * 1024;

/**
 * TerminalService - 工作区"终端"tab 的持久 Shell 会话
 *
 * 每个 tab 一个真实 PowerShell 进程（cwd/环境/历史跨命令持久），
 * stdin 写入命令、stdout/stderr 汇入缓冲，前端增量轮询渲染。
 * ConPTY / PTY 提供原生终端输入、ANSI 输出、全屏程序与尺寸同步。
 * 这是用户本人的本地终端（等同系统终端），不做命令黑名单拦截；
 * 启动目录须通过 SecurityManager 路径白名单校验。
 *
 * 关闭标签结束进程；切换标签保留会话。
 */
@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger('TerminalService');
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly security: SecurityManagerService) {
    updateMaintenance.register(
      '请先结束终端命令并关闭终端标签',
      () => [...this.sessions.values()].filter((s) => !s.exited).length + this.closing.size,
    );
  }

  status(): { sessions: number } {
    return { sessions: this.sessions.size };
  }

  /** 打开终端会话（cwd 须在白名单内；缺省用户主目录） */
  open(
    cwd?: string,
    cols = 100,
    rows = 30,
    remote?: { file: string; args: string[]; cwd: string; guard: () => void },
  ): { id: string; cwd: string; shell: string } {
    if (updateMaintenance.pending) throw Error('正在准备更新，暂时不能打开终端');
    const dir = remote ? getDefaultDataDir() : cwd ? resolve(cwd) : homedir();
    if (remote) {
      remote.guard();
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`目录不存在: ${dir}`);
    if (!remote && !this.security.isPathAllowed(dir)) throw new Error(`目录不在允许范围内: ${dir}`);
    const id = randomUUID();
    const outputDirectory = resolve(dir, '.wing-terminal');
    mkdirSync(outputDirectory, { recursive: true });
    if (lstatSync(outputDirectory).isSymbolicLink()) throw new Error('终端日志目录不能是链接');
    const outputPath = resolve(outputDirectory, id + '.utf16.log');
    writeFileSync(outputPath, '', { mode: 0o600, flag: 'wx' });
    const tracking =
      cwd && !remote
        ? watchProjectChanges(dir, (path) => this.security.isPathAllowed(path))
        : { close() {}, warning: '' };
    // -NoLogo -NoProfile：无横幅干净启动；UTF8 统一输出编码（中文不乱码）
    const shell = remote ? { executable: remote.file, args: remote.args } : terminalShell();
    let proc: IPty;
    try {
      proc = spawnPty(shell.executable, shell.args, {
        cwd: dir,
        name: 'xterm-256color',
        cols: this.dimension(cols, 100),
        rows: this.dimension(rows, 30),
        env: terminalEnvironment(),
      });
    } catch (e) {
      tracking.close();
      throw e;
    }
    const session: TerminalSession = {
      id,
      cwd: dir,
      ...(remote ? { guard: remote.guard } : {}),
      proc,
      outputPath,
      outputLength: 0,
      exited: false,
      createdAt: Date.now(),
      tracking,
    };
    proc.onData((chunk) => this.append(session, chunk));
    let markExited!: () => void;
    session.exitReady = new Promise<void>((done) => {
      markExited = done;
    });
    proc.onExit(({ exitCode }) => {
      this.append(session, '\r\n[进程已退出 code=' + exitCode + ']\r\n');
      session.exited = true;
      tracking.close();
      disposeWindowsPtyOutput(proc);
      markExited();
    });
    this.sessions.set(id, session);
    this.logger.log(`终端会话已打开 id=${id} cwd=${dir}`);
    return { id, cwd: remote?.cwd || dir, shell: shell.executable };
  }

  private append(session: TerminalSession, chunk: string): void {
    try {
      appendFileSync(session.outputPath, chunk, 'utf16le');
      session.outputLength += chunk.length;
    } catch (error) {
      session.outputError = '终端输出保存失败：' + String(error);
    }
  }

  /** 向终端写入一行命令（自动回车执行）；支持写入原始按键文本（含 \n 由调用方控制） */
  input(id: string, text: string, raw = false): { ok: boolean } {
    const s = this.mustGet(id);
    if (s.exited || !s.proc) throw new Error('终端进程已退出，请关闭后重新打开');
    if (typeof text !== 'string') throw new Error('终端输入必须是文本');
    s.proc.write(raw ? text : text.replace(/[\r\n]+$/, '') + '\r');
    return { ok: true };
  }

  /** 增量拉取输出：since=上次返回的游标（字符偏移） */
  output(
    id: string,
    since: number,
  ): { seq: number; data: string; exited: boolean; dropped: number; historyWarning: string } {
    const s = this.mustGet(id);
    const cursor = Number.isSafeInteger(since) ? Math.max(0, Math.min(since, s.outputLength)) : 0;
    const length = Math.min(MAX_CHUNK, s.outputLength - cursor);
    const buffer = Buffer.alloc(length * 2);
    const fd = openSync(s.outputPath, 'r');
    let bytes = 0;
    try {
      while (bytes < buffer.length) {
        const n = readSync(fd, buffer, bytes, buffer.length - bytes, cursor * 2 + bytes);
        if (!n) break;
        bytes += n;
      }
    } finally {
      closeSync(fd);
    }
    const data = buffer.subarray(0, bytes).toString('utf16le');
    const seq = cursor + data.length;
    return {
      seq,
      data,
      exited: s.exited && seq >= s.outputLength,
      dropped: 0,
      historyWarning: [s.outputError, s.tracking?.warning].filter(Boolean).join('；'),
    };
  }

  /** 关闭会话并结束进程 */
  close(id: string): { closed: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { closed: false };
    this.sessions.delete(id);
    s.tracking?.close();
    if (!s.exited && s.proc) {
      const cleanup = this.finishClose(s).finally(() => this.closing.delete(cleanup));
      this.closing.add(cleanup);
    }
    return { closed: true };
  }

  private async finishClose(s: TerminalSession): Promise<void> {
    const proc = s.proc!;
    // Answer a pending cursor-position query even if the tab closed before its first render.
    try {
      proc.write('\x1b[1;1R\x03');
    } catch {}
    const exit = setTimeout(() => {
      try {
        if (!s.exited) proc.write('exit\r');
      } catch {}
    }, 100);
    const force = setTimeout(() => {
      if (s.exited) return;
      if (process.platform === 'win32') {
        // node-pty 1.1.0 kill() enumerates a console asynchronously; that console may
        // already have closed. Terminate only this owned shell's tree without that race.
        execFile(
          'taskkill.exe',
          ['/PID', String(proc.pid), '/T', '/F'],
          { windowsHide: true },
          () => {},
        );
      } else {
        try {
          proc.kill();
        } catch {}
      }
    }, 2500);
    let deadline!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        s.exitReady || Promise.resolve(),
        new Promise<void>((done) => {
          deadline = setTimeout(done, 5000);
        }),
      ]);
    } finally {
      clearTimeout(exit);
      clearTimeout(force);
      clearTimeout(deadline);
      disposeWindowsPtyOutput(proc);
    }
  }

  private dimension(value: number, fallback: number) {
    return Number.isFinite(value) ? Math.max(2, Math.min(500, Math.floor(value))) : fallback;
  }
  resize(id: string, cols: number, rows: number) {
    const session = this.mustGet(id);
    if (!session.exited) session.proc?.resize(this.dimension(cols, 100), this.dimension(rows, 30));
    return { resized: !session.exited };
  }
  private mustGet(id: string): TerminalSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error('终端会话不存在或已关闭');
    if (s.guard)
      try {
        s.guard();
      } catch (error) {
        this.close(id);
        throw error;
      }
    return s;
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.close(id);
    await Promise.allSettled(this.closing);
  }
}

/** node-pty is pinned to 1.1.0: its normal ConPTY exit closes pipes but leaves the
 * output Worker alive. Dispose the worker on natural exit too; guard the internal
 * compatibility hook so other platforms/backends keep their ordinary lifecycle. */
function disposeWindowsPtyOutput(proc: IPty): void {
  if (process.platform !== 'win32') return;
  const agent = (proc as IPty & { _agent?: { _conoutSocketWorker?: { dispose(): void } } })._agent;
  try {
    agent?._conoutSocketWorker?.dispose();
  } catch {}
}

export function terminalEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const cliBin = [
    resolve(__dirname, '../../../../web/bin'),
    resolve(__dirname, '../../../../../web/bin'),
  ].find((dir) => existsSync(resolve(dir, 'skyalyticwing.cjs')));
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [dirname(process.execPath), ...(cliBin ? [cliBin] : []), env[pathKey] ?? ''].join(
    delimiter,
  );
  env['SKYALYTICWING_URL'] =
    process.env['SKYALYTICWING_URL'] || `http://127.0.0.1:${process.env['PORT'] || '19111'}`;
  if (process.platform === 'win32') {
    // Windows PowerShell must not load the launching PowerShell Core host's modules.
    // Preserve WindowsPowerShell and custom module paths without changing execution policy.
    for (const name of Object.keys(env))
      if (name.toLowerCase() === 'psmodulepath') {
        env[name] = env[name]!.split(';')
          .filter((p) => !/[\\/]PowerShell[\\/]Modules[\\/]?$/i.test(p))
          .join(';');
      }
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export function terminalShell(platform: NodeJS.Platform = process.platform): {
  executable: string;
  args: string[];
} {
  if (platform === 'win32')
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
    };
  if (platform === 'darwin') return { executable: '/bin/zsh', args: ['-f', '-i'] };
  return { executable: '/bin/sh', args: ['-i'] };
}
