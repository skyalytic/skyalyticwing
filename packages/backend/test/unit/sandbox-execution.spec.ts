import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { SandboxSystemService } from '../../src/modules/tools/sandbox/sandbox.service.js';
import { runShell } from '../../src/modules/tools/executor/built-in/shell-runner.js';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('../../src/modules/tools/executor/built-in/shell-runner.js', () => ({ runShell: jest.fn() }));

describe('process sandbox command boundary', () => {
  const execMock = execFile as unknown as jest.Mock;
  const runMock = runShell as jest.Mock;
  let service: SandboxSystemService;

  beforeEach(() => {
    process.env['SKYALYTICWING_ALLOW_UNISOLATED_EXECUTION'] = 'true';
    runMock.mockReset().mockResolvedValue({success:true,output:'ok',data:{exitCode:0}});
    execMock.mockReset().mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    service = new SandboxSystemService(
      { info: jest.fn() } as any,
      {
        isCommandAllowed: () => true,
      } as any,
    );
  });
  afterEach(() => {
    delete process.env['SKYALYTICWING_ALLOW_UNISOLATED_EXECUTION'];
  });

  it('fails closed when Docker is unavailable and fallback was not explicitly enabled', async () => {
    delete process.env['SKYALYTICWING_ALLOW_UNISOLATED_EXECUTION'];
    expect(await service.executeSafe('echo hi')).toMatchObject({
      success: false,
      code: 'ISOLATION_UNAVAILABLE',
    });
    expect(execMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('container execution disables network, drops capabilities and always cleans up', async () => {
    (service as any).security.isPathAllowed = () => true;
    await service.onModuleInit();
    execMock.mockClear();
    await service.executeSafe('echo hi', { cwd: process.cwd() });
    const args = runMock.mock.calls[0]?.[1];
    expect(args).toEqual(
      expect.arrayContaining([
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--pids-limit=128',
        '--mount',
      ]),
    );
    expect(execMock.mock.calls[0]?.[1]).toEqual(['rm', '-f', expect.stringMatching(/^sandbox-/)]);
  });

  it.each([
    'node -e "1" ; echo ok',
    'node -e "1" && echo ok',
    'echo ok | node',
    'env node -e "1"',
    'find . -exec node -v ";"',
    'find . -delete',
  ])('拒绝绕过白名单: %s', async (command) => {
    expect((await service.executeSafe(command)).success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('带空格的引号参数作为单一参数传给子进程', async () => {
    await service.executeSafe('echo "hello world"');
    expect(runMock.mock.calls[0]?.slice(0, 2)).toEqual(['echo', ['hello world']]);
    expect(runMock.mock.calls[0]?.[2]).toMatchObject({timeout:0,readOnly:true});
  });
});
