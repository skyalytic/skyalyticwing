/**
 * prepare-python.cjs
 *
 * 准备"安装即用"的捆绑 Python 环境（Windows 嵌入式发行版）：
 *   1. 下载 python.org 官方 embeddable 包（缓存于 build/python-embed-src/）
 *   2. 解压到 build/python-embed/
 *   3. 改写 python3xx._pth：启用 site + Lib/site-packages（pip 可用的前提）
 *   4. 下载 get-pip.py 并用捆绑解释器安装 pip（python -m pip 随即可用）
 *
 * 使用：
 *   node scripts/prepare-python.cjs            # 幂等：已就绪则跳过
 *   node scripts/prepare-python.cjs --force    # 强制重新下载
 *
 * 产物：build/python-embed/python.exe（Windows）。macOS/Linux 由
 * prepare-unix-python.cjs 捆绑独立解释器，不依赖用户预装 Python。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const SRC_CACHE = path.join(ROOT, 'build', 'python-embed-src');
const TARGET_DIR = path.join(ROOT, 'build', 'python-embed');

/** 捆绑版本（3.12 稳定线，生态兼容最佳；升级时同步检查 ._pth 文件名） */
const PY_VERSION = '3.12.10';
const PY_MICRO = PY_VERSION.split('.').slice(0, 2).join(''); // "312"
const EMBED_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const FORCE = process.argv.includes('--force');

function log(msg) {
  console.log(`[prepare-python] ${msg}`);
}

function fail(msg) {
  console.error(`[prepare-python] FATAL: ${msg}`);
  process.exit(1);
}

function download(url, dest, redirects = 0) {
  if (redirects > 5) fail(`重定向过多: ${url}`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          file.close();
          fs.rmSync(dest, { force: true });
          resolve(download(res.headers.location, dest, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.rmSync(dest, { force: true });
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/** python.exe 真实可用（解释器可运行 + pip 可导入；解压/装 pip 中断时不误判就绪） */
function isReady() {
  const bin = path.join(TARGET_DIR, 'python.exe');
  if (!fs.existsSync(bin)) return false;
  try {
    execFileSync(bin, ['--version'], { timeout: 10_000, stdio: 'pipe', windowsHide: true });
    execFileSync(bin, ['-m', 'pip', '--version'], { timeout: 30_000, stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'win32') {
    log('非 Windows 平台：由 prepare-unix-python.cjs 捆绑解释器');
    return;
  }
  if (!FORCE && isReady()) {
    log(`捆绑 Python 已就绪（${TARGET_DIR}），跳过`);
    return;
  }

  fs.mkdirSync(SRC_CACHE, { recursive: true });

  // 1. 下载嵌入式包
  const zipPath = path.join(SRC_CACHE, `python-${PY_VERSION}-embed-amd64.zip`);
  const zipValid = (p) => fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024;
  if (FORCE || !zipValid(zipPath)) {
    log(`下载 ${EMBED_URL} ...`);
    fs.rmSync(zipPath, { force: true });
    try {
      await download(EMBED_URL, zipPath);
    } catch (e) {
      fail(`下载失败: ${e.message}（检查网络后重试，或手动放置 ${zipPath}）`);
    }
    if (!zipValid(zipPath)) fail(`下载内容异常（大小 ${fs.statSync(zipPath).size} 字节）: ${zipPath}`);
    log(`已下载: ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    log('使用缓存的嵌入式包 zip');
  }

  // 2. 清理目标目录并解压（Windows 10+ 自带 bsdtar 支持 zip）
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  log(`解压到 ${TARGET_DIR} ...`);
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', TARGET_DIR], { stdio: 'pipe', windowsHide: true, timeout: 120_000 });
  } catch {
    // tar 不可用时回退 PowerShell Expand-Archive
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${TARGET_DIR}' -Force"`,
      { stdio: 'pipe', timeout: 180_000 },
    );
  }
  if (!fs.existsSync(path.join(TARGET_DIR, 'python.exe'))) fail('解压后未找到 python.exe（zip 可能损坏，删除缓存 zip 后重试）');

  // 3. 改写 ._pth：启用 site + 指向 Lib/site-packages（pip 安装与第三方包导入的前提）
  const pthFile = path.join(TARGET_DIR, `python${PY_MICRO}._pth`);
  if (!fs.existsSync(pthFile)) fail(`._pth 文件缺失: ${pthFile}`);
  fs.writeFileSync(
    pthFile,
    ['python' + PY_MICRO + '.zip', '.', 'Lib/site-packages', '', 'import site', ''].join('\n'),
    'utf-8',
  );
  log(`已改写 ${path.basename(pthFile)}（启用 site-packages）`);

  // 4. 安装 pip
  log('下载 get-pip.py ...');
  const getPip = path.join(SRC_CACHE, 'get-pip.py');
  try {
    await download(GET_PIP_URL, getPip);
  } catch (e) {
    fail(`get-pip 下载失败: ${e.message}`);
  }
  log('安装 pip（一次性，约 10-30 秒）...');
  try {
    execFileSync(path.join(TARGET_DIR, 'python.exe'), [getPip, '--no-warn-script-location'], {
      stdio: 'pipe',
      timeout: 300_000,
      windowsHide: true,
    });
  } catch (e) {
    fail(`pip 安装失败: ${e.message}`);
  }

  // 5. 校验
  if (!isReady()) fail('捆绑 Python 校验失败');
  try {
    const ver = execFileSync(path.join(TARGET_DIR, 'python.exe'), ['-m', 'pip', '--version'], {
      stdio: 'pipe',
      timeout: 30_000,
      windowsHide: true,
    }).toString().trim();
    log(`pip 就绪: ${ver}`);
  } catch (e) {
    fail(`pip 可用性校验失败: ${e.message}`);
  }

  log(`捆绑 Python 就绪: ${TARGET_DIR}`);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
