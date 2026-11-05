#!/usr/bin/env node
'use strict';
// Both installed and development commands dispatch to the maintained CLI.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('./product-edition.cjs').configure();
if (process.platform !== 'win32' && ['install-cli', 'uninstall-cli'].includes(process.argv[2])) {
  try {
    require('./cli-registration.cjs')[process.argv[2] === 'install-cli' ? 'install' : 'uninstall']();
    console.log(process.argv[2] === 'install-cli' ? 'CLI 已注册，请重新打开终端。' : 'CLI 命令与 Wing 添加的 PATH 配置已清理。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  return;
}
const roots = [path.resolve(__dirname, '../../backend/deploy/cli/dist/cli.js'), path.resolve(__dirname, '../../cli/dist/cli.js')];
const entry = roots.find(file => fs.existsSync(file));
if (!entry) {
  console.error('Wing CLI 运行时缺失，请修复安装；开发环境请先构建 packages/cli。');
  process.exitCode = 1;
} else {
  import(pathToFileURL(entry).href).catch(() => { console.error('Wing CLI 无法启动，请检查安装完整性与 Node.js 版本。'); process.exitCode = 1; });
}
