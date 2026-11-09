import 'reflect-metadata';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import {
  RemoteConnection,
  REMOTE_BOOTSTRAP,
} from '../../src/modules/core/remote-workspace/remote-connections';
import {
  RemoteWorkspaceService,
  remoteSandboxGate,
  usesLocalHost,
} from '../../src/modules/core/remote-workspace/remote-workspace.service';
import {
  readRemoteDocument,
  writeRemoteDocument,
} from '../../src/modules/core/remote-workspace/remote-office';
import { ToolExecutorService } from '../../src/modules/tools/executor/tool-executor.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';
import { RemoteWorkspaceController } from '../../src/modules/core/remote-workspace/remote-workspace.module';
import {
  NativeOfficeService,
  NativeOfficeController,
} from '../../src/modules/tools/files/native-office.service';
import { createOfficeTools } from '../../src/extensions/bundled/office/tools/office-tools';
jest.setTimeout(30000);

describe('remote Office transport and desktop tool routing', () => {
  let directory: string,
    root: string,
    connection: RemoteConnection,
    service: RemoteWorkspaceService,
    native: NativeOfficeService;
  const old = process.env['SKYALYTICWING_DATA_DIR'];
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const request = (op: string, args: any) => connection.request(root, op, args);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wing-remote-office-'));
    root = join(directory, 'workspace');
    mkdirSync(root);
    process.env['SKYALYTICWING_DATA_DIR'] = join(directory, 'host-data');
    const factory = ((_file: any, _args: any, options: any) =>
      spawn(process.execPath, ['-e', REMOTE_BOOTSTRAP], options)) as typeof spawn;
    connection = new RemoteConnection({ transport: 'ssh', target: 'fixture.invalid' }, factory);
    service = new RemoteWorkspaceService();
    native = new NativeOfficeService({ isPathAllowed: () => false } as any, service);
    (native as any).assets = () => directory;
    (service as any).save({
      workspaces: [
        {
          id: 'w',
          name: 'Fixture',
          transport: 'ssh',
          target: 'fixture.invalid',
          root: '/workspace',
        },
      ],
      bindings: { s: 'w' },
    });
    jest.spyOn(service, 'request').mockImplementation((_id, op, args: any = {}, signal) => {
      const value = { ...args };
      if (typeof value.path === 'string' && value.path.startsWith('/workspace/'))
        value.path = value.path.slice('/workspace/'.length);
      return connection.request(root, op, value, signal);
    });
  });
  afterEach(async () => {
    native.onModuleDestroy();
    service.onModuleDestroy();
    connection.close();
    await new Promise((r) => setTimeout(r, 100));
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = old;
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw Error('Invalid fixture directory');
    rmSync(directory, { recursive: true, force: true });
  });
  it.each(['docx', 'xlsx', 'pptx'])(
    'generates, reads and edits actual %s on the worker, preserving ZIP parts and refusing stale revisions',
    async (format) => {
      const name = '中文.' + format;
      const generated = await service.tool('s', 'doc_generate', {
        format,
        title: '文宇',
        content: '原始正文',
        sections: [
          {
            heading: '验收',
            content: '原始正文',
            rows: [
              ['名称', '值'],
              ['文宇', 73],
            ],
          },
        ],
        outputPath: name,
      });
      expect(generated?.success).toBe(true);
      const original = readFileSync(join(root, name)),
        before = await JSZip.loadAsync(original);
      const snapshot = (await service.tool('s', 'office_read', { path: name }))!.data as any;
      const field = snapshot.sections
        .flatMap((s: any) => s.fields)
        .find((f: any) => f.value.includes('文宇') || f.value.includes('原始'));
      expect(field).toBeDefined();
      expect(
        await service.tool('s', 'office_edit', {
          path: name,
          revision: snapshot.revision,
          changes: [{ id: field.id, value: '文宇修改成功' }],
        }),
      ).toMatchObject({ success: true, data: { saved: 1 } });
      const after = await JSZip.loadAsync(readFileSync(join(root, name)));
      expect(await after.file('[Content_Types].xml')!.async('string')).toBe(
        await before.file('[Content_Types].xml')!.async('string'),
      );
      expect(
        JSON.stringify((await service.tool('s', 'office_read', { path: name }))!.data),
      ).toContain('文宇修改成功');
      await expect(
        service.tool('s', 'office_edit', {
          path: name,
          revision: snapshot.revision,
          changes: [{ id: field.id, value: 'wrong' }],
        }),
      ).rejects.toThrow('修改');
      expect(existsSync(join(directory, 'host-data', 'office-backups'))).toBe(false);
      expect(readdirSync(root).some((n) => n.startsWith('.wing-upload-'))).toBe(false);
    },
    30000,
  );
  it('opens, saves and downloads Office files through the remote controller only', async () => {
    await service.tool('s', 'doc_generate', {
      format: 'docx',
      title: 'Remote document',
      content: 'Original',
      outputPath: 'panel.docx',
    });
    const controller = new RemoteWorkspaceController(service);
    const snapshot = (await controller.operation('w', {
      op: 'office-read',
      args: { path: 'panel.docx' },
    })) as any;
    const field = snapshot.sections[0].fields[0];
    await controller.operation('w', {
      op: 'office-edit',
      args: {
        path: 'panel.docx',
        revision: snapshot.revision,
        changes: [{ id: field.id, value: 'Edited in panel' }],
      },
    });
    const download = await controller.document('w', 'panel.docx'),
      parts: Buffer[] = [];
    for await (const part of download.getStream()) parts.push(Buffer.from(part));
    expect(Buffer.concat(parts).equals(readFileSync(join(root, 'panel.docx')))).toBe(true);
    expect(download.getHeaders().disposition).toContain('attachment');
    await expect(controller.document('w', '../outside.docx')).rejects.toThrow('escapes');
  });
  it('generates PDF bytes through the same remote-only output sink', async () => {
    expect(
      await service.tool('s', 'doc_generate', {
        format: 'pdf',
        title: 'Fixture',
        content: 'Document validation',
        outputPath: 'out.pdf',
      }),
    ).toMatchObject({ success: true });
    expect(readFileSync(join(root, 'out.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('transfers multiple chunks and rejects stale reads, incomplete uploads and changed destinations', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 19),
      saved = await writeRemoteDocument(request, 'large.docx', null, bytes);
    expect((await readRemoteDocument(request, 'large.docx')).equals(bytes)).toBe(true);
    await expect(
      request('binary-read', { path: 'large.docx', revision: '0'.repeat(64) }),
    ).rejects.toThrow('changed');
    const next = Buffer.from('next'),
      upload = await request('binary-begin', {
        path: 'large.docx',
        revision: saved.revision,
        size: next.length,
        digest: digest(next),
      });
    await request('binary-chunk', {
      path: 'large.docx',
      id: upload.id,
      offset: 0,
      data: next.toString('base64'),
    });
    writeFileSync(join(root, 'large.docx'), 'external');
    await expect(request('binary-commit', { path: 'large.docx', id: upload.id })).rejects.toThrow(
      'changed',
    );
    expect(readFileSync(join(root, 'large.docx'), 'utf8')).toBe('external');
    const corrupt = await request('binary-begin', {
      path: 'new.docx',
      revision: null,
      size: 4,
      digest: '0'.repeat(64),
    });
    await expect(request('binary-commit', { path: 'new.docx', id: corrupt.id })).rejects.toThrow(
      'Incomplete',
    );
    expect(existsSync(join(root, 'new.docx'))).toBe(false);
    expect(readdirSync(root).some((n) => n.startsWith('.wing-upload-'))).toBe(false);
  }, 30000);
  it('cancels an upload without leaving a partial destination, and blocks traversal and oversized documents', async () => {
    await expect(request('binary-stat', { path: '../outside.docx' })).rejects.toThrow('escapes');
    await expect(
      request('binary-begin', {
        path: 'too-large',
        revision: null,
        size: 26 * 1024 * 1024,
        digest: '0'.repeat(64),
      }),
    ).rejects.toThrow('Invalid');
    const bytes = Buffer.from('cancel');
    const upload = await request('binary-begin', {
      path: 'cancel.docx',
      revision: null,
      size: bytes.length,
      digest: digest(bytes),
    });
    await request('binary-chunk', {
      path: 'cancel.docx',
      id: upload.id,
      offset: 0,
      data: bytes.toString('base64'),
    });
    connection.close('cancelled');
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(join(root, 'cancel.docx'))).toBe(false);
    expect(readdirSync(root).some((n) => n.startsWith('.wing-upload-'))).toBe(false);
  });
  it('stages and restores real binary documents while preserving unrelated changes', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true });
    git(['init', '--quiet']);
    const base = Buffer.from([0, 1, 2, 3]);
    writeFileSync(join(root, 'book.docx'), base);
    git(['add', 'book.docx']);
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
    const edited = Buffer.from([0, 5, 6, 7]);
    await writeRemoteDocument(request, 'book.docx', digest(base), edited);
    writeFileSync(join(root, 'keep.txt'), 'keep');
    const review = await request('git-diff', { path: 'book.docx' });
    expect(review.binary).toBe(true);
    await request('git-stage', { path: 'book.docx', revision: review.revision });
    await request('git-revert', {
      path: 'book.docx',
      revision: review.revision,
      head: review.head,
    });
    expect(readFileSync(join(root, 'book.docx'))).toEqual(base);
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  }, 30000);
  it('dispatches node_repl with its original local context and local sandbox policy', async () => {
    const registry = new ToolRegistryService(),
      effect = jest.fn(async () => ({ success: true }));
    registry.registerBuiltin({
      name: 'node_repl',
      category: 'interactive',
      description: 'fixture',
      dangerous: true,
      parameters: { type: 'object', properties: {} },
      execute: effect,
    });
    const config = {
      get: (key: string) =>
        key === 'security'
          ? { yolo: 'auto' }
          : key === 'tools'
            ? { toolSettings: { node_repl: { permission: 'auto' } } }
            : {},
    };
    const log = { warn: jest.fn(), error: jest.fn() },
      profile = {
        effectiveMode: () => 'workspace-write',
        check: jest.fn(() => ({ allowed: true })),
      };
    const modules = {
      get: (token: unknown) => (token === RemoteWorkspaceService ? service : undefined),
    };
    const executor = new ToolExecutorService(
      registry,
      {} as any,
      {} as any,
      {} as any,
      log as any,
      config as any,
      {} as any,
      modules as any,
      undefined,
      profile as any,
    );
    const ctx = { sessionId: 's', workspace: 'local-desktop-context' };
    expect(await executor.execute('node_repl', { code: 'fixture' }, ctx as any)).toMatchObject({
      success: true,
    });
    expect(effect).toHaveBeenCalledWith({ code: 'fixture' }, ctx);
    expect(profile.check).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'node_repl', ctx }),
    );
    profile.check.mockReturnValue({ allowed: false });
    expect(await executor.execute('node_repl', { code: 'fixture' }, ctx as any)).toMatchObject({
      success: false,
      approvalRequired: true,
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('keeps desktop node_repl on its existing host and enforces remote Office write policy', async () => {
    for (const name of ['node_repl', 'node_repl_reset', 'computer_use_confirm']) {
      expect(usesLocalHost(name)).toBe(true);
      expect(await service.tool('s', name, {})).toBeUndefined();
    }
    expect(
      remoteSandboxGate('read-only', 'office_read', '/workspace', { path: 'a.docx' }).allowed,
    ).toBe(true);
    expect(
      remoteSandboxGate('read-only', 'office_edit', '/workspace', { path: 'a.docx' }).allowed,
    ).toBe(false);
    expect(
      remoteSandboxGate('workspace-write', 'office_edit', '/workspace', { path: 'a.docx' }).allowed,
    ).toBe(true);
    expect(
      remoteSandboxGate('workspace-write', 'doc_generate', '/workspace', {
        outputPath: '../outside.docx',
      }).allowed,
    ).toBe(false);
    await expect(
      service.tool('s', 'doc_generate', {
        format: 'docx',
        title: 'x',
        content: 'x',
        outputPath: '../outside.docx',
      }),
    ).rejects.toThrow('escapes');
  });
  it.each(['docx', 'xlsx', 'pptx'])(
    'roundtrips the full %s canvas file through capability-protected HTTP and remote storage',
    async (format) => {
      await service.tool('s', 'doc_generate', {
        format,
        title: 'Canvas',
        content: 'Original',
        outputPath: 'canvas.' + format,
      });
      const controller = new NativeOfficeController(native);
      const opened = await controller.open({
          path: '/workspace/canvas.' + format,
          remoteWorkspaceId: 'w',
        }),
        url = new URL(opened.url);
      const endpoint = url.origin + '/documents/' + opened.id;
      const headers = { 'X-Wing-Capability': url.hash.slice(1) };
      expect((await fetch(endpoint + '/file')).status).toBe(403);
      const loaded = Buffer.from(
        await (await fetch(endpoint + '/file', { headers })).arrayBuffer(),
      );
      expect(loaded.equals(readFileSync(join(root, 'canvas.' + format)))).toBe(true);
      const zip = await JSZip.loadAsync(loaded);
      zip.file('custom/canvas.txt', 'Full layout preserved');
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      expect(
        (await fetch(endpoint + '/file', { method: 'POST', headers, body: new Uint8Array(bytes) }))
          .status,
      ).toBe(200);
      expect(readFileSync(join(root, 'canvas.' + format)).equals(bytes)).toBe(true);
      expect(native.state(opened.id)).toMatchObject({ dirty: false, error: '' });
      expect(existsSync(join(directory, 'host-data', 'office-backups'))).toBe(false);
      await expect(native.open('../escape.docx', 'w')).rejects.toThrow('inside');
    },
  );
  it('retains an unsaved canvas during disconnect, reuses its session and saves after recovery without overwriting conflicts', async () => {
    await service.tool('s', 'doc_generate', {
      format: 'docx',
      title: 'Canvas',
      content: 'Original',
      outputPath: 'canvas.docx',
    });
    const opened = await native.open('canvas.docx', 'w');
    const zip = await JSZip.loadAsync(readFileSync(join(root, 'canvas.docx')));
    zip.file('custom/draft.txt', 'draft');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const request = service.request;
    service.request = jest.fn(async () => {
      throw Error('Disconnected');
    });
    await expect(native.save(opened.id, bytes)).rejects.toThrow('Disconnected');
    expect(native.state(opened.id)).toMatchObject({ dirty: true, error: 'Disconnected' });
    expect(() => native.release(opened.id)).toThrow('保存');
    expect((await native.open('canvas.docx', 'w')).id).toBe(opened.id);
    service.request = request;
    await native.save(opened.id, bytes);
    expect(native.state(opened.id)).toMatchObject({ dirty: false, error: '' });
    writeFileSync(join(root, 'canvas.docx'), 'external change');
    await expect(native.save(opened.id, bytes)).rejects.toThrow('changed');
    expect(readFileSync(join(root, 'canvas.docx'), 'utf8')).toBe('external change');
    expect(existsSync(join(directory, 'host-data', 'office-conflicts'))).toBe(false);
  });
  it('creates and imports canvas documents in the remote folder, uses unique names, and invalidates capabilities across accounts', async () => {
    await service.tool('s', 'doc_generate', {
      format: 'docx',
      title: 'Canvas',
      content: 'Original',
      outputPath: 'canvas.docx',
    });
    const opened = await native.open('canvas.docx', 'w'),
      url = new URL(opened.url);
    const endpoint = url.origin + '/documents/' + opened.id,
      headers = { 'X-Wing-Capability': url.hash.slice(1) };
    const bytes = readFileSync(join(root, 'canvas.docx'));
    for (const action of ['copy', 'import']) {
      const result = await fetch(endpoint + '/' + action + '?name=canvas.docx', {
        method: 'POST',
        headers,
        body: bytes,
      });
      expect(result.status).toBe(200);
      const data = (await result.json()) as any;
      expect(data.path).toMatch(/^\/workspace\/canvas \([23]\)\.docx$/);
      expect(readFileSync(join(root, data.name)).equals(bytes)).toBe(true);
    }
    const created = await fetch(endpoint + '/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '新文档', format: 'xlsx' }),
    });
    expect(created.status).toBe(200);
    expect(existsSync(join(root, '新文档.xlsx'))).toBe(true);
    expect(native.state(opened.id).navigation).toBe('/workspace/新文档.xlsx');
    expect(
      (
        await fetch(endpoint + '/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: '../escape', format: 'xlsx' }),
        })
      ).status,
    ).toBe(400);
    (service as any).identity = () => 'another-user';
    expect(() => native.state(opened.id)).toThrow('another account');
    expect((await fetch(endpoint + '/file', { headers })).status).toBe(400);
  });
  it('routes office_live to the bound remote canvas and retains read-only sandbox checks', async () => {
    await service.tool('s', 'doc_generate', {
      format: 'docx',
      title: 'Canvas',
      content: 'Original',
      outputPath: 'canvas.docx',
    });
    const opened = await native.open('canvas.docx', 'w'),
      url = new URL(opened.url),
      headers = { 'X-Wing-Capability': url.hash.slice(1) };
    const endpoint = url.origin + '/documents/' + opened.id;
    await fetch(endpoint + '/status', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ready: true }),
    });
    const live = createOfficeTools(((token: unknown) =>
      token === NativeOfficeService
        ? native
        : token === RemoteWorkspaceService
          ? service
          : undefined) as any).find((t) => t.name === 'office_live')!;
    expect(await service.tool('s', 'office_live', {})).toBeUndefined();
    const result = live.execute({ path: 'canvas.docx', action: 'read_selection' }, {
      sessionId: 's',
    } as any);
    const commands = (await (await fetch(endpoint + '/commands', { headers })).json()) as any;
    expect(commands.commands[0].action).toBe('read_selection');
    await fetch(endpoint + '/result', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: commands.commands[0].id, result: { text: '文宇' } }),
    });
    expect(await result).toMatchObject({ success: true, data: { result: { text: '文宇' } } });
    expect(
      remoteSandboxGate('read-only', 'office_live', '/workspace', {
        path: 'canvas.docx',
        action: 'read_selection',
      }).allowed,
    ).toBe(true);
    expect(
      remoteSandboxGate('read-only', 'office_live', '/workspace', {
        path: 'canvas.docx',
        action: 'insert_text',
      }).allowed,
    ).toBe(false);
    expect(
      remoteSandboxGate('workspace-write', 'office_live', '/workspace', {
        path: '../outside.docx',
        action: 'insert_text',
      }).allowed,
    ).toBe(false);
  });
});
