/**
 * prepare-backend-deploy.cjs
 *
 * 生成自包含的后端部署目录 packages/backend/deploy/，供 Tauri 打包使用。
 *
 * 背景：后端为 tsc 编译产物（nest build），运行时 require('@nestjs/core') 等
 * 生产依赖，而 pnpm workspace 的 node_modules 是符号链接布局，无法直接打进
 * 安装包。此前 tauri.conf.json resources 只带 backend/dist/，导致打包后
 * node 边车启动即报 "Cannot find module '@nestjs/core'" 崩溃（加载页超时）。
 *
 * 方案：以 vendor 目录 + npm file: 依赖的方式，在 deploy/ 内安装一份真实的
 * 生产 node_modules：
 *   1. 按拓扑顺序构建 shared → sdk → tools → providers → backend
 *   2. 将 workspace 包的 dist 与改写后的 package.json 放入 deploy/vendor/
 *      （workspace:* 依赖改写为 file: 相对路径，注入 files:["dist"]）
 *   3. 在 deploy/ 内 npm install --omit=dev 安装全部生产依赖（含原生模块
 *      sharp/canvas 的 Windows 预编译二进制）
 *   4. 拷贝 backend/dist 与原版 package.json
 *   5. Smoke 测试：真实拉起 deploy/dist/main.js 并轮询 /health，失败即非零退出，
 *      防止再次打出无法启动的安装包
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const { replaceBuildDirectory } = require('./replace-build-directory.cjs');
const { assertSingleApplication } = require('./assert-single-application.cjs');

require('./source-edition.cjs').configure();
const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'packages', 'backend');
const DEPLOY_DIR = path.resolve(process.env.SKYALYTICWING_DEPLOY_DIR || path.join(BACKEND_DIR, 'deploy'));
const serverOnly = process.argv.includes('--server-only');
if (process.platform === 'win32' && !serverOnly) {
  execFileSync(process.env.WING_BUILD_POWERSHELL || 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/prepare-windows-runtime.ps1')], { stdio: 'inherit', windowsHide: true });
}
const allowedRoot = process.env.SKYALYTICWING_DEPLOY_DIR ? path.resolve(os.tmpdir()) : BACKEND_DIR;
if (!DEPLOY_DIR.startsWith(allowedRoot + path.sep) || DEPLOY_DIR === allowedRoot || (process.env.SKYALYTICWING_DEPLOY_DIR && !path.basename(DEPLOY_DIR).startsWith('skyalyticwing-deploy-'))) throw new Error('Deployment output must be backend/deploy or a skyalyticwing-deploy-* directory beneath OS temp');
const VENDOR_DIR = path.join(DEPLOY_DIR, 'vendor', '@skyalyticwing');

/** workspace 包拓扑顺序（被依赖者在前） */
const WORKSPACE_PACKAGES = [
  { name: '@skyalyticwing/shared', dir: 'shared' },
  { name: '@skyalyticwing/sdk', dir: 'sdk' },
  { name: '@skyalyticwing/tools', dir: 'tools' },
  { name: '@skyalyticwing/providers', dir: 'providers' },
];

const SMOKE_PORT = Number(process.env.SKYALYTICWING_DEPLOY_SMOKE_PORT || 19219);

function log(msg) {
  console.log(`[prepare-backend-deploy] ${msg}`);
}

function exec(cmd, cwd, timeoutMinutes = 15) {
  execSync(cmd, { cwd, stdio: 'inherit', timeout: timeoutMinutes * 60 * 1000 });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* 忽略统计失败 */
  }
  return (total / 1024 / 1024).toFixed(1);
}

