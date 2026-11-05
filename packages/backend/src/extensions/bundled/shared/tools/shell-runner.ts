import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ToolResult } from '@skyalyticwing/shared';
import { ChatControlRegistry } from '../../../../modules/ai/chat/chat-control.registry.js';
import { watchProjectChanges } from '../../../../modules/tools/files/project-history-watch.js';

/** Process output is spooled to disk; preview size never terminates the process or loses its log. */
export async function runShell(executable: string, args: string[], options: {
  cwd: string; timeout?: number; sessionId: string; windowsVerbatimArguments?: boolean;
  signal?: AbortSignal; readOnly?: boolean; env?: NodeJS.ProcessEnv; separateStderr?: boolean;
}): Promise<ToolResult> {
  if (options.signal?.aborted) return { success: false, error: 'cancelled' };
  const tracking = options.readOnly ? undefined : watchProjectChanges(options.cwd);
  const directory = join(options.cwd, '.wing-terminal');
  let fd: number | undefined;
  let stderrFd: number | undefined;
  let stderrPreview = "";
  const outputPath = join(directory, randomUUID() + '.log');
  try { mkdirSync(directory, {recursive:true}); if (lstatSync(directory).isSymbolicLink()) throw new Error('Terminal log directory must not be a link'); fd = openSync(outputPath, 'wx', 0o600); if (options.separateStderr) stderrFd = openSync(outputPath + '.stderr', 'wx', 0o600); }
  catch (error) { if (fd !== undefined) closeSync(fd); if (stderrFd !== undefined) closeSync(stderrFd); tracking?.close(); return {success:false,error:'Cannot create terminal output log: ' + String(error)}; }
  return new Promise(resolve => {
    let reason = '', finished = false, preview = '', outputBytes = 0, previewPartial = false;
    let failure: NodeJS.ErrnoException | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, {
      cwd: options.cwd, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments,
      stdio: ['ignore','pipe','pipe'], detached: process.platform !== 'win32',
      ...(options.env ? {env: options.env} : {}),
    }); } catch (error) { closeSync(fd!); if (stderrFd !== undefined) closeSync(stderrFd); tracking?.close(); resolve({success:false,error:String(error)}); return; }
    const terminate = (why: string) => {
      if (finished || reason) return;
      reason = why;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true,stdio:'ignore'});
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code && !finished) child.kill(); });
      } else {
        const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); } };
        kill('SIGTERM');
        forceTimer = setTimeout(() => { if (!finished) kill('SIGKILL'); }, 5000);
        forceTimer.unref();
      }
    };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const remember = (text: string) => {
      preview += text;
      if (preview.length > 120_000) { previewPartial = true; preview = preview.slice(-120_000); }
    };
    const receive = (chunk: Buffer, index: number) => {
      try {
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(index === 1 && stderrFd !== undefined ? stderrFd : fd!, chunk, offset, chunk.length - offset);
        outputBytes += chunk.length;
        const decoded = decoders[index]!.write(chunk);
        if (index === 1 && stderrFd !== undefined) stderrPreview = (stderrPreview + decoded).slice(-120_000);
        else remember(decoded);
      } catch (error) { failure = error as NodeJS.ErrnoException; terminate('output-write-failed'); }
    };
    child.stdout!.on('data', (chunk: Buffer) => receive(chunk,0));
    child.stderr!.on('data', (chunk: Buffer) => receive(chunk,1));
    child.on('error', error => { failure = error; });
    const unsubscribe = ChatControlRegistry.onAbort(id => { if (!id || id === options.sessionId) terminate('cancelled'); });
    const abort = () => terminate('cancelled');
    options.signal?.addEventListener('abort', abort, {once:true});
    if (options.signal?.aborted) abort();
    // No built-in deadline. Explicit caller deadlines remain optional and support long durations.
    if (Number.isSafeInteger(options.timeout) && options.timeout! > 0) {
      const deadline = Date.now() + options.timeout!;
      const schedule = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) terminate('timeout');
        else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
      };
      schedule();
    }
    child.on('close', (exitCode, signal) => {
      finished = true; clearTimeout(timer); clearTimeout(forceTimer); unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      remember(decoders[0]!.end());
      if (stderrFd !== undefined) stderrPreview += decoders[1]!.end(); else remember(decoders[1]!.end());
      try { closeSync(fd!); if (stderrFd !== undefined) closeSync(stderrFd); } catch (error) { failure ??= error as NodeJS.ErrnoException; }
      tracking?.close();
      const warning = tracking?.warning;
      const error = failure?.message || reason || (exitCode !== 0 ? `Process exited with code ${exitCode}${signal ? ' (' + signal + ')' : ''}` : '');
      resolve({success: !error, output: (previewPartial ? `[仅展示末尾片段；完整输出未丢失，请用 file-read 分段读取 ${outputPath}]\n` : '') + preview,
        ...(error ? {error} : {}),
        data: { exitCode, errorCode: failure?.code, signal, cancelled: reason === 'cancelled', timedOut: reason === 'timeout',
          outputPath, outputBytes, previewPartial, ...(stderrFd !== undefined ? {stderrPath:outputPath + '.stderr',stderrPreview} : {}), ...(warning ? {warnings:[warning]} : {}) },
      });
    });
  });
}
