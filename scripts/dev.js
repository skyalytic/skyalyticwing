// H-G3 fix: 同步 dev.ts —— 增加 ChildProcess 跟踪与优雅关闭（SIGINT/SIGTERM）
import { spawn } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';
const children = [];
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
    }
    // Handle graceful shutdown
    const shutdown = () => {
        console.log('\nShutting down development servers...');
        for (const child of children) {
            child.kill();
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch(console.error);