/** 将 workspace:* 等协议改写为 file: 相对路径（相对于 fromPkgDir 的 vendor 包） */
function rewriteWorkspaceDeps(deps, fromVendorDirRelativePrefix) {
  const out = {};
  for (const [name, range] of Object.entries(deps || {})) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      out[name] = `${fromVendorDirRelativePrefix}/${fromVendorDirRelativePrefix === 'file:..' ? name.split('/').pop() : name}`;
    } else {
      out[name] = range;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 拓扑构建
// ---------------------------------------------------------------------------
log('步骤 1/5: 构建 workspace 包与 backend ...');
exec('pnpm --filter @skyalyticwing/shared --filter @skyalyticwing/sdk --filter @skyalyticwing/tools --filter @skyalyticwing/providers --filter @skyalyticwing/backend --filter @skyalyticwing/frontend --filter @skyalyticwing/cli run build', ROOT, 40);

for (const pkg of [...WORKSPACE_PACKAGES, { name: '@skyalyticwing/backend', dir: 'backend' }]) {
  const entry = path.join(ROOT, 'packages', pkg.dir, 'dist');
  if (!fs.existsSync(entry)) {
    console.error(`[prepare-backend-deploy] FATAL: ${pkg.name} 构建产物缺失: ${entry}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. 清空并生成 deploy/vendor
// ---------------------------------------------------------------------------
log('步骤 2/5: 生成 vendor workspace 包 ...');
fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
fs.mkdirSync(VENDOR_DIR, { recursive: true });

for (const pkg of WORKSPACE_PACKAGES) {
  const srcDir = path.join(ROOT, 'packages', pkg.dir);
  const destDir = path.join(VENDOR_DIR, pkg.dir);

  copyRecursive(path.join(srcDir, 'dist'), path.join(destDir, 'dist'));

  const pkgJson = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf-8'));
  const vendorPkgJson = {
    name: pkg.name,
    version: pkgJson.version || '1.0.0',
    private: true,
    type: pkgJson.type || 'module',
    main: pkgJson.main,
    module: pkgJson.module,
    exports: pkgJson.exports,
    // 限制 npm file: 打包内容仅为 dist（防止 .gitignore 规则波及）
    files: ['dist'],
    dependencies: rewriteWorkspaceDeps(pkgJson.dependencies, 'file:..'),
  };
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(vendorPkgJson, null, 2));
  log(`  vendor: ${pkg.name} -> deploy/vendor/@skyalyticwing/${pkg.dir}`);
}

// ---------------------------------------------------------------------------
// 3. deploy/package.json + .npmrc + npm install
// ---------------------------------------------------------------------------
log('步骤 3/5: 安装生产依赖 (npm install --omit=dev) ...');
const backendPkgJson = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf-8'));

const deployPkgJson = {
  name: '@skyalyticwing/backend-deploy',
  version: backendPkgJson.version,
  private: true,
  type: 'commonjs',
  main: './dist/main.js',
  dependencies: rewriteWorkspaceDeps(backendPkgJson.dependencies, 'file:vendor'),
  overrides: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'desktop-dependency-overrides.json'), 'utf8')),
};
fs.writeFileSync(path.join(DEPLOY_DIR, 'package.json'), JSON.stringify(deployPkgJson, null, 2));
fs.copyFileSync(path.join(ROOT, 'deploy/vendor/xlsx-0.20.3.tgz'), path.join(DEPLOY_DIR, 'vendor/xlsx-0.20.3.tgz'));
deployPkgJson.dependencies.xlsx = 'file:vendor/xlsx-0.20.3.tgz';
fs.writeFileSync(path.join(DEPLOY_DIR, 'package.json'), JSON.stringify(deployPkgJson, null, 2));

// npmmirror 加速（含 canvas Windows 预编译二进制镜像）
fs.writeFileSync(
  path.join(DEPLOY_DIR, '.npmrc'),
  [
    'registry=https://registry.npmjs.org',
    'install-links=true',
    '',
  ].join('\n'),
);

// --install-links=true: file: 依赖以真实复制方式安装（默认行为是创建符号链接，
// 打包进安装目录后会指向构建机绝对路径而失效）
// 超时 40 分钟：预编译二进制正常下载时数分钟即完成；原生模块回退源码编译
// （此前 pdfjs-dist 拖入的 canvas@2 无 win32 预编译）会无限挂起，40 分钟
// 上限兜底防吊死（已从依赖中移除 pdfjs-dist 根除该问题）
exec('pnpm --package=npm@10.9.4 dlx npm install --install-links=true --omit=dev --no-audit --no-fund --prefer-offline --loglevel=warn', DEPLOY_DIR, 40);
// npm can hoist an overridden transitive dependency into a different parent's
// subtree on the first install. Reconcile the tree, then validate the lock used
// by clean Linux/macOS builds before producing installers.
exec('pnpm --package=npm@10.9.4 dlx npm install --install-links=true --omit=dev --no-audit --no-fund --prefer-offline --loglevel=warn', DEPLOY_DIR, 40);
execFileSync(process.execPath, [path.join(ROOT, 'scripts/harden-desktop-npm.cjs'), DEPLOY_DIR], { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60 * 1000 });
exec('pnpm --package=npm@10.9.4 dlx npm ci --dry-run --ignore-scripts --install-links=true --omit=dev --no-audit --no-fund --loglevel=error', DEPLOY_DIR, 5);

// 关键依赖落地校验（缺一个都无法启动）
for (const critical of ['@nestjs/core', '@skyalyticwing/shared', '@skyalyticwing/tools', '@skyalyticwing/providers', '@skyalyticwing/sdk']) {
  if (!fs.existsSync(path.join(DEPLOY_DIR, 'node_modules', ...critical.split('/')))) {
    console.error(`[prepare-backend-deploy] FATAL: 关键依赖未安装: ${critical}`);
    process.exit(1);
  }
}

// 装后瘦身：剔除运行时无用的包（每次构建 deploy 全量重装，在此统一清除）。
// 1) @types/* 类型声明包：纯 .d.ts（零 JS 文件、零 package.json main/exports
//    入口），运行时 require 物理上不可能成功，全部来自第三方 SDK 错误声明在
//    dependencies：
//      @types/node        ← protobufjs(@larksuiteoapi/node-sdk)、@anthropic-ai/sdk、openai
//      @types/node-fetch  ← @anthropic-ai/sdk、openai
//      @types/validator   ← class-validator
// 2) @img/sharp-wasm32：sharp 的 wasm32 平台变体，npm ls 标记 extraneous（孤儿
//    包，无任何依赖者）；Windows 运行时只加载 @img/sharp-win32-x64，wasm32 纯死重。
const typesDir = path.join(DEPLOY_DIR, 'node_modules', '@types');
if (fs.existsSync(typesDir)) {
  const removed = fs.readdirSync(typesDir).map((n) => `@types/${n}`);
  fs.rmSync(typesDir, { recursive: true, force: true });
  log(`装后瘦身: 移除运行时无用的类型声明包 -> ${removed.join(', ')}`);
}
const sharpWasm = path.join(DEPLOY_DIR, 'node_modules', '@img', 'sharp-wasm32');
if (fs.existsSync(sharpWasm)) {
  fs.rmSync(sharpWasm, { recursive: true, force: true });
  log('装后瘦身: 移除 Windows 上无用的 sharp wasm32 平台变体 -> @img/sharp-wasm32');
}

// ---------------------------------------------------------------------------
// 4. 拷贝 dist 与原版 package.json
// ---------------------------------------------------------------------------
log('步骤 4/5: 拷贝后端产物 ...');
assertSingleApplication(path.join(BACKEND_DIR, 'dist'), path.join(ROOT, 'packages/frontend/dist'));
replaceBuildDirectory(path.join(BACKEND_DIR, 'dist'), path.join(DEPLOY_DIR, 'dist'), DEPLOY_DIR);
fs.writeFileSync(path.join(DEPLOY_DIR, 'app-version.json'), JSON.stringify({
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
}));
copyRecursive(path.join(ROOT, 'packages/cli/dist'), path.join(DEPLOY_DIR, 'cli/dist'));
fs.writeFileSync(path.join(DEPLOY_DIR, 'cli/package.json'), JSON.stringify({
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf8')),
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
}, null, 2));
copyRecursive(path.join(ROOT, 'deploy', 'office-engine'), path.join(DEPLOY_DIR, 'office-installer'));
if (!serverOnly) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-office-wasm.cjs'), path.join(DEPLOY_DIR, 'office-wasm')], { stdio: 'inherit', timeout: 15 * 60 * 1000 });
fs.copyFileSync(path.join(ROOT, 'scripts', 'wing-tui.cjs'), path.join(DEPLOY_DIR, 'wing-tui.cjs'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'desktop-main.cjs'), path.join(DEPLOY_DIR, 'desktop-main.cjs'));
if (process.env.SKYALYTICWING_EDITION) {
  const edition = process.env.SKYALYTICWING_EDITION;
  const spec = require('./desktop-editions.cjs').editions[edition];
  if (!spec) throw Error('Invalid desktop edition');
  fs.writeFileSync(path.join(DEPLOY_DIR, 'product-edition.json'), JSON.stringify({ edition, ...spec }));
}
fs.copyFileSync(path.join(ROOT, 'scripts', 'update-recovery.cjs'), path.join(DEPLOY_DIR, 'update-recovery.cjs'));
// 覆盖为原版 package.json（还原 name/main 等元信息；dependencies 字段对运行无害）
// Keep the deploy manifest consistent with package-lock and installed file dependencies.
replaceBuildDirectory(path.join(ROOT, 'packages', 'frontend', 'dist'), path.join(DEPLOY_DIR, 'frontend'), DEPLOY_DIR);
fs.copyFileSync(path.join(ROOT, 'scripts', 'server-deploy.README.md'), path.join(DEPLOY_DIR, 'README.md'));

// ---------------------------------------------------------------------------
// 4.5 捆绑对应平台 Python：deploy/python/ 随 resources 进安装包
// ---------------------------------------------------------------------------
log('步骤 4.5: 捆绑 Python 环境 ...');
if (process.platform === 'win32' && !serverOnly) {
  exec('node scripts/prepare-python.cjs', ROOT, 15);
  const pySrc = path.join(ROOT, 'build', 'python-embed');
  if (!fs.existsSync(path.join(pySrc, 'python.exe'))) {
    console.error('[prepare-backend-deploy] FATAL: 捆绑 Python 未就绪（build/python-embed/python.exe 缺失）');
    process.exit(1);
  }
  log(`  复制捆绑 Python -> ${path.join(DEPLOY_DIR, 'python')}`);
  copyRecursive(pySrc, path.join(DEPLOY_DIR, 'python'));
} else if (!serverOnly) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/prepare-unix-python.cjs'), DEPLOY_DIR], {stdio:'inherit'});
} else {
  log('  服务端独立部署：跳过桌面 Python 捆绑');
}

// ---------------------------------------------------------------------------
// 5. Smoke 测试：拉起 deploy/dist/main.js 并轮询 /health
// ---------------------------------------------------------------------------
if (!serverOnly) execFileSync(process.execPath, [path.join(ROOT,'scripts/prepare-ffmpeg-runtime.cjs'),DEPLOY_DIR],{stdio:'inherit',windowsHide:true});
log('步骤 5/5: Smoke 测试 (临时端口 ' + SMOKE_PORT + ') ...');

const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyalyticwing-smoke-'));
const smokeToken = require('node:crypto').randomBytes(32).toString('hex');
const smokeRuntime = process.platform === 'win32' && !serverOnly
  ? path.join(ROOT, 'src-tauri/binaries/node-x86_64-pc-windows-msvc.exe') : process.execPath;
const child = spawn(smokeRuntime, [path.join(DEPLOY_DIR, 'desktop-main.cjs'), '--port', String(SMOKE_PORT)], {
  cwd: smokeDataDir, // No repository working-directory fallback during acceptance
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'comspec', 'temp', 'tmp', 'pathext'].includes(key.toLowerCase()))),
    NODE_ENV: 'production', PORT: String(SMOKE_PORT), SKYALYTICWING_HOST: '127.0.0.1',
    SKYALYTICWING_AUTH_TOKEN: smokeToken,
    SKYALYTICWING_WEB_DATA_DIR: smokeDataDir, APPDATA: smokeDataDir, LOCALAPPDATA: smokeDataDir,
    SKYALYTICWING_DATA_DIR: smokeDataDir, // 隔离用户数据，避免污染真实目录
  },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

let stdoutTail = [];
let stderrTail = [];
child.stdout.on('data', (d) => {
  const lines = d.toString().split('\n').filter(Boolean);
  stdoutTail.push(...lines);
  if (stdoutTail.length > 30) stdoutTail = stdoutTail.slice(-30);
});
child.stderr.on('data', (d) => {
  const lines = d.toString().split('\n').filter(Boolean);
  stderrTail.push(...lines);
  if (stderrTail.length > 30) stderrTail = stderrTail.slice(-30);
});

const cleanup = (exitCode) => {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  try {
    fs.rmSync(smokeDataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
  process.exit(exitCode);
};

const waitForHealth = async () => {
  // Match the native workbench's existing 120-second startup deadline.
  const started = Date.now();
  for (let i = 1; Date.now() - started < 120_000; i++) {
    if (child.exitCode !== null) {
      console.error('[prepare-backend-deploy] FATAL: 后端进程提前退出，exitCode=' + child.exitCode);
      console.error('--- stdout 尾部 ---\n' + stdoutTail.join('\n'));
      console.error('--- stderr 尾部 ---\n' + stderrTail.join('\n'));
      cleanup(1);
      return;
    }
    const ok = await fetch(`http://127.0.0.1:${SMOKE_PORT}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      const base = 'http://127.0.0.1:' + SMOKE_PORT;
      const secured = await fetch(base + '/api/automation/media/video-tasks', { headers: { Authorization: 'Bearer ' + smokeToken } });
      const unauthorized = await fetch(base + '/api/automation/media/video-tasks');
      const page = await fetch(base + '/');
      if (secured.status !== 200 || unauthorized.status !== 401 || page.status !== 200 || !(await page.text()).includes('<html')) {
        log('Deployment API/auth/frontend acceptance failed'); cleanup(1); return;
      }
      log('PASS: isolated deployment API, authentication and bundled frontend');
      log(`Smoke 测试通过: /health 200 (第 ${i} 次轮询)`);
      log(`deploy 目录就绪: ${DEPLOY_DIR} (node_modules ${dirSizeMB(path.join(DEPLOY_DIR, 'node_modules'))} MB)`);
      cleanup(0);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('[prepare-backend-deploy] FATAL: /health 轮询超时（120s），后端未能就绪');
  console.error('--- stdout 尾部 ---\n' + stdoutTail.join('\n'));
  console.error('--- stderr 尾部 ---\n' + stderrTail.join('\n'));
  cleanup(1);
};

waitForHealth();
