import 'reflect-metadata';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { FilesService } from '../../src/modules/tools/files/files.service.js';
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }));
describe('local file actions', () => {
  let folder: string, file: string, service: FilesService;
  const security = { isPathAllowed: jest.fn(() => true) };
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'wing-local-action-')); file = join(folder, "中文 $literal O'Brien.txt"); writeFileSync(file, 'fixture');
    service = new FilesService(security as any, {} as any);
    (spawn as jest.Mock).mockImplementation(() => { const child = Object.assign(new EventEmitter(), { unref: jest.fn() }); process.nextTick(() => { child.emit('spawn'); child.emit('exit', 0); }); return child; });
  });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); jest.clearAllMocks(); security.isPathAllowed.mockReturnValue(true); });
  it('passes a literal path to the native application and file manager', async () => {
    await expect(service.localAction(file, 'open')).resolves.toEqual({ success: true });
    const [command, args, options] = (spawn as jest.Mock).mock.calls[0];
    expect(options).toMatchObject({ windowsHide: true }); expect(options.shell).toBeUndefined();
    if (process.platform === 'win32') {
      const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      expect(command).toMatch(/powershell.exe$/); expect(script).toContain('Invoke-Item -LiteralPath'); expect(script).toContain("O''Brien.txt"); expect(script).toContain('$literal');
    } else expect(args).toContain(file);
    await service.localAction(file, 'reveal');
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('rejects missing, restricted and executable targets before launching anything', async () => {
    await expect(service.localAction(join(folder, 'missing.txt'), 'open')).rejects.toThrow('文件不存在');
    security.isPathAllowed.mockReturnValue(false);
    await expect(service.localAction(file, 'reveal')).rejects.toThrow('Path not allowed');
    security.isPathAllowed.mockReturnValue(true);
    const exe = join(folder, 'bad.cmd'); writeFileSync(exe, 'fixture');
    await expect(service.localAction(exe, 'open')).rejects.toThrow('选择编辑器');
    await expect(service.localAction('https://example.com', 'open')).rejects.toThrow('本地文件');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('reports an unavailable desktop application', async () => {
    (spawn as jest.Mock).mockImplementation(() => { const child = new EventEmitter(); process.nextTick(() => child.emit('error', new Error('ENOENT'))); return child; });
    await expect(service.localAction(file, 'open')).rejects.toThrow('默认应用');
  });
  it('reveals folders and passes special characters literally to Explorer without waiting for exit', async () => {
    if (process.platform !== 'win32') return;
    const child = Object.assign(new EventEmitter(), { unref: jest.fn() });
    (spawn as jest.Mock).mockImplementation(() => { process.nextTick(() => child.emit('spawn')); return child; });
    await expect(service.localAction(folder, 'reveal')).resolves.toEqual({ success: true });
    const [command, args, options] = (spawn as jest.Mock).mock.calls[0];
    expect(command).toMatch(/explorer\.exe$/);
    expect(args).toEqual([`/select,"${folder}"`]);
    expect(options).toMatchObject({ windowsVerbatimArguments: true });
    expect(options.shell).toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
    await service.localAction(file, 'reveal');
    expect((spawn as jest.Mock).mock.calls[1][1]).toEqual([`/select,"${file}"`]);
    await service.localAction(folder, 'open');
    expect((spawn as jest.Mock).mock.calls[2][1]).toEqual([`"${folder}"`]);
  });
});
