import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { remoteWorker } from './remote-worker.js';
import { remoteDocumentWorker } from './remote-document-worker.js';
import { remoteRuntimeShell } from './remote-runtime.js';
import { downloadRemoteAsset } from './remote-runtime-assets.js';
export type RemoteTarget = { transport: 'ssh' | 'wsl' | 'docker'; target: string; port?: number };
export type RemoteWorkspace = RemoteTarget & {
  id: string;
  name: string;
  root: string;
  worktree?: {
    sourceId: string;
    token: string;
    baseHead: string;
    checkout: string;
    childSessionId: string;
  };
};
export function validateTarget(value: RemoteTarget): void {
  if (
    !value ||
    !['ssh', 'wsl', 'docker'].includes(value.transport) ||
    typeof value.target !== 'string' ||
    !(
      value.transport === 'docker'
        ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/
        : /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,199}$/
    ).test(value.target)
  )
    throw Error('Invalid remote target');
  if (value.transport !== 'ssh' && value.port !== undefined)
    throw Error('Port is only supported for SSH');
  if (
    value.port !== undefined &&
    (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
  )
    throw Error('Invalid SSH port');
}
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function remoteLaunch(target: RemoteTarget, command: string[], interactive = false) {
  validateTarget(target);
  if (target.transport === 'docker')
    return {
      file: 'docker',
      args: ['exec', interactive ? '-it' : '-i', target.target, ...command],
    };
  if (target.transport === 'wsl')
    return { file: 'wsl.exe', args: ['--distribution', target.target, '--exec', ...command] };
  return {
    file: 'ssh',
    args: [
      interactive ? '-tt' : '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      ...(target.port ? ['-p', String(target.port)] : []),
      '--',
      target.target,
      command.map(shellQuote).join(' '),
    ],
  };
}
type Pending = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
// Deliver the worker through stdin so Windows command-line limits do not grow with its source.
export const REMOTE_BOOTSTRAP =
  "let b=Buffer.alloc(0);function start(c){b=Buffer.concat([b,c]);const i=b.indexOf(10);if(i<0){if(b.length>1048576)process.exit(1);return;}process.stdin.pause();process.stdin.removeListener('data',start);const rest=b.subarray(i+1);if(rest.length)process.stdin.unshift(rest);eval(Buffer.from(b.subarray(0,i).toString(),'base64').toString('utf8'));process.stdin.resume();}process.stdin.on('data',start);";
export class RemoteConnection {
  private process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = '';
  private stderr = '';
  closed = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private readonly startupQueue: string[] = [];
  private readonly relayed = new Set<string>();
  private readonly startupAbort = new AbortController();
  constructor(
    private readonly target: RemoteTarget,
    private readonly factory: typeof spawn = spawn,
  ) {
    this.process = this.start();
  }
  private start(): ChildProcessWithoutNullStreams {
    const code = Buffer.from(
      '(' + remoteWorker.toString() + ')(' + remoteDocumentWorker.toString() + ')',
    ).toString('base64');
    const launch = remoteLaunch(this.target, [
      'sh',
      '-c',
      remoteRuntimeShell(['node', '-e', REMOTE_BOOTSTRAP]),
    ]);
    this.process = this.factory(launch.file, launch.args, {
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.stderr = '';
    this.buffer = '';
    // A failed bootstrap may close stdin while the process still has its diagnostic to deliver.
    this.process.stdin.on('error', (error) => {
      if (this.ready) this.close('Remote input closed: ' + error.message);
    });
    this.process.stdout.on('error', (error) =>
      this.close('Remote output closed: ' + error.message),
    );
    this.process.stderr.on('error', (error) =>
      this.close('Remote error stream closed: ' + error.message),
    );
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 20 * 1024 * 1024) {
        this.close('Remote response exceeded limit');
        return;
      }
      for (let index; (index = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        try {
          const message = JSON.parse(line),
            pending = this.pending.get(message.id);
          if (!pending) continue;
          this.ready = true;
          this.startupQueue.length = 0;
          this.pending.delete(message.id);
          pending.cleanup();
          if (message.error) pending.reject(Error(String(message.error)));
          else pending.resolve(message.result);
          this.armIdle();
        } catch {
          this.close('Invalid remote worker response');
          return;
        }
      }
    });
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.process.on('error', (error) => this.close('Remote connection failed: ' + error.message));
    this.process.on('close', () => {
      const marker =
        !this.ready && this.stderr.match(/WING_RUNTIME_DOWNLOAD_FAILED:(node|rg):([a-zA-Z0-9_-]+)/);
      if (!this.closed && marker && !this.relayed.has(marker[0])) {
        this.relayed.add(marker[0]);
        void this.relayAsset(marker[1] as 'node' | 'rg', marker[2]!).catch((error) =>
          this.close('Remote runtime preparation failed: ' + error.message),
        );
      } else this.close('Remote connection closed: ' + this.stderr);
    });
    this.process.stdin.write(code + '\n');
    for (const line of this.startupQueue) this.process.stdin.write(line);
    return this.process;
  }
  private async relayAsset(kind: 'node' | 'rg', target: string) {
    const bytes = await downloadRemoteAsset(kind, target, this.startupAbort.signal);
    if (this.closed) return;
    const launch = remoteLaunch(this.target, [
      'sh',
      '-c',
      remoteRuntimeShell(['true'], { kind, target }),
    ]);
    const child = this.factory(launch.file, launch.args, {
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.process = child;
    await new Promise<void>((resolve, reject) => {
      let diagnostic = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Runtime upload timed out'));
      }, 180000);
      child.stdout.resume();
      child.stderr.on('data', (c) => {
        diagnostic = (diagnostic + c.toString()).slice(-2000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error(diagnostic || 'Runtime upload failed'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    });
    if (!this.closed) this.start();
  }
  private armIdle() {
    clearTimeout(this.idle);
    if (!this.pending.size)
      this.idle = setTimeout(() => this.close('Remote connection idle'), 120000);
    this.idle?.unref();
  }
  request(
    root: string,
    op: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(Error('Remote connection is closed; reconnect explicitly'));
    if (signal?.aborted) return Promise.reject(Error('Request cancelled'));
    if (this.pending.size >= 32) return Promise.reject(Error('Remote queue full'));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () =>
        this.close('Remote request cancelled; result may be uncertain, inspect before retry');
      const requested = args['timeout'];
      const normalTimeout =
        op === 'exec'
          ? Number.isSafeInteger(requested) && Number(requested) > 0
            ? Math.min(2147478647, Number(requested)) + 5000
            : 0
          : op.startsWith('worktree-')
            ? 180000
            : 45000;
      const timeout = !this.ready ? Math.max(normalTimeout, 360000) : normalTimeout;
      const timer = timeout
        ? setTimeout(
            () =>
              this.close('Remote request timed out; result may be uncertain, inspect before retry'),
            timeout,
          )
        : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      const line = JSON.stringify({ id, root, op, args }) + '\n';
      if (!this.ready) this.startupQueue.push(line);
      this.process.stdin.write(line, (error) => {
        if (error && this.ready) this.close(error.message);
      });
    });
  }
  close(reason = 'Remote connection closed') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.startupAbort.abort();
    this.startupQueue.length = 0;
    const child = this.process;
    child.stdin.end();
    // Give the remote worker a brief EOF cleanup window before terminating its transport.
    const terminate = setTimeout(() => child.kill(), 250);
    terminate.unref();
    child.once('close', () => clearTimeout(terminate));
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(Error(reason));
    }
    this.pending.clear();
  }
}
