const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'.source-check/packaging-audit/approved-manifest.json'),'utf8'));
require('./audit-installer-inputs.cjs').verifyManifest(manifest,root).then(()=>cp.execFileSync(process.execPath,['scripts/verify-native-payload.cjs','.source-check/packaging-audit/resources','.source-check/packaging-audit/approved-manifest.json'],{cwd:root,stdio:'inherit'})).catch(e=>{console.error(e);process.exitCode=1;});
