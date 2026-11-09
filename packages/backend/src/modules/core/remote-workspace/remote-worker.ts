/** Serialized into the remote Node process; keep all runtime dependencies inside this function. */
export function remoteWorker(
  documentFactory?: typeof import('./remote-document-worker.js').remoteDocumentWorker,
): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const cp = require('node:child_process') as typeof import('node:child_process');
  const readline = require('node:readline') as typeof import('node:readline');
  const limit = 2 * 1024 * 1024;
  const jobs = new Set<import('node:child_process').ChildProcess>();
  const hash = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
  const kill = (child: import('node:child_process').ChildProcess) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill();
    } catch {}
  };
  const stop = () => {
    documents?.close();
    for (const job of jobs) kill(job);
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  function within(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  }
  function target(root: string, value: unknown): string {
    if (typeof value !== 'string' || value.includes('\0')) throw Error('Invalid remote path');
    const resolved = path.resolve(root, value);
    if (!within(root, resolved)) throw Error('Path escapes remote workspace');
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) {
      // A dangling link must not turn a write into an out-of-workspace traversal.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw Error('Dangling link');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw Error('Missing remote root');
      ancestor = parent;
    }
    if (!within(root, fs.realpathSync.native(ancestor)))
      throw Error('Link escapes remote workspace');
    return resolved;
  }
  const documents = documentFactory?.(target);
  function read(file: string) {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > limit)
      throw Error('Remote file exceeds text limit (2 MiB)');
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) throw Error('Binary file cannot be edited as text');
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      revision: hash(bytes),
    };
  }
  function write(root: string, file: string, content: unknown, expected: unknown) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > limit)
      throw Error('Invalid remote text');
    const current = fs.existsSync(file) ? read(file).revision : null;
    if (expected !== undefined && expected !== current)
      throw Error('File changed; reload before saving');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    target(root, file);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw Error('Cannot replace a symbolic link');
    const temp = path.join(path.dirname(file), '.wing-write-' + crypto.randomUUID());
    try {
      fs.writeFileSync(temp, content, {
        flag: 'wx',
        mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o600,
      });
      if ((fs.existsSync(file) ? read(file).revision : null) !== current)
        throw Error('File changed during save');
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return { path: file, revision: hash(content) };
  }
  function command(
    file: string,
    args: string[],
    cwd: string,
    timeout = 120000,
    logPath?: string,
    literalGit = true,
  ): Promise<any> {
    // A selected filename must never become a Git wildcard or pathspec expression.
    if (file === 'git' && literalGit) args = ['--literal-pathspecs', ...args];
    return new Promise((resolve, reject) => {
      let log = logPath ? fs.openSync(logPath, 'wx', 0o600) : undefined;
      let logError: Error | undefined;
      const closeLog = () => {
        if (log !== undefined) {
          try {
            fs.closeSync(log);
          } catch {
          } finally {
            log = undefined;
          }
        }
      };
      const child = cp.spawn(file, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      jobs.add(child);
      let stdout = '',
        stderr = '',
        truncated = false,
        timedOut = false;
      const append = (chunk: Buffer, error: boolean) => {
        if (log !== undefined) {
          try {
            fs.writeSync(log, chunk);
          } catch (e) {
            logError = e as Error;
            closeLog();
            kill(child);
          }
        }
        const s = chunk.toString('utf8');
        if (error) {
          if (s.length > limit - stderr.length) truncated = true;
          stderr += s.slice(0, Math.max(0, limit - stderr.length));
        } else {
          if (s.length > limit - stdout.length) truncated = true;
          stdout += s.slice(0, Math.max(0, limit - stdout.length));
        }
      };
      child.stdout!.on('data', (c) => append(c, false));
      child.stderr!.on('data', (c) => append(c, true));
      const timer =
        timeout > 0
          ? setTimeout(
              () => {
                timedOut = true;
                kill(child);
              },
              Math.min(2147483647, timeout),
            )
          : undefined;
      child.once('error', (e) => {
        clearTimeout(timer);
        jobs.delete(child);
        closeLog();
        reject(e);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        jobs.delete(child);
        closeLog();
        if (logError) {
          reject(logError);
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code,
          truncated,
          timedOut,
          ...(logPath ? { logPath } : {}),
        });
      });
    });
  }
  async function git(args: string[], cwd: string, timeout = 120000): Promise<string> {
    const result = await command('git', args, cwd, timeout);
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw Error(result.stderr || 'Git operation failed or exceeded output limit');
    return result.stdout;
  }
  async function worktreeInfo(root: string, token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw Error('Invalid worktree token');
    const repository = fs.realpathSync.native(
      (await git(['rev-parse', '--show-toplevel'], root)).trim(),
    );
    const common = fs.realpathSync.native(
      (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim(),
    );
    const base = path.join(common, 'wing-task-worktrees');
    if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink())
      throw Error('Invalid worktree storage');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const checkout = path.join(base, token),
      marker = path.join(base, token + '.json');
    const prefix = path.relative(repository, root);
    if (!within(repository, root)) throw Error('Workspace is outside repository');
    return { repository, base, checkout, marker, prefix, root: path.join(checkout, prefix), token };
  }
  async function worktree(root: string, op: string, a: any) {
    const info = await worktreeInfo(root, a.token);
    if (op === 'worktree-create') {
      if (fs.existsSync(info.marker)) {
        const existing = JSON.parse(fs.readFileSync(info.marker, 'utf8'));
        if (
          existing.source !== root ||
          existing.checkout !== info.checkout ||
          !fs.existsSync(path.join(info.checkout, '.git'))
        )
          throw Error('Worktree recovery requires inspection');
        return existing;
      }
      if (fs.existsSync(info.checkout))
        throw Error('Unfinished worktree exists; inspect ' + info.checkout);
      const baseHead = (await git(['rev-parse', '--verify', 'HEAD'], root)).trim();
      const seed = path.join(info.base, a.token + '.patch'),
        check = seed + '.check';
      // The patch captures staged and unstaged tracked edits without touching the user's index.
      const snapshot = async (file: string) =>
        git(
          [
            'diff',
            '--binary',
            '--no-ext-diff',
            '--no-textconv',
            '--output=' + file,
            'HEAD',
            '--',
            '.',
          ],
          root,
        );
      const files = async () =>
        (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], root))
          .split('\0')
          .filter(Boolean)
          .sort();
      const fingerprint = (file: string) => {
        const stat = fs.lstatSync(file);
        if (!stat.isFile())
          throw Error('Untracked links or special files require explicit shared mode');
        const digest = crypto.createHash('sha256'),
          fd = fs.openSync(file, 'r'),
          buffer = Buffer.alloc(65536);
        try {
          for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;)
            digest.update(buffer.subarray(0, size));
        } finally {
          fs.closeSync(fd);
        }
        return digest.digest('hex');
      };
      try {
        await snapshot(seed);
        const before = hash(fs.readFileSync(seed)),
          untracked = await files();
        const revisions = new Map(untracked.map((name) => [name, fingerprint(target(root, name))]));
        await git(['worktree', 'add', '--detach', info.checkout, baseHead], root);
        if (fs.statSync(seed).size)
          await git(['apply', '--binary', '--whitespace=nowarn', seed], info.checkout);
        for (const name of untracked) {
          const source = target(root, name),
            destination = target(info.checkout, path.join(info.root, name));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(destination, fs.statSync(source).mode);
        }
        await snapshot(check);
        if (
          before !== hash(fs.readFileSync(check)) ||
          baseHead !== (await git(['rev-parse', 'HEAD'], root)).trim() ||
          JSON.stringify(untracked) !== JSON.stringify(await files()) ||
          untracked.some((name) => revisions.get(name) !== fingerprint(target(root, name)))
        )
          throw Error('Parent changed during worktree creation; inspect ' + info.checkout);
        const result = {
          root: info.root,
          checkout: info.checkout,
          source: root,
          baseHead,
          token: a.token,
        };
        fs.writeFileSync(info.marker, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
        return result;
      } finally {
        for (const file of [seed, check]) if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
    if (op === 'worktree-remove') {
      if (!fs.existsSync(info.marker)) throw Error('Managed worktree not found');
      const record = JSON.parse(fs.readFileSync(info.marker, 'utf8'));
      if (record.source !== root || record.checkout !== info.checkout)
        throw Error('Worktree ownership mismatch');
      const status = await git(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        info.checkout,
      );
      const head = (await git(['rev-parse', 'HEAD'], info.checkout)).trim();
      if (status || head !== record.baseHead)
        throw Error('Worktree contains changes or commits; review and integrate before removing');
      await git(['worktree', 'remove', info.checkout], root);
      fs.unlinkSync(info.marker);
      return { removed: true };
    }
    throw Error('Unsupported worktree operation');
  }

  async function repositorySnapshot(root: string) {
    const query = (args: string[]) => git(['--no-literal-pathspecs', '--no-pager', ...args], root);
    const head = await query(['rev-parse', '--verify', 'HEAD']).catch(() => '(unborn)');
    const status = await query([
      'status',
      '--short',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude).wing-terminal',
    ]);
    const options = ['--no-ext-diff', '--no-textconv'];
    const diff = await query([
      'diff',
      ...options,
      'HEAD',
      '--',
      '.',
      ':(exclude).wing-terminal',
    ]).catch(() => query(['diff', ...options, '--', '.', ':(exclude).wing-terminal']));
    return { head: head.trim(), status, diff, diffHash: hash(diff) };
  }
  function repositoryCommands(root: string) {
    const found: Array<{ label: string; command: string; args: string[] }> = [];
    const exists = (name: string) => fs.existsSync(target(root, name));
    if (exists('package.json')) {
      const pkg = JSON.parse(read(target(root, 'package.json')).content);
      const manager = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : 'npm';
      for (const name of Object.keys(pkg.scripts ?? {}))
        if (/^(test|build|lint|type-?check|check)(:|$)/.test(name))
          found.push({ label: name, command: manager, args: ['run', name] });
    }
    if (exists('pyproject.toml') || exists('pytest.ini'))
      found.push({ label: 'pytest', command: 'python', args: ['-m', 'pytest'] });
    if (exists('Cargo.toml'))
      found.push(
        { label: 'cargo test', command: 'cargo', args: ['test'] },
        { label: 'cargo check', command: 'cargo', args: ['check'] },
      );
    if (exists('go.mod')) found.push({ label: 'go test', command: 'go', args: ['test', './...'] });
    if (exists('pom.xml')) found.push({ label: 'maven test', command: 'mvn', args: ['test'] });
    return found;
  }
  async function repository(root: string, op: string, a: any) {
    const cwd = fs.realpathSync.native(target(root, a.root ?? '.'));
    if (!fs.statSync(cwd).isDirectory()) throw Error('Repository path must be a directory');
    const before = await repositorySnapshot(cwd);
    if (op === 'repo-inspect') {
      const files = (await git(['ls-files', '-z', '--', '.'], cwd)).split('\0').filter(Boolean);
      return { root: cwd, ...before, files, commands: repositoryCommands(cwd) };
    }
    if (
      typeof a.command !== 'string' ||
      !a.command.trim() ||
      a.command.includes('\0') ||
      !Array.isArray(a.args) ||
      !a.args.every((v: unknown) => typeof v === 'string' && !v.includes('\0'))
    )
      throw Error('command and string args required');
    if (a.timeout !== undefined && (!Number.isSafeInteger(a.timeout) || a.timeout <= 0))
      throw Error('Positive timeout required');
    const folder = target(root, path.join(cwd, '.wing-terminal'));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const logPath = target(root, path.join(folder, crypto.randomUUID() + '.log'));
    const startedAt = Date.now();
    const result = await command(a.command, a.args, cwd, a.timeout ?? 120000, logPath, false);
    const after = await repositorySnapshot(cwd).catch((e: any) => ({
      error: String(e.message || e),
    }));
    return {
      ...result,
      root: cwd,
      command: a.command,
      args: a.args,
      startedAt,
      durationMs: Date.now() - startedAt,
      before,
      after,
    };
  }

  async function run(request: any) {
    if (!request || typeof request.root !== 'string' || !path.isAbsolute(request.root))
      throw Error('Absolute remote root required');
    const root = fs.realpathSync.native(request.root);
    if (!fs.statSync(root).isDirectory()) throw Error('Remote root is not a directory');
    const a = request.args || {},
      op = request.op;
    if (op === 'hello') return { root, platform: process.platform, node: process.versions.node };
    if (op === 'repo-inspect' || op === 'repo-verify') return repository(root, op, a);
    if (op === 'worktree-create' || op === 'worktree-remove') return worktree(root, op, a);
    if (typeof op === 'string' && op.startsWith('binary-')) {
      if (!documents) throw Error('Document transport unavailable');
      return documents.run(root, op, a);
    }
    const file = target(root, a.path ?? '.');
    if (op === 'list') {
      const entries = fs
        .readdirSync(file, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      const offset = Math.max(0, Number(a.offset) || 0);
      return {
        path: file,
        entries: entries
          .slice(offset, offset + 1000)
          .map((e) => ({
            name: e.name,
            path: path.join(file, e.name),
            directory: e.isDirectory(),
            symlink: e.isSymbolicLink(),
          })),
        nextOffset: offset + 1000 < entries.length ? offset + 1000 : null,
      };
    }
    if (op === 'read') {
      const value = read(file);
      if (a.byteOffset !== undefined)
        throw Error('Remote text files use offset/limit line pagination, not byteOffset');
      const lines = value.content.split('\n'),
        start = Number.isInteger(a.offset) ? Math.max(0, a.offset - 1) : 0;
      if (a.offset !== undefined || a.limit !== undefined)
        value.content = lines
          .slice(start, start + Math.min(10000, Math.max(1, Number(a.limit) || 1000)))
          .join('\n');
      return { path: file, ...value };
    }
    if (op === 'write') return write(root, file, a.content, a.revision);
    if (op === 'edit') {
      const old = read(file);
      if (a.revision !== undefined && a.revision !== old.revision)
        throw Error('File changed; reload before editing');
      if (typeof a.oldText !== 'string' || !a.oldText || typeof a.newText !== 'string')
        throw Error('oldText and newText required');
      const parts = old.content.split(a.oldText);
      if (parts.length < 2 || (!a.replaceAll && parts.length !== 2))
        throw Error('Text missing or ambiguous');
      return write(root, file, parts.join(a.newText), old.revision);
    }
    if (op === 'delete') {
      const old = read(file);
      if (a.revision !== undefined && a.revision !== old.revision)
        throw Error('File changed; reload');
      if (file === root || fs.lstatSync(file).isSymbolicLink())
        throw Error('Cannot delete root or link');
      fs.unlinkSync(file);
      return { deleted: true, path: file };
    }
    if (op === 'exec') {
      if (typeof a.command !== 'string' || !a.command.trim()) throw Error('Command required');
      return command(
        'bash',
        ['-c', a.command],
        target(root, a.cwd ?? '.'),
        Number.isSafeInteger(a.timeout) && a.timeout > 0 ? a.timeout : 0,
      );
    }
    if (op === 'search') {
      // ripgrep is optional. Missing executable is reported; never run a local substitute.
      if (typeof a.pattern !== 'string' || !a.pattern || a.pattern.length > 4096)
        throw Error('Pattern required');
      const args =
        a.kind === 'glob'
          ? ['--files', '--hidden', '--sort', 'path', '--glob', a.pattern]
          : [
              '--line-number',
              '--with-filename',
              '--no-heading',
              '--sort',
              'path',
              '--color',
              'never',
              ...(a.include ? ['--glob', String(a.include)] : []),
              '--',
              a.pattern,
            ];
      const isFile = fs.statSync(file).isFile();
      if (isFile) args.push(file);
      const result = await command('rg', args, isFile ? path.dirname(file) : file, 30000);
      const lines = result.stdout.trimEnd().split('\n').filter(Boolean);
      const offset = Number.isSafeInteger(a.offset) ? Math.max(0, a.offset) : 0,
        size = a.kind === 'glob' ? 1000 : 500;
      return {
        ...result,
        stdout: lines.slice(offset, offset + size).join('\n'),
        nextOffset: offset + size < lines.length ? offset + size : null,
        incomplete: result.truncated || result.timedOut,
      };
    }
    if (op === 'git-status') {
      const result = await command(
        'git',
        [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--',
          '.',
        ],
        root,
        30000,
      );
      if (result.exitCode !== 0) throw Error(result.stderr || 'Git unavailable');
      const records = result.stdout.split('\0'),
        entries = [];
      for (let i = 0; i < records.length; i++) {
        const line = records[i];
        if (!line) continue;
        const status = line.slice(0, 2),
          value = line.slice(3);
        // git reports names relative to repository root; prefix is needed for subdirectory workspaces.
        entries.push({ status, path: value });
        if (/[RC]/.test(status)) i++;
      }
      const prefix = await command('git', ['rev-parse', '--show-prefix'], root, 30000);
      const base = prefix.stdout.trim();
      return {
        entries: entries
          .filter((e) => !base || e.path.startsWith(base))
          .map((e) => ({ ...e, path: base ? e.path.slice(base.length) : e.path })),
      };
    }
    if (op === 'git-diff') {
      if (!a.path || typeof a.path !== 'string') throw Error('File required');
      const bytes = fs.existsSync(file)
        ? documents
          ? documents.read(file)
          : Buffer.from(read(file).content)
        : null;
      const current = bytes
        ? { revision: hash(bytes), content: bytes.includes(0) ? null : bytes.toString('utf8') }
        : null;
      const head = await command('git', ['rev-parse', '--verify', 'HEAD'], root, 30000);
      if (head.exitCode !== 0) throw Error(head.stderr || 'Git HEAD unavailable');
      const result = await command(
        'git',
        ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', a.path],
        root,
        30000,
      );
      if (result.exitCode !== 0) throw Error(result.stderr || 'Git diff failed');
      const tracked = await command(
        'git',
        ['ls-files', '--error-unmatch', '--', a.path],
        root,
        30000,
      );
      if (tracked.exitCode !== 0 && current)
        result.stdout =
          current.content ?? 'Binary file: ' + a.path + ' (' + bytes!.length + ' bytes)';
      return {
        ...result,
        binary: current?.content === null,
        revision: current?.revision ?? null,
        head: head.stdout.trim(),
      };
    }
    if (op === 'git-revert') {
      if (!a.path || typeof a.path !== 'string' || file === root) throw Error('File required');
      const current = documents
        ? documents.revision(file)
        : fs.existsSync(file)
          ? read(file).revision
          : null;
      if (current !== a.revision) throw Error('File changed; refresh before reverting');
      const head = await command('git', ['rev-parse', '--verify', 'HEAD'], root, 30000);
      if (head.exitCode !== 0 || head.stdout.trim() !== a.head)
        throw Error('Git HEAD changed; refresh before reverting');
      const tracked = await command(
        'git',
        ['ls-files', '--error-unmatch', '--', a.path],
        root,
        30000,
      );
      if (
        (documents
          ? documents.revision(file)
          : fs.existsSync(file)
            ? read(file).revision
            : null) !== a.revision
      )
        throw Error('File changed; refresh before reverting');
      if (tracked.exitCode === 0) {
        const result = await command(
          'git',
          ['restore', '--source=' + a.head, '--staged', '--worktree', '--', a.path],
          root,
          30000,
        );
        if (result.exitCode !== 0) throw Error(result.stderr || 'Git restore failed');
      } else if (current !== null) fs.unlinkSync(file);
      return { restored: true };
    }
    if (op === 'git-stage') {
      if (!a.path || typeof a.path !== 'string') throw Error('File required');
      const current = documents
        ? documents.revision(file)
        : fs.existsSync(file)
          ? read(file).revision
          : null;
      if (a.revision !== current) throw Error('File changed; refresh before staging');
      const result = await command('git', ['add', '--', a.path], root, 30000);
      if (result.exitCode !== 0) throw Error(result.stderr || 'Git add failed');
      return { staged: true };
    }
    throw Error('Unsupported remote operation');
  }
  let queue = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (Buffer.byteLength(line) > 8 * limit) {
      stop();
      return;
    }
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ error: 'Invalid request JSON' }) + '\n');
      return;
    }
    const execute = async () => {
      try {
        const result = await run(request);
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (e: any) {
        process.stdout.write(
          JSON.stringify({ id: request?.id, error: String(e?.message || e) }) + '\n',
        );
      }
    };
    // Long commands must not block file reads and collaboration on this connection.
    if (request.op === 'exec' || request.op === 'search' || request.op === 'repo-verify')
      void execute();
    else queue = queue.then(execute);
  });
}
