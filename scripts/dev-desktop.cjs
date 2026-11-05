const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { edition } = require('./source-edition.cjs').configure();
const root = path.resolve(__dirname, '..');
const result = spawnSync('cargo', ['tauri', 'dev', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, SKYALYTICWING_EDITION: edition, CARGO_TARGET_DIR: path.join(root, 'src-tauri/target') } });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
