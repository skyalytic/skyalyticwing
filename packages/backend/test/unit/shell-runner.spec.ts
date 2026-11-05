import { runShell } from '../../src/modules/tools/executor/built-in/shell-runner';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

describe('non-blocking shell lifecycle (real child processes)', () => {
  let cwd:string;
  beforeEach(()=>{cwd=mkdtempSync(join(tmpdir(),'wing-shell-test-'));});
  afterEach(()=>{rmSync(cwd,{recursive:true,force:true});});
  (process.platform === 'win32' ? it : it.skip)('preserves quoted Windows command scripts and their failure status', async () => {
    const command = `"${process.execPath}" -e "console.log('quoted script');process.exit(7)"`;
    const r = await runShell('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, timeout: 5000, sessionId: 'shell-windows-quote', windowsVerbatimArguments: true });
    expect(r.success).toBe(false); expect(r.output).toContain('quoted script'); expect(r.data).toMatchObject({ exitCode: 7 });
  });
  it('preserves stdout, stderr and a failing exit code', async () => {
    const r = await runShell(process.execPath, ['-e', 'console.log("out");console.error("err");process.exit(7)'], { cwd, timeout: 5000, sessionId: 'shell-output-test' });
    expect(r.success).toBe(false); expect(r.output).toContain('out'); expect(r.output).toContain('err');
    expect(r.data).toMatchObject({ exitCode: 7, cancelled: false });
  });
  it('keeps the event loop responsive and stops only the requested session', async () => {
    const pending = runShell(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeout: 10_000, sessionId: 'shell-stop-test' });
    await new Promise(resolve => setTimeout(resolve, 100));
    ChatControlRegistry.requestAbort('unrelated');
    ChatControlRegistry.requestAbort('shell-stop-test');
    const r = await pending;
    expect(r.success).toBe(false); expect(r.data).toMatchObject({ cancelled: true, timedOut: false });
  });
  it('returns explicit timeout without reporting success', async () => {
    const r = await runShell(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeout: 100, sessionId: 'shell-timeout-test' });
    expect(r.success).toBe(false); expect(r.data).toMatchObject({ timedOut: true });
  });
  it('terminates the real child process on the task AbortSignal',async()=>{
    const abort=new AbortController();
    const pending=runShell(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd,timeout:10000,sessionId:'signal-test',signal:abort.signal});
    abort.abort();
    expect((await pending).data).toMatchObject({cancelled:true,timedOut:false});
  });
});
