import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  RemoteConnection,
  REMOTE_BOOTSTRAP,
} from '../../src/modules/core/remote-workspace/remote-connections.js';
import { RemoteWorkspaceService } from '../../src/modules/core/remote-workspace/remote-workspace.service.js';

describe('remote Git worktree isolation with real Git and Node', () => {
  let directory: string, root: string, connection: RemoteConnection;
  const factory = ((_file: any, _args: any, options: any) =>
    spawn(process.execPath, ['-e', REMOTE_BOOTSTRAP], options)) as typeof spawn;
  const git = (args: string[], cwd = root) =>
    execFileSync('git', args, { cwd, windowsHide: true }).toString();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wing-worktree-fixture-'));
    root = join(directory, 'repository');
    mkdirSync(root);
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
    connection = new RemoteConnection({ transport: 'ssh', target: 'fixture.invalid' }, factory);
  });
  afterEach(async () => {
    connection.close();
    await new Promise((r) => setTimeout(r, 100));
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw Error('Invalid fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  it('seeds current tracked/untracked content into distinct checkouts without touching the parent index', async () => {
    writeFileSync(join(root, 'a.txt'), 'staged');
    git(['add', 'a.txt']);
    writeFileSync(join(root, 'a.txt'), 'current');
    writeFileSync(join(root, '新文件.txt'), 'untracked');
    const indexBefore = git(['diff', '--cached', '--binary']);
    const [one, two] = await Promise.all(
      ['1', '2'].map((c) => connection.request(root, 'worktree-create', { token: c.repeat(64) })),
    );
    expect(one.root).not.toBe(two.root);
    expect((await connection.request(one.root, 'read', { path: 'a.txt' })).content).toBe('current');
    expect((await connection.request(two.root, 'read', { path: '新文件.txt' })).content).toBe(
      'untracked',
    );
    await connection.request(one.root, 'write', { path: 'a.txt', content: 'child one' });
    await connection.request(two.root, 'write', { path: 'a.txt', content: 'child two' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('current');
    expect(readFileSync(join(one.root, 'a.txt'), 'utf8')).toBe('child one');
    expect(readFileSync(join(two.root, 'a.txt'), 'utf8')).toBe('child two');
    expect(git(['diff', '--cached', '--binary'])).toBe(indexBefore);
    expect(await connection.request(root, 'worktree-create', { token: '1'.repeat(64) })).toEqual(
      one,
    );
    await expect(
      connection.request(root, 'worktree-remove', { token: '1'.repeat(64) }),
    ).rejects.toThrow('changes or commits');
    expect(existsSync(one.root)).toBe(true);
  }, 30000);
  it('creates a worktree for a repository subdirectory and removes only a clean managed checkout', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.txt'), 'base');
    git(['add', 'sub']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'sub',
    ]);
    const child = await connection.request(join(root, 'sub'), 'worktree-create', {
      token: '3'.repeat(64),
    });
    expect(readFileSync(join(child.root, 'b.txt'), 'utf8')).toBe('base');
    expect(child.root).toBe(join(child.checkout, 'sub'));
    await expect(
      connection.request(join(root, 'sub'), 'worktree-remove', { token: '4'.repeat(64) }),
    ).rejects.toThrow('not found');
    expect(
      await connection.request(join(root, 'sub'), 'worktree-remove', { token: '3'.repeat(64) }),
    ).toEqual({ removed: true });
    expect(existsSync(child.checkout)).toBe(false);
    expect(existsSync(root)).toBe(true);
  }, 30000);
  it('prepares independent child connections, retains completed workspaces, and keeps shared mode explicit', async () => {
    const previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'data');
    const service = new RemoteWorkspaceService({ credentialIdentity: () => 'fixture' } as any);
    try {
      (service as any).save({
        workspaces: [
          { id: 'w', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid', root },
        ],
        bindings: { parent: 'w' },
      });
      jest
        .spyOn(service as any, 'open')
        .mockImplementation(
          () => new RemoteConnection({ transport: 'ssh', target: 'fixture.invalid' }, factory),
        );
      service.inherit('parent', 'sub-one');
      service.inherit('parent', 'sub-two');
      expect(() => service.binding('sub-one')).toThrow('not prepared');
      const [one, two] = await Promise.all([
        service.prepareChild('sub-one'),
        service.prepareChild('sub-two'),
      ]);
      expect(one!.id).not.toBe(two!.id);
      expect(one!.root).not.toBe(two!.root);
      await service.tool('sub-one', 'file-read', { path: 'a.txt' });
      await service.tool('sub-one', 'file-write', { path: 'a.txt', content: 'one' });
      service.release('sub-one');
      expect(await service.tool('sub-two', 'file-read', { path: 'a.txt' })).toMatchObject({
        success: true,
        output: 'base',
      });
      expect(service.list().workspaces.some((w) => w.id === one!.id)).toBe(true);
      expect(readFileSync(join(one!.root, 'a.txt'), 'utf8')).toBe('one');
      service.inherit('parent', 'shared', 'shared');
      expect((await service.prepareChild('shared'))?.root).toBe(root);
      service.release('shared');
      service.release('sub-two');
      await service.remove(two!.id);
      expect(existsSync(two!.root)).toBe(false);
      await expect(service.remove(one!.id)).rejects.toThrow('changes or commits');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base');
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
      else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    }
  }, 30000);
});
