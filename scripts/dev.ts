import { spawn, type ChildProcess } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';

const children: ChildProcess[] = [];
// M-G12 fix: 跟踪是否正在关闭，避免重复 shutdown；跟踪已退出的子进程数量。
let shuttingDown = false;

async function main() {
  console.log('Starting development mode...');

  const packagesDir = join(process.cwd(), 'packages');
  const packages = await readdir(packagesDir);

  for (const pkg of packages) {
    console.log(`Starting ${pkg} in dev mode...`);
    const child = spawn('pnpm', ['dev'], {
      cwd: join(packagesDir, pkg),
      stdio: 'inherit',
      shell: true,
    });
    children.push(child);

    // L-G9 fix: 为每个子进程添加 error 和 exit 事件处理。
    // 之前无任何处理，子进程崩溃时主进程不退出也不报错（M-G12 同型问题）。
    child.on('error', (err) => {
      console.error(`[${pkg}] Child process error:`, err.message);
      shutdown();
    });
    child.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`[${pkg}] Child process exited with code ${code}`);
        shutdown();
      } else if (signal) {
        console.warn(`[${pkg}] Child process killed by signal ${signal}`);
      }
    });
  }

  // Handle graceful shutdown
  const shutdown = () => {
    // M-G12 fix: 重入保护，避免多次调用 shutdown 导致混乱。
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down development servers...');

    // M-G12 fix: 先向所有子进程发送 SIGTERM，等待它们退出后再 process.exit(0)。
    // 之前立即 process.exit(0) 导致子进程成为孤儿进程。
    let exited = 0;
    const total = children.length;
    const forcedExitTimer = setTimeout(() => {
      // 兜底：5 秒后仍有子进程未退出，强制 SIGKILL 后退出。
      console.warn('Forcing kill of remaining child processes...');
      for (const child of children) {
        try { child.kill('SIGKILL'); } catch {}
      }
      process.exit(0);
    }, 5000);

    if (total === 0) {
      clearTimeout(forcedExitTimer);
      process.exit(0);
    }

    for (const child of children) {
      // 监听 exit 以便在所有子进程退出后干净退出主进程。
      child.once('exit', () => {
        exited++;
        if (exited >= total) {
          clearTimeout(forcedExitTimer);
          console.log('All child processes exited.');
          process.exit(0);
        }
      });
      try {
        child.kill('SIGTERM');
      } catch {
        // kill 失败时计数仍需推进，否则主进程会等到强制退出定时器触发。
        exited++;
        if (exited >= total) {
          clearTimeout(forcedExitTimer);
          process.exit(0);
        }
      }
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Dev mode failed:', err);
  process.exit(1);
});
