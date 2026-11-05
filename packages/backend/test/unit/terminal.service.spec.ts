import 'reflect-metadata';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TerminalService } from '../../src/modules/terminal/terminal.service.js';

/** 最小 security stub：TerminalService 只用 isPathAllowed */
function makeService(): TerminalService {
  return new TerminalService({ isPathAllowed: () => true } as never);
}

/** 轮询直到缓冲包含关键字或超时 */
async function waitOutput(svc: TerminalService, id: string, keyword: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  let data = '';
  while (Date.now() < deadline) {
    const r = svc.output(id, since);
    if (r.data.includes('\x1b[6n')) svc.input(id, '\x1b[1;1R', true);
    data += r.data;
    since = r.seq;
    if (data.includes(keyword)) return data;
    if (r.exited) throw new Error('终端进程提前退出: ' + data.slice(-200));
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`等待输出超时（${keyword}），最近输出: ${data.slice(-300)}`);
}

describe('TerminalService（持久 PowerShell 会话）', () => {
  it('缓冲区截断后游标持续递增，新输出仍可读且不重复', () => {
    const svc = makeService();
    const internal = svc as any;
    const dir=mkdtempSync(join(tmpdir(),'wing-terminal-buffer-'));
    const outputPath=join(dir,'output.log');writeFileSync(outputPath,'');
    const session = { id: 'buffer-test', outputPath, outputLength:0, exited: false, proc: null };
    internal.sessions.set(session.id, session);
    internal.append(session, 'x'.repeat(512 * 1024));
    const first = svc.output(session.id, 0);
    const rest = svc.output(session.id, first.seq);
    expect(first.data + rest.data).toBe('x'.repeat(512 * 1024));
    internal.append(session, 'new output');
    const second = svc.output(session.id, rest.seq);
    expect(second.data).toBe('new output');
    expect(second.seq).toBe(rest.seq + 'new output'.length);
    expect(svc.output(session.id, second.seq).data).toBe('');
    svc.close(session.id);rmSync(dir,{recursive:true,force:true});
  });

  it('初始 status：无会话', () => {
    expect(makeService().status()).toEqual({ sessions: 0 });
  });

  it('open：目录不存在抛错', () => {
    const svc = makeService();
    expect(() => svc.open('Z:\\__not_exists_dir__\\deep')).toThrow('目录不存在');
  });

  it('input/output/close：会话不存在抛可读错误', () => {
    const svc = makeService();
    expect(() => svc.input('nope', 'dir')).toThrow('终端会话不存在或已关闭');
    expect(() => svc.output('nope', 0)).toThrow('终端会话不存在或已关闭');
    expect(svc.close('nope')).toEqual({ closed: false });
  });

  it('真实会话：打开 → 执行命令 → 增量读取输出 → 关闭', async () => {
    const svc = makeService();
    const cwd = mkdtempSync(join(tmpdir(), 'sky-term-'));
    const { id, cwd: openedCwd } = svc.open(cwd);
    expect(id).toBeTruthy();
    expect(openedCwd).toBe(cwd);
    expect(svc.status().sessions).toBe(1);
    try {
      await svc.input(id, '$wingTestValue = 37001 + 49002; Write-Output $wingTestValue');
      const data = await waitOutput(svc, id, '86003');
      expect(data).toContain('86003');
      await svc.input(id, 'Write-Output ($wingTestValue + 7)');
      expect(await waitOutput(svc, id, '86010')).toContain('86010');

      // cwd 持久：cd 到上级后再 pwd 验证
      await svc.input(id, `Set-Location "${homedir()}"`);
      await svc.input(id, '(Get-Location).Path');
      await waitOutput(svc, id, homedir());
    } finally {
      expect(svc.close(id)).toEqual({ closed: true });
      expect(svc.status().sessions).toBe(0);
      expect(() => svc.output(id, 0)).toThrow('终端会话不存在或已关闭');
      await svc.onModuleDestroy();
    }
  }, 40_000);

  it('more than eight session records do not impose an artificial terminal cap', async () => {
    const svc = makeService();
    const internal = svc as unknown as { sessions: Map<string, unknown> };
    for (let i = 0; i < 8; i += 1) {
      internal.sessions.set(`fake-${i}`, {
        id: `fake-${i}`,
        cwd: tmpdir(),
        proc: null,
        buf: '',
        exited: true,
        createdAt: Date.now(),
      });
    }
    const dir=mkdtempSync(join(tmpdir(),'wing-terminal-extra-'));
    try {const opened=svc.open(dir);expect(opened.id).toBeTruthy();expect(svc.status().sessions).toBe(9);}
    finally {await svc.onModuleDestroy();rmSync(dir,{recursive:true,force:true});}
  }, 20000);

  it('onModuleDestroy 清理全部会话', async () => {
    const svc = makeService();
    svc.open(mkdtempSync(join(tmpdir(), 'sky-term-close-')));
    svc.open();
    const pids = [...(svc as any).sessions.values()].map((s:any) => s.proc.pid);
    expect(svc.status().sessions).toBe(2);
    await svc.onModuleDestroy();
    expect(svc.status().sessions).toBe(0);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});
