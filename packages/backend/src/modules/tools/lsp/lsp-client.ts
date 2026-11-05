import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** LSP stdio transport. No shell, repository plugins or unsolicited workspace edits. */
export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }
  >();
  readonly diagnostics = new Map<string, any[]>();
  capabilities: Record<string, any> = {};
  alive = true;
  private stderr = '';
  constructor(
    command: string,
    args: string[],
    readonly rootUri: string,
    cwd: string,
  ) {
    this.child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: 'pipe' });
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(error as Error);
        this.child.kill();
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) =>
      this.fail(new Error(`Language server exited (${code}): ${this.stderr}`)),
    );
    this.child.stdin.on('error', (error) => this.fail(error));
  }
  private send(message: unknown): void {
    if (!this.alive) throw new Error('Language server is not running');
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }));
    this.child.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
    );
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('Language request cancelled'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => {
        try {
          if (this.alive) this.notify('$/cancelRequest', { id });
        } catch {
          /* process may exit during cancellation */
        }
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.cleanup();
          reject(new Error(`Language request cancelled: ${method}`));
        }
      };
      // Transport timeout is independent of AI task budgets; a stuck server can be restarted.
      const timer = setTimeout(abort, 60_000);
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: 'Wing workspace' }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            diagnostic: {},
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
          },
        },
      },
      signal,
    );
    this.capabilities = result?.capabilities ?? {};
    if (this.capabilities['positionEncoding'] && this.capabilities['positionEncoding'] !== 'utf-16')
      throw new Error('Language server must support UTF-16 positions');
    this.notify('initialized', {});
  }
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1],
      );
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid LSP frame');
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method) {
        if (message.method === 'textDocument/publishDiagnostics')
          this.diagnostics.set(message.params.uri, message.params.diagnostics ?? []);
        if (message.id !== undefined) {
          if (message.method === 'workspace/configuration')
            this.send({ id: message.id, result: (message.params.items ?? []).map(() => null) });
          else if (message.method === 'workspace/workspaceFolders')
            this.send({ id: message.id, result: [{ uri: this.rootUri, name: 'Wing workspace' }] });
          else if (message.method === 'window/workDoneProgress/create')
            this.send({ id: message.id, result: null });
          else
            this.send({
              id: message.id,
              error: { code: -32601, message: 'Unsupported server request' },
            });
        }
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    }
  }
  private fail(error: Error): void {
    this.alive = false;
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    this.pending.clear();
  }
  async close(): Promise<void> {
    if (!this.alive) {
      this.child.kill('SIGKILL');
      await this.closed;
      return;
    }
    try {
      await this.request('shutdown', null, AbortSignal.timeout(1000));
      this.notify('exit', null);
    } catch {
      /* terminate an unresponsive language server */
    } finally {
      this.child.kill('SIGKILL');
      this.fail(new Error('Language server stopped'));
      await this.closed;
    }
  }
}
