// Generate reviewed build input only; never invokes Cargo, installers or uploads.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { editions, profile } = require('./desktop-editions.cjs');
const { edition } = require('./source-edition.cjs').configure();
const {audit,configForManifest} = require('./audit-installer-inputs.cjs');
async function main() {
  if (!editions[edition]) throw Error('Invalid source edition');
  const root=path.resolve(__dirname,'..');
  let config=profile(edition);
  if (process.argv.includes('--prebuilt-macos')) {
    const ci=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.ci-macos.json'),'utf8'));
    config.build={...config.build,...ci.build};
    config.bundle={...config.bundle,...ci.bundle};
    if (!/^(aarch64|x86_64)-apple-darwin$/.test(process.env.TARGET || '')) throw Error('TARGET must identify the prepared macOS runtime');
    // Export must already carry the right edition. Never relabel another product's deployment.
    const manifest=await audit(root,{target:process.env.TARGET});
    const dir=path.join(root,'.source-check/packaging-audit');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'approved-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    config=configForManifest(manifest,config,root);
  }
  fs.writeFileSync(path.join(root,'src-tauri/tauri.edition-runtime.json'),JSON.stringify(config,null,2)+'\n');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

