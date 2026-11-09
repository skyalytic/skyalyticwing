import {
  remoteLaunch,
  validateTarget,
} from '../../src/modules/core/remote-workspace/remote-connections';
import {
  remoteRuntimeShell,
  REMOTE_RUNTIME_ASSETS,
} from '../../src/modules/core/remote-workspace/remote-runtime';

describe('remote transports and runtime preparation', () => {
  it('uses Docker exec argv with stdin and only allocates a PTY for interactive terminals', () => {
    const target = { transport: 'docker' as const, target: 'worker-1' };
    expect(remoteLaunch(target, ['node', '-e', 'console.log("x")'])).toEqual({
      file: 'docker',
      args: ['exec', '-i', 'worker-1', 'node', '-e', 'console.log("x")'],
    });
    expect(remoteLaunch(target, ['sh'], true).args).toEqual(['exec', '-it', 'worker-1', 'sh']);
  });
  it.each(['--privileged', 'worker;touch x', 'user@host', 'a/b', 'worker\nbad', 'worker:latest'])(
    'rejects Docker option or shell input %s',
    (target) => {
      expect(() => validateTarget({ transport: 'docker', target })).toThrow();
    },
  );
  it('rejects irrelevant ports rather than silently changing their meaning', () => {
    expect(() => validateTarget({ transport: 'docker', target: 'worker', port: 22 })).toThrow();
    expect(() => validateTarget({ transport: 'wsl', target: 'Ubuntu', port: 22 })).toThrow();
  });
  it('quotes commands, pins every platform digest and isolates the managed runtime by edition', () => {
    const script = remoteRuntimeShell(['node', '-e', "console.log('literal $HOME')"]);
    expect(script).toContain("exec 'node' '-e' 'console.log('\\''literal $HOME'\\'')'");
    expect(script).toContain('/remote-runtime');
    expect(script).toContain('checksum mismatch');
    expect(script).toContain('trap cleanup EXIT');
    for (const asset of Object.values(REMOTE_RUNTIME_ASSETS)) {
      expect(asset.node[1]).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.rg[1]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(script).not.toMatch(/sudo|apt-get|yum install|systemctl/);
  });
});
