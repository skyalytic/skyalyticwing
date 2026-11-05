import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_BASE_URL, normalizeBaseUrl } from './http.js';
import type { CliOptions } from './args.js';

/** A CLI-owned backend lives only as long as this invocation. Existing desktop servers are never stopped. */
export async function connectRuntime(options: CliOptions): Promise<() => Promise<void>> {
  const base = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  options.baseUrl = base;
  try {
    const response = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (response.ok || response.status === 401 || response.status === 403) return async () => {};
    throw new Error(`端口已被其他服务占用（HTTP ${response.status}）`);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof Error && error.name === 'TimeoutError'))
      throw error;
  }
  if (
    process.env['SKYALYTICWING_URL'] ||
    base !== normalizeBaseUrl(DEFAULT_BASE_URL) ||
    process.env['SKYALYTICWING_CLI_NO_AUTOSTART'] === '1'
  )
    throw new Error(`无法连接 ${base}；请启动 Wing 或指定正在运行的后端`);
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [
    resolve(here, '../../desktop-main.cjs'),
    resolve(here, '../../../backend/deploy/desktop-main.cjs'),
  ].find(existsSync);
  if (!entry) throw new Error('未找到本机后端运行时；请启动 Wing，或设置 --base-url');
  console.error('正在启动本机 Wing AI 服务…');
  const child = spawn(process.execPath, [entry, '--port', new URL(base).port || '80'], {
    cwd: dirname(entry),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
  });
  let bootError = '',
    exited = false;
  let interrupted = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    bootError = (bootError + chunk.toString()).slice(-2000);
  });
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (error) => {
    exited = true;
    bootError = error.message;
  });
  const stop = async () => {
    process.off('SIGINT', interruptStartup);
    if (exited) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && !exited; i++) await delay(100);
    if (!exited) child.kill('SIGKILL');
  };
  const interruptStartup = () => { interrupted = true; void stop(); };
  process.once('SIGINT', interruptStartup);
  for (let i = 0; i < 240 && !exited && !interrupted; i++) {
    await delay(250);
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(500),
        redirect: 'error',
      });
      if (!interrupted && (response.ok || response.status === 401 || response.status === 403)) {
        process.off('SIGINT', interruptStartup);
        return stop;
      }
    } catch {
      /* Wait for the owned runtime to bind. */
    }
  }
  await stop();
  if (interrupted) throw new Error('已取消启动 Wing 服务');
  throw new Error(`Wing 服务启动失败${bootError ? '；请查看本机后端日志' : ''}`);
}
