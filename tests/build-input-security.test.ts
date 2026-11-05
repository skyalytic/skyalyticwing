import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

it.each(['file:../../..','file:vendor/local-package'])('validates local dependency locations in lockfiles: %s',dependency=>{
  const dir=mkdtempSync(join(tmpdir(),'wing-build-input-test-'));
  try {
    const deploy=join(dir,'packages/backend/deploy');mkdirSync(deploy,{recursive:true});
    // A valid snapshot includes the CLI lifecycle and bundled media build inputs.
    for (const name of ['packages/backend/deploy/cli/dist/cli.js','packages/backend/deploy/cli/dist/progress.js','packages/backend/deploy/cli/package.json','packages/web/bin/cli-registration.cjs','src-tauri/linux/postinst.sh','src-tauri/linux/postrm.sh','config/ffmpeg-runtime.json','scripts/prepare-ffmpeg-runtime.cjs','scripts/test-bundled-ffmpeg.cjs']) {
      const file=join(dir,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,name.endsWith('.json')?'{}':'');
    }
    writeFileSync(join(deploy,'package-lock.json'),JSON.stringify({packages:{'node_modules/local-package':{resolved:dependency}}}));
    const run=spawnSync(process.execPath,[resolve('scripts/check-native-build-input.cjs'),dir],{encoding:'utf8'});
    if(dependency.includes('vendor'))expect(run.status).toBe(0);
    else {expect(run.status).toBe(1);expect(run.stderr).toContain('outside vendor');}
  }finally {rmSync(dir,{recursive:true,force:true});}
});
