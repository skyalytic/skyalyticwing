// Build-time metadata only. Never runs tool.execute or instantiates host services.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = path.join(root, 'packages/backend');
const host = { resolve: () => undefined };
const pick = t => ({ name: t.name, description: t.description, category: t.category, dangerous: t.dangerous === true });
(async () => {
  let count = 0;
  for (const dir of fs.readdirSync(path.join(base, 'src/extensions/bundled'))) {
    const file = path.join(base, 'src/extensions/bundled', dir, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file));
    const entry = path.join(base, 'dist/extensions/bundled', dir);
    const instance = await require(path.join(entry, 'index.js')).activate(host);
    let tools = instance.tools.map(pick);
    if (dir === 'computer-use') {
      // Both native platform inventories are declared independently of the build machine.
      assert.equal(process.platform, 'win32', 'Regenerate the cross-platform computer-use catalog on Windows');
      tools = tools.map(t => t.name === 'computer_use_confirm' ? t : { ...t, platforms: ['win32'] });
      tools.push({ ...pick(require(path.join(entry, 'tool.js')).createComputerUseTool(host.resolve)), platforms: ['darwin', 'linux'] });
    }
    await instance.dispose?.();
    if (process.argv.includes('--check')) assert.deepEqual(manifest.tools, tools, `Catalog drift in ${dir}`);
    else fs.writeFileSync(file, JSON.stringify({ ...manifest, tools }, null, 2) + '\n');
    count += tools.filter(t => !t.platforms || t.platforms.includes(process.platform)).length;
  }
  console.log(JSON.stringify({ catalogTools: count, checked: process.argv.includes('--check') }));
})().catch(error => { console.error(error); process.exitCode = 1; });
