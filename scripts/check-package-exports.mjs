import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Validate the published contract, not just whether the compiler exited zero.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
for (const dir of readdirSync(resolve(root, 'packages'))) {
  const packageDir = resolve(root, 'packages', dir);
  const manifestPath = resolve(packageDir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [subpath, conditions] of Object.entries(manifest.exports || {})) {
    for (const [condition, target] of Object.entries(conditions)) {
      if (typeof target !== 'string') continue;
      const file = resolve(packageDir, target);
      if (!existsSync(file)) throw new Error(`${manifest.name}${subpath}: missing ${condition} target ${target}; run pnpm build first`);
      if (condition === 'import' || condition === 'require') await import(pathToFileURL(file).href);
      checked++;
    }
  }
}
console.log(`Validated ${checked} package export targets (including runtime imports).`);
