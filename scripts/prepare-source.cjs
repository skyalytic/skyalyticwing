// Install hooks only when this edition is checked out as its own Git repository.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.git'))) import('husky').then(m => { const result = m.default(); if (result) console.log(result); });
