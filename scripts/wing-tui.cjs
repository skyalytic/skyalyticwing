#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = [path.join(__dirname, 'cli/dist/cli.js'), path.resolve(__dirname, '../packages/cli/dist/cli.js')].find(fs.existsSync);
if (!entry) { console.error('Wing CLI 运行时缺失，请修复安装。'); process.exitCode = 1; }
else import(pathToFileURL(entry).href).catch(() => { console.error('无法启动 Wing CLI'); process.exitCode = 1; });
