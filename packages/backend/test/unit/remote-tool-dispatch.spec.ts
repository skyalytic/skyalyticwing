import 'reflect-metadata';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  RemoteConnection,
  REMOTE_BOOTSTRAP,
} from '../../src/modules/core/remote-workspace/remote-connections.js';
import {
  RemoteWorkspaceService,
  remoteSandboxGate,
  usesLocalHost,
} from '../../src/modules/core/remote-workspace/remote-workspace.service.js';
import { ToolExecutorService } from '../../src/modules/tools/executor/tool-executor.service.js';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service.js';
import { SandboxProfileService } from '../../src/modules/tools/sandbox/sandbox-profile.service.js';
import { createCronMcpTools } from '../../src/extensions/bundled/schedules/tools/cron-mcp.js';
import { createTodoTools } from '../../src/extensions/bundled/tasks/tools/todo.js';
import { createMemoryTools } from '../../src/extensions/bundled/memory/tools/memory.js';

describe('remote tools through the actual executor and worker', () => {
  let directory: string, root: string, remote: RemoteWorkspaceService, connection: RemoteConnection;
  let old: string | undefined, registry: ToolRegistryService, executor: ToolExecutorService;
  let state: any, security: any, sandbox: SandboxProfileService;
  const ctx = () =>
    ({ sessionId: 'dispatch', workspace: directory, log: jest.fn(), broadcast: jest.fn() }) as any;
  const call = (name: string, args: any = {}, approvalGranted = false) =>
    executor.execute(name, args, ctx(), { approvalGranted });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wing-dispatch-'));
    root = join(directory, 'remote');
    mkdirSync(root);
    root = realpathSync.native(root);
    old = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'profile');
    const factory = ((_file: any, _args: any, options: any) =>
      spawn(process.execPath, ['-e', REMOTE_BOOTSTRAP], options)) as typeof spawn;
    connection = new RemoteConnection({ transport: 'ssh', target: 'fixture.invalid' }, factory);
    remote = new RemoteWorkspaceService();
    (remote as any).save({
      workspaces: [
        { id: 'w', name: 'Fixture', transport: 'ssh', target: 'fixture.invalid', root: '/remote' },
      ],
      bindings: { dispatch: 'w' },
    });
    jest
      .spyOn(remote, 'request')
      .mockImplementation((_id, op, args, signal) => connection.request(root, op, args, signal));
    state = { security: { yolo: 'yolo' }, tools: {} };
    const config = { get: (s: string) => state[s] || {}, getAll: () => state };
    const log = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    security = {
      isCommandAllowed: jest.fn(() => true),
      getCommandGuard: () => ({
        isCommandBlacklisted: () => false,
        isCommandWhitelisted: () => false,
      }),
    };
    registry = new ToolRegistryService();
    sandbox = new SandboxProfileService(log as any, join(directory, 'sandbox'));
    executor = new ToolExecutorService(
      registry,
      security,
      {} as any,
      { broadcast: jest.fn() } as any,
      log as any,
      config as any,
      {} as any,
      { get: (token: any) => (token === RemoteWorkspaceService ? remote : undefined) } as any,
      undefined,
      sandbox,
    );
    for (const name of ['repo_inspect', 'repo_verify', 'apply_patch', 'diff', 'file-read'])
      registry.registerBuiltin({
        name,
        description: name,
        category: 'file',
        dangerous: ['repo_verify', 'apply_patch'].includes(name),
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          throw Error('Must not execute on local filesystem');
        },
      });
    for (const tool of [...createTodoTools(), ...createMemoryTools((() => undefined) as any)])
      registry.registerBuiltin(tool);
  });
  afterEach(async () => {
    remote.onModuleDestroy();
    connection.close();
    await new Promise((r) => setTimeout(r, 100));
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = old;
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error('Invalid test root');
    rmSync(directory, { recursive: true, force: true });
  });
  const init = () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true });
    git(['init', '--quiet']);
    writeFileSync(join(root, 'tracked.txt'), 'before\n');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: 'node test.cjs', build: 'node build.cjs', unrelated: 'never' },
      }),
    );
    git(['add', '.']);
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
  };
  it('runs session plans and todos in a remote session, including read-only workspace mode', async () => {
    state.security.yolo = 'auto';
    sandbox.setSessionMode('dispatch', 'read-only');
    expect(await call('todo', { action: 'add', text: 'remote task' })).toMatchObject({
      success: true,
    });
    expect((await call('todo', { action: 'list' })).output).toContain('remote task');
    expect(
      await call('update_plan', { plan: [{ step: 'check', status: 'in_progress' }] }),
    ).toMatchObject({ success: true });
    expect(remote.request).not.toHaveBeenCalled();
  });
  it('preserves service, approval and disabled-tool gates instead of blocking host services', async () => {
    for (const name of ['memory_search', 'cron_list', 'mcp_call']) {
      const effect = jest.fn(async (_a: unknown, context: any) => ({
        success: true,
        output: context.workspace,
      }));
      registry.unregister(name);
      registry.registerBuiltin({
        name,
        description: name,
        category: 'system',
        dangerous: name === 'mcp_call',
        parameters: { type: 'object', properties: {} },
        execute: effect,
      });
      state.security.yolo = 'auto';
      sandbox.setSessionMode('dispatch', 'read-only');
      if (name === 'mcp_call') {
        expect(await call(name)).toMatchObject({ success: false, approvalRequired: true });
        expect(effect).not.toHaveBeenCalled();
      }
      expect(await call(name, {}, true)).toMatchObject({ success: true, output: directory });
      state.tools.toolSettings = { [name]: { disabled: true } };
      expect(await call(name, {}, true)).toMatchObject({ success: false, blocked: true });
      expect(effect).toHaveBeenCalledTimes(1);
      state.tools.toolSettings = {};
    }
  });
  it('dispatches the installed memory, scheduler and MCP adapters to their configured services', async () => {
    const search = jest.fn(() => [{ content: '文宇', score: 1 }]);
    const listJobs = jest.fn(() => [{ id: 'fixture-job', name: 'Fixture' }]);
    const callTool = jest.fn(async () => ({ success: true, output: 'MCP fixture' }));
    const resolver = ((token: any) =>
      token.name === 'MemoryService'
        ? { search }
        : token.name === 'CronService'
          ? { listJobs }
          : token.name === 'McpService'
            ? { callTool }
            : undefined) as any;
    for (const tool of [...createMemoryTools(resolver), ...createCronMcpTools(resolver)]) {
      registry.unregister(tool.name);
      registry.registerBuiltin(tool);
    }
    expect(await call('memory_search', { query: '文宇' })).toMatchObject({
      success: true,
      data: { total: 1 },
    });
    expect(await call('cron_list')).toMatchObject({ success: true });
    expect(
      await call('mcp_call', { serverId: 'fixture', toolName: 'lookup', args: { text: '文宇' } }),
    ).toMatchObject({ success: true, output: 'MCP fixture' });
    expect(search).toHaveBeenCalledWith('文宇', 10, undefined);
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('fixture', 'lookup', { text: '文宇' });
    expect(remote.request).not.toHaveBeenCalled();
  });
  it('does not accidentally allow arbitrary executors on the host', async () => {
    expect(usesLocalHost('apply_patch')).toBe(false);
    expect(usesLocalHost('unknown_plugin')).toBe(false);
    await expect(remote.tool('dispatch', 'unknown_plugin', {})).rejects.toThrow('未在本机');
    expect(
      remoteSandboxGate('workspace-write', 'repo_verify', '/remote', { root: '.' }).allowed,
    ).toBe(false);
    expect(
      remoteSandboxGate('workspace-write', 'apply_patch', '/remote', { file_path: '../outside' })
        .allowed,
    ).toBe(false);
    expect(
      remoteSandboxGate('workspace-write', 'apply_patch', '/remote', { file_path: 'a.txt' })
        .allowed,
    ).toBe(true);
  });
  it('reads actual remote repository metadata without running scripts', async () => {
    init();
    writeFileSync(join(root, 'tracked.txt'), 'after\n');
    const result = await call('repo_inspect');
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      root,
      files: expect.arrayContaining(['tracked.txt']),
      diff: expect.stringContaining('+after'),
      commands: expect.arrayContaining([{ label: 'test', command: 'npm', args: ['run', 'test'] }]),
    });
    expect(existsSync(join(root, '.wing-terminal'))).toBe(false);
    expect((await call('repo_inspect', { root: '..' })).success).toBe(false);
  });
  it('executes repository verification remotely with literal arguments, logs and real exit status', async () => {
    init();
    const literal = '文宇 $HOME ; not a shell';
    const script =
      "require('fs').writeFileSync('tracked.txt',process.argv[1]);console.log(process.argv[1]);process.exit(7)";
    const result = await call('repo_verify', {
      command: process.execPath,
      args: ['-e', script, literal],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      exitCode: 7,
      before: expect.any(Object),
      after: expect.any(Object),
    });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe(literal);
    expect(readFileSync((result.data as any).logPath, 'utf8')).toContain(literal);
    expect((result.data as any).after.status).not.toContain('.wing-terminal');
    expect(existsSync(join(directory, 'tracked.txt'))).toBe(false);
  });
  it('applies command policy even after approval and refuses execution before approval', async () => {
    init();
    state.security.yolo = 'ask';
    const args = {
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('bad','bad')"],
    };
    expect(await call('repo_verify', args)).toMatchObject({
      success: false,
      approvalRequired: true,
    });
    security.isCommandAllowed.mockReturnValue(false);
    expect(await call('repo_verify', args, true)).toMatchObject({ success: false, blocked: true });
    expect(existsSync(join(root, 'bad'))).toBe(false);
  });
  it('times out a repository command and remains responsive during its execution', async () => {
    init();
    const pending = call('repo_verify', {
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},5000)'],
      timeout: 200,
    });
    await new Promise((r) => setTimeout(r, 70));
    expect((await connection.request(root, 'hello')).root).toBe(root);
    expect(await pending).toMatchObject({ success: false, data: { timedOut: true } });
  });
  it('commits all patches atomically and refuses missing or ambiguous replacements', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    expect(
      await call('apply_patch', {
        file_path: 'a.txt',
        patches: [
          { search: 'one', replace: 'ONE' },
          { search: 'missing', replace: 'x' },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(
      await call('apply_patch', {
        file_path: 'a.txt',
        patches: [
          { search: 'one', replace: 'ONE' },
          { search: 'two', replace: 'TWO' },
        ],
      }),
    ).toMatchObject({ success: true, data: { applied: 2 } });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ONE\nTWO\n');
    writeFileSync(join(root, 'repeat'), 'x x');
    expect(
      (await call('apply_patch', { file_path: 'repeat', patches: [{ search: 'x', replace: 'z' }] }))
        .success,
    ).toBe(false);
  });
  it('handles unified patches, stale observations and both diff input modes', async () => {
    writeFileSync(join(root, 'a.txt'), 'before\n');
    expect(
      await call('apply_patch', {
        file_path: 'a.txt',
        unified_diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n',
      }),
    ).toMatchObject({ success: true });
    expect(await call('diff', { file1: 'a.txt', text2: 'before\n' })).toMatchObject({
      success: true,
      data: { changes: 1, diff: expect.stringContaining('after') },
    });
    expect(await call('diff', { text1: 'x', text2: 'y' })).toMatchObject({
      success: true,
      data: { changes: 1 },
    });
    await call('file-read', { path: 'a.txt' });
    writeFileSync(join(root, 'a.txt'), 'external\n');
    expect(
      (
        await call('apply_patch', {
          file_path: 'a.txt',
          patches: [{ search: 'external', replace: 'lost' }],
        })
      ).success,
    ).toBe(false);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('external\n');
  });
  it('rejects escaped links and never reads local paths as remote files', async () => {
    writeFileSync(join(directory, 'private.txt'), 'private');
    symlinkSync(directory, join(root, 'escape'), 'junction');
    for (const file of ['../private.txt', 'escape/private.txt']) {
      expect((await call('diff', { file1: file, text2: '' })).success).toBe(false);
      expect(
        (
          await call('apply_patch', {
            file_path: file,
            patches: [{ search: 'private', replace: 'lost' }],
          })
        ).success,
      ).toBe(false);
    }
    expect(readFileSync(join(directory, 'private.txt'), 'utf8')).toBe('private');
  });
});
