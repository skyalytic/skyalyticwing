import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveAppVersion } from '../../src/modules/core/utils/app-version.util.js';

describe('runtime application version', () => {
  it('does not let the CLI workspace package override Wing version', () => {
    const previous = process.cwd(), dir = mkdtempSync(join(tmpdir(),'wing-version-'));
    const expected = JSON.parse(readFileSync(resolve(__dirname,'../../../../package.json'),'utf8')).version;
    writeFileSync(join(dir,'package.json'),JSON.stringify({name:'unrelated-project',version:'99.99.99'}));
    try { process.chdir(dir); expect(resolveAppVersion()).toBe(expected); }
    finally { process.chdir(previous); rmSync(dir,{recursive:true,force:true}); }
  });
});
