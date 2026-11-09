import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  RemoteConnection,
  REMOTE_BOOTSTRAP,
} from '../../src/modules/core/remote-workspace/remote-connections';
import { downloadRemoteAsset } from '../../src/modules/core/remote-workspace/remote-runtime-assets';
jest.mock('../../src/modules/core/remote-workspace/remote-runtime-assets', () => ({
  downloadRemoteAsset: jest.fn(),
}));

describe('remote dependency relay before worker execution', () => {
  let root: string, connection: RemoteConnection | undefined;
  beforeEach(() => {
    jest.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'wing-relay-test-'));
  });
  afterEach(async () => {
    connection?.close();
    await new Promise((r) => setTimeout(r, 100));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error('Invalid fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  });
  it('relays a failed bootstrap asset then dispatches queued file writes exactly once', async () => {
    jest.mocked(downloadRemoteAsset).mockResolvedValue(Buffer.from('verified-archive'));
    let starts = 0;
    const factory = ((_file: any, _args: any, options: any) => {
      starts++;
      const code =
        starts === 1
          ? 'process.stderr.write("WING_RUNTIME_DOWNLOAD_FAILED:rg:x86_64-unknown-linux-musl");process.exitCode=1;'
          : starts === 2
            ? 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{process.exitCode=b==="verified-archive"?0:2;});'
            : REMOTE_BOOTSTRAP;
      return spawn(process.execPath, ['-e', code], options);
    }) as typeof spawn;
    connection = new RemoteConnection({ transport: 'docker', target: 'fixture' }, factory);
    const [result] = await Promise.all([
      connection.request(root, 'write', { path: 'once.txt', content: 'once', revision: null }),
      connection.request(root, 'write', { path: 'second.txt', content: 'second', revision: null }),
    ]);
    expect(result.revision).toBeDefined();
    expect(readFileSync(join(root, 'once.txt'), 'utf8')).toBe('once');
    expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('second');
    expect(starts).toBe(3);
    expect(downloadRemoteAsset).toHaveBeenCalledTimes(1);
    expect((await connection.request(root, 'read', { path: 'once.txt' })).content).toBe('once');
  });
  it('cancels during a download without starting an installer or replaying a request', async () => {
    let finish!: (value: Buffer) => void;
    jest.mocked(downloadRemoteAsset).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let starts = 0;
    const factory = ((_file: any, _args: any, options: any) => {
      starts++;
      return spawn(
        process.execPath,
        [
          '-e',
          'process.stderr.write("WING_RUNTIME_DOWNLOAD_FAILED:rg:x86_64-unknown-linux-musl");process.exitCode=1;',
        ],
        options,
      );
    }) as typeof spawn;
    connection = new RemoteConnection({ transport: 'docker', target: 'fixture' }, factory);
    const pending = connection.request(root, 'write', { path: 'never.txt', content: 'never' }),
      rejected = expect(pending).rejects.toThrow('cancelled');
    for (let i = 0; !finish && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
    expect(finish).toBeDefined();
    connection.close('cancelled');
    finish(Buffer.from('unused'));
    await rejected;
    await new Promise((r) => setTimeout(r, 50));
    expect(starts).toBe(1);
  });
  it('does not retry after a worker has acknowledged an operation', async () => {
    jest.mocked(downloadRemoteAsset).mockResolvedValue(Buffer.from('unused'));
    const factory = ((_file: any, _args: any, options: any) =>
      spawn(process.execPath, ['-e', REMOTE_BOOTSTRAP], options)) as typeof spawn;
    connection = new RemoteConnection({ transport: 'docker', target: 'fixture' }, factory);
    await connection.request(root, 'write', { path: 'once.txt', content: 'saved' });
    connection.close('disconnected');
    await expect(
      connection.request(root, 'write', { path: 'once.txt', content: 'unexpected' }),
    ).rejects.toThrow('closed');
    expect(readFileSync(join(root, 'once.txt'), 'utf8')).toBe('saved');
    expect(downloadRemoteAsset).not.toHaveBeenCalled();
  });
});
