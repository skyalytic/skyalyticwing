import 'reflect-metadata';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  RemoteConnection,
  remoteLaunch,
  shellQuote,
  validateTarget,
  REMOTE_BOOTSTRAP,
} from '../../src/modules/core/remote-workspace/remote-connections.js';
import { remoteWorker } from '../../src/modules/core/remote-workspace/remote-worker.js';
import {
  RemoteWorkspaceService,
  remoteSandboxGate,
} from '../../src/modules/core/remote-workspace/remote-workspace.service.js';
describe('remote workspace transport and real worker', () => {
  let directory: string, root: string, connection: RemoteConnection;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wing-remote-fixture-'));
    root = join(directory, 'workspace');
    mkdirSync(root);
    const factory = ((_file: any, _args: any, options: any) =>
      spawn(process.execPath, ['-e', REMOTE_BOOTSTRAP], options)) as typeof spawn;
    connection = new RemoteConnection({ transport: 'ssh', target: 'fixture.invalid' }, factory);
  });
  afterEach(async () => {
    connection.close();
    await new Promise((r) => setTimeout(r, 75));
    // Remove only the directory this test created.
    if (!resolve(directory).startsWith(resolve(tmpdir()) + require('node:path').sep))
      throw Error('Invalid fixture directory');
    rmSync(directory, { recursive: true, force: true });
  });
  it('reads, edits and writes Chinese paths through a real Node worker with revision conflicts', async () => {
    const hello = await connection.request(root, 'hello');
    expect(hello.root).toBeDefined();
    const created = await connection.request(root, 'write', {
      path: '中文 文件.txt',
      content: 'first',
      revision: null,
    });
    await expect(
      connection.request(root, 'write', {
        path: '中文 文件.txt',
        content: 'overwrite',
        revision: null,
      }),
    ).rejects.toThrow('changed');
    const edit = await connection.request(root, 'edit', {
      path: '中文 文件.txt',
      oldText: 'first',
      newText: 'second',
    });
    expect(edit.revision).not.toBe(created.revision);
    const read = await connection.request(root, 'read', { path: '中文 文件.txt' });
    expect(read.content).toBe('second');
    expect((await connection.request(root, 'list')).entries[0].name).toBe('中文 文件.txt');
    await expect(
      connection.request(root, 'edit', {
        path: '中文 文件.txt',
        oldText: 'missing',
        newText: 'bad',
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(root, '中文 文件.txt'), 'utf8')).toBe('second');
  });
  it('blocks traversal, escaped links, binary edits and recursive deletion', async () => {
    mkdirSync(join(directory, 'outside'));
    writeFileSync(join(directory, 'outside', 'secret'), 'private');
    symlinkSync(join(directory, 'outside'), join(root, 'linked'), 'junction');
    await expect(connection.request(root, 'read', { path: '../outside/secret' })).rejects.toThrow(
      'escapes',
    );
    await expect(
      connection.request(root, 'write', { path: 'linked/new.txt', content: 'no' }),
    ).rejects.toThrow('escapes');
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
    await expect(connection.request(root, 'read', { path: 'binary' })).rejects.toThrow('Binary');
    await expect(connection.request(root, 'delete', { path: '.' })).rejects.toThrow();
  });
  it('reviews, stages and restores only the selected file, refusing stale review revisions', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true });
    git(['init', '--quiet']);
    writeFileSync(join(root, 'a.txt'), 'base');
    git(['add', 'a.txt']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    await connection.request(root, 'write', { path: 'a.txt', content: 'edited' });
    const review = await connection.request(root, 'git-diff', { path: 'a.txt' });
    expect(review.stdout).toContain('+edited');
    await connection.request(root, 'git-stage', { path: 'a.txt', revision: review.revision });
    const status = await connection.request(root, 'git-status');
    expect(status.entries).toContainEqual({ path: 'a.txt', status: 'M ' });
    writeFileSync(join(root, 'a.txt'), 'outside edit');
    await expect(
      connection.request(root, 'git-revert', {
        path: 'a.txt',
        revision: review.revision,
        head: review.head,
      }),
    ).rejects.toThrow('changed');
    const fresh = await connection.request(root, 'git-diff', { path: 'a.txt' });
    await connection.request(root, 'git-revert', {
      path: 'a.txt',
      revision: fresh.revision,
      head: fresh.head,
    });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base');
    expect((await connection.request(root, 'git-status')).entries).toEqual([]);
    writeFileSync(join(root, 'b.txt'), 'must remain untracked');
    await expect(
      connection.request(root, 'git-stage', { path: ':(glob)*', revision: null }),
    ).rejects.toThrow();
    expect(git(['diff', '--cached', '--name-only']).toString()).toBe('');
  }, 30000);
  it('closes all requests on cancellation and never automatically replays them', async () => {
    const controller = new AbortController();
    const pending = connection.request(root, 'hello', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(
      connection.request(root, 'write', { path: 'not-created', content: 'x' }),
    ).rejects.toThrow('closed');
  });
  (process.platform === 'win32' ? it.skip : it)(
    'runs POSIX commands in the remote root without blocking other requests and kills timed-out jobs',
    async () => {
      const long = connection.request(root, 'exec', { command: 'sleep 1; pwd', timeout: 5000 });
      const hello = await Promise.race([connection.request(root, 'hello'), long.then(() => null)]);
      expect(hello?.root).toBe(root);
      expect((await long).stdout.trim()).toBe(root);
      const timed = await connection.request(root, 'exec', {
        command: 'sleep 1; touch late.txt',
        timeout: 25,
      });
      expect(timed.timedOut).toBe(true);
      await new Promise((r) => setTimeout(r, 1100));
      await expect(connection.request(root, 'read', { path: 'late.txt' })).rejects.toThrow();
    },
  );
  it('builds OpenSSH and WSL argument arrays without a local shell', () => {
    const ssh = remoteLaunch({ transport: 'ssh', target: 'user@example.test', port: 2200 }, [
      'node',
      '-e',
      "a'b",
    ]);
    expect(ssh.file).toBe('ssh');
    expect(ssh.args).toContain('StrictHostKeyChecking=yes');
    expect(ssh.args.at(-1)).toBe("'node' '-e' 'a'\\''b'");
    expect(remoteLaunch({ transport: 'wsl', target: 'Ubuntu' }, ['node', '-e', 'x']).args).toEqual([
      '--distribution',
      'Ubuntu',
      '--exec',
      'node',
      '-e',
      'x',
    ]);
    expect(() => validateTarget({ transport: 'ssh', target: '-oProxyCommand=bad' })).toThrow();
    expect(() => validateTarget({ transport: 'ssh', target: 'host;bad' })).toThrow();
    expect(shellQuote('/tmp/a b')).toBe("'/tmp/a b'");
  });
  it('enforces remote sandbox policy without treating Windows paths as POSIX paths', () => {
    expect(remoteSandboxGate('read-only', 'file-write', '/work', { path: 'a' }).allowed).toBe(
      false,
    );
    expect(
      remoteSandboxGate('workspace-write', 'file-write', '/work', { path: '../escape' }).allowed,
    ).toBe(false);
    expect(
      remoteSandboxGate('workspace-write', 'file-write', '/work', { path: 'src/a' }).allowed,
    ).toBe(true);
    expect(
      remoteSandboxGate('workspace-write', 'file-delete', '/work', { paths: ['src/a', 'src/b'] })
        .allowed,
    ).toBe(true);
    expect(
      remoteSandboxGate('workspace-write', 'file-delete', '/work', {
        paths: ['src/a', '../escape'],
      }).allowed,
    ).toBe(false);
    expect(remoteSandboxGate('workspace-write', 'bash', '/work', {}).allowed).toBe(false);
  });
  it('preserves the installed file-tool contracts through a real worker, including stale edits and multi-file deletes', async () => {
    const previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'data');
    const service = new RemoteWorkspaceService({ credentialIdentity: () => 'alice' } as any);
    try {
      (service as any).save({
        workspaces: [
          { id: 'w', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid', root: '/work' },
        ],
        bindings: { s: 'w' },
      });
      jest
        .spyOn(service, 'request')
        .mockImplementation((_id, op, args, signal) => connection.request(root, op, args, signal));
      writeFileSync(join(root, 'a.txt'), 'before');
      writeFileSync(join(root, 'b.txt'), 'second');
      const observed = await service.tool('s', 'file-read', { path: 'a.txt' });
      expect(observed!.data.version).toBe(observed!.data.revision);
      writeFileSync(join(root, 'a.txt'), 'external change');
      await expect(
        service.tool('s', 'file-write', { path: 'a.txt', content: 'stale overwrite' }),
      ).rejects.toThrow('changed');
      await expect(
        service.tool('s', 'file-edit', {
          path: 'a.txt',
          oldText: 'external',
          newText: 'stale',
          expectedVersion: observed!.data.version,
        }),
      ).rejects.toThrow('changed');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('external change');
      const fresh = await service.tool('s', 'file-read', { path: 'a.txt' });
      await service.tool('s', 'file-write', {
        path: 'a.txt',
        content: 'merged',
        expectedVersion: fresh!.data.version,
      });
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('merged');
      const listing = await service.tool('s', 'directory-list', { path: '.', ignore: ['a.*'] });
      expect(listing!.data.entries.map((entry: any) => entry.name)).toEqual(['b.txt']);
      await expect(
        service.tool('s', 'file-delete', { paths: ['a.txt', '../outside'] }),
      ).rejects.toThrow('workspace paths');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('merged');
      expect(await service.tool('s', 'file-delete', { paths: ['a.txt', 'b.txt'] })).toMatchObject({
        success: true,
        data: { deleted: ['a.txt', 'b.txt'], errors: [] },
      });
      expect((await connection.request(root, 'list')).entries).toEqual([]);
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
      else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    }
  });
  it('does not bind another account after a connection finishes during an account switch', async () => {
    const previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'data');
    let identity = 'alice';
    const service = new RemoteWorkspaceService({ credentialIdentity: () => identity } as any);
    try {
      (service as any).save({
        workspaces: [
          { id: 'w', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid', root: '/work' },
        ],
        bindings: {},
      });
      let resolveConnection!: (value: any) => void;
      jest.spyOn(service, 'connect').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveConnection = resolve;
          }),
      );
      const binding = service.bind('s', 'w');
      identity = 'bob';
      resolveConnection({});
      await expect(binding).rejects.toThrow('Account changed');
      expect(service.list('s')).toMatchObject({ workspaces: [], bound: null });
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
      else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    }
  });
  it('routes AI files remotely, fails closed for unsupported executors, and separates account bindings', async () => {
    const old = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'data');
    let identity = 'alice';
    const service = new RemoteWorkspaceService({ credentialIdentity: () => identity } as any);
    try {
      (service as any).save({
        workspaces: [
          { id: 'w', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid', root: '/work' },
        ],
        bindings: { s: 'w' },
      });
      const request = jest
        .spyOn(service, 'request')
        .mockResolvedValue({ content: 'remote contents' });
      expect(await service.tool('s', 'file-read', { path: 'a.txt' })).toMatchObject({
        success: true,
        output: 'remote contents',
      });
      expect(request).toHaveBeenCalledWith('w', 'read', { path: 'a.txt' }, undefined);
      service.inherit('s', 'child', 'shared');
      service.inherit('child', 'grandchild', 'shared');
      expect(service.binding('grandchild')?.root).toBe('/work');
      await service.tool('grandchild', 'file-read', { path: 'nested.txt' });
      expect(request).toHaveBeenCalledWith('w', 'read', { path: 'nested.txt' }, undefined);
      await expect(service.tool('s', 'powershell', { command: 'write local' })).rejects.toThrow(
        '未在本机',
      );
      identity = 'bob';
      expect(service.binding('s')).toBeUndefined();
      expect(service.list().workspaces).toEqual([]);
      expect(() => service.binding('child')).toThrow('another account');
      identity = 'alice';
      expect(service.binding('s')?.root).toBe('/work');
      service.unbind('s');
      expect(service.binding('s')).toBeUndefined();
      expect(() => service.binding('grandchild')).toThrow('workspace changed');
    } finally {
      service.onModuleDestroy();
      if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
      else process.env['SKYALYTICWING_DATA_DIR'] = old;
    }
  });
});
