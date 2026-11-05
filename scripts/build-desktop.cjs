/* Build only after an audited, edition-local payload is ready. */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { validatePolicy, audit, configForManifest, verifyManifest, verifyNsis, digest } = require('./audit-installer-inputs.cjs');
async function main() {
  const args = process.argv.slice(2);
  const localTestIndex = args.indexOf('--local-test');
  const localTest = localTestIndex >= 0;
  if (localTest) args.splice(localTestIndex, 1);
  const editionIndex = args.indexOf('--edition');
  const edition = require('./source-edition.cjs').assertEdition(editionIndex < 0 ? undefined : args.splice(editionIndex, 2)[1]);
  validatePolicy(root);
  if (args.includes('--check')) {
    console.log('PASS native packaging resource policy and ' + edition + ' identity; installer build not started.');
    return;
  }
  const {version, policy} = require('./release-config.cjs').releaseConfig();
  if (policy.version !== version) throw Error('Packaging approval does not match the current version.');
  if (localTest ? policy.localTestPackagingAllowed !== true : policy.packagingAllowed !== true) throw Error('Installer packaging is locked until acceptance of the current application version.');
  if (args.some(arg => /^--config(?:=|$)|^-c/.test(arg))) throw Error('Edition config cannot be overridden through the packaging wrapper');
  if (args.some(arg => /^(?:--bundles(?:=|$)|--no-bundle$|--debug$|-b$|-d$)/.test(arg))) throw Error('Use the audited production bundle selected by this wrapper');
  const targetArg = args.find(arg=>arg.startsWith('--target='));
  const targetIndex = args.indexOf('--target');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = targetArg?.slice(9) || (targetIndex >= 0 ? args[targetIndex+1] : null) ||
    (process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? arch + '-apple-darwin' : arch + '-unknown-linux-gnu');
  if (!/^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/.test(target)) throw Error('Unsupported desktop target');
  if (targetIndex < 0 && !targetArg) args.push('--target',target);
  const product = require('../config/source-edition.json');
  const env = {...process.env, SKYALYTICWING_EDITION:edition,
    SKYALYTICWING_DEPLOY_SMOKE_PORT:String(product.port + 1000),
    CARGO_TARGET_DIR:path.join(root,'src-tauri/target',edition)};
  delete env.TAURI_CONFIG;
  function run(script) {
    const result = spawnSync(process.execPath,[path.join(__dirname,script)],{cwd:root,stdio:'inherit',windowsHide:true,env});
    if (result.error || result.status !== 0) throw Error(script + ' failed' + (result.error ? ': ' + result.error.message : ''));
  }
  run('prepare-node-sidecar.cjs');
  // This builds the frontend, backend and CLI and checks the isolated deployment.
  run('prepare-backend-deploy.cjs');
  const manifest = await audit(root,{target});
  const editionConfig = require('./desktop-editions.cjs').profile(edition);
  if (localTest) editionConfig.bundle = {...editionConfig.bundle,createUpdaterArtifacts:false};
  const config = configForManifest(manifest,editionConfig,root);
  const auditDir = path.join(root,'.source-check/packaging-audit');
  fs.mkdirSync(auditDir,{recursive:true});
  fs.writeFileSync(path.join(auditDir,'approved-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const configFile = path.join(auditDir,'tauri.audited.json');
  fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n');
  console.log('PASS reviewed payload: ' + manifest.totals.files + ' files; excluded ' + manifest.totals.excludedFiles + ' debug/cache files');
  const bundles = process.platform === 'win32' ? 'nsis' : process.platform === 'darwin' ? 'dmg' : 'deb,appimage';
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  const buildStartedAt = Date.now();
  const result = spawnSync(process.execPath,[cli,'build','--config',configFile,'--bundles',bundles,...args],{cwd:root,stdio:'inherit',windowsHide:true,env});
  if (result.error || result.status !== 0) throw Error('Native packaging failed' + (result.error ? ': ' + result.error.message : ''));
  await verifyManifest(manifest,root);
  const receipt = {edition,version,target,localTest,totals:manifest.totals,checks:['payload-hashes','private-data-scan','fixed-edition','required-runtime-files'],artifacts:[]};
  if (target.endsWith('windows-msvc')) {
    const release = path.join(env.CARGO_TARGET_DIR,target,'release');
    verifyNsis(fs.readFileSync(path.join(release,'nsis/x64/installer.nsi'),'utf8'),manifest,root);
    receipt.checks.push('actual-nsis-file-list');
    const name = editionConfig.productName + '_' + version + '_' + (target.startsWith('aarch64') ? 'arm64' : 'x64') + '-setup.exe';
    const file = path.join(release,'bundle/nsis',name);
    if (fs.statSync(file).mtimeMs < buildStartedAt - 2000) throw Error('Installer output is stale');
    receipt.artifacts.push({path:path.relative(root,file),...await digest(file,name)});
  }
  fs.writeFileSync(path.join(auditDir,'package-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log('PASS native package input verification; receipt: ' + path.join(auditDir,'package-receipt.json'));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

