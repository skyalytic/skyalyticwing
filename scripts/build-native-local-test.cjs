const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const {audit,configForManifest,verifyManifest,digest}=require('./audit-installer-inputs.cjs');
const root=path.resolve(__dirname,'..'), target=process.env.TARGET;
const spec=require('../config/source-edition.json'), policy=require('../config/release-policy.json');
const version=require('../src-tauri/tauri.conf.json').version;
function run(bin,args){cp.execFileSync(bin,args,{cwd:root,stdio:'inherit',env:process.env});}
(async()=>{
 if(spec.edition!=='community'||policy.version!==version||policy.localTestPackagingAllowed!==true)throw Error('Not approved for this local-test build');
 if(!['aarch64-apple-darwin','x86_64-apple-darwin','x86_64-unknown-linux-gnu'].includes(target))throw Error('Unsupported target');
 const mac=process.platform==='darwin', sidecar='src-tauri/binaries/'+(mac?'node':'skyalyticwing-node')+'-'+target;
 if(!mac){
   // npm can retain optional musl binaries alongside glibc. linuxdeploy scans
   // every ELF resource, even variants that Sharp will never load on this target.
   if(process.platform!=='linux'||!process.report.getReport().header.glibcVersionRuntime)throw Error('Linux packages require a glibc build host');
   const modules=path.join(root,'packages/backend/deploy/node_modules');
   require('./prune-native-variants.cjs').pruneNativeVariants(path.dirname(modules),{os:'linux',cpu:'x64',libc:'glibc'});
   const sharp=require(path.join(modules,'sharp'));
   const png=await sharp({create:{width:2,height:2,channels:4,background:'#336699'}}).png().toBuffer();
   const metadata=await sharp(png).metadata();
   if(metadata.format!=='png'||metadata.width!==2||metadata.height!==2)throw Error('Bundled glibc Sharp image test failed');
   console.log('PASS: bundled glibc Sharp encodes and decodes PNG without musl variants');
   const {pathToFileURL}=require('node:url');
   const rolldown=await import(pathToFileURL(require.resolve('rolldown',{paths:[modules]})).href);
   const bundle=await rolldown.rolldown({input:'native-smoke',plugins:[{name:'native-smoke',resolveId:id=>id==='native-smoke'?id:null,load:id=>id==='native-smoke'?'export const value = 42;':null}]});
   try{const result=await bundle.generate({format:'es'});if(!result.output.some(item=>item.type==='chunk'&&item.code.includes('42')))throw Error('Bundled Rolldown native build failed');}finally{await bundle.close();}
   console.log('PASS: bundled glibc Rolldown builds a module');
 }
 run('node',['scripts/test-cli-registration.cjs']);
 run('node',['scripts/test-bundled-python.cjs','packages/backend/deploy']);
 run('node',['scripts/test-desktop-deploy.cjs','packages/backend/deploy',sidecar]);
 if(mac){run('python3',['scripts/sign-native-resources.py','packages/backend/deploy']);run('node',['scripts/test-bundled-ffmpeg.cjs','packages/backend/deploy/vendor/ffmpeg','--record-macos-signatures']);}
 const manifest=await audit(root,{target});
 const profile=require('./desktop-editions.cjs').profile('community');
 profile.bundle={...profile.bundle,createUpdaterArtifacts:false};
 if(mac){profile.bundle.icon=['icons/icon.icns'];profile.bundle.macOS={signingIdentity:'-',minimumSystemVersion:'15.0',entitlements:'./entitlements.mac.plist'};}
 const config=configForManifest(manifest,profile,root);
 fs.mkdirSync('.source-check/packaging-audit',{recursive:true});
 fs.writeFileSync('.source-check/packaging-audit/approved-manifest.json',JSON.stringify(manifest));
 // Tauri serializes overrides into TAURI_CONFIG. A 30k-file map exceeds Unix
 // ARG_MAX, so materialize precisely the approved files and keep the override small.
 const stage=path.join(root,'.source-check/packaging-audit/resources');
 fs.mkdirSync(stage,{recursive:true});
 for(const file of manifest.files){const dest=path.resolve(stage,file.target);if(!dest.startsWith(stage+path.sep))throw Error('Unsafe staging destination');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file.path),dest);fs.chmodSync(dest,fs.statSync(path.join(root,file.path)).mode);}
 config.bundle.resources={'../.source-check/packaging-audit/resources/':'.'};
 config.build.beforeBuildCommand='node scripts/verify-native-build-input.cjs';
 fs.writeFileSync('src-tauri/tauri.native-test.json',JSON.stringify(config));
 run('npx',['--yes','--package','@tauri-apps/cli@2.12.4','tauri','build','--verbose','--target',target,'--bundles',mac?'app':'deb,appimage','--config','src-tauri/tauri.native-test.json','--','--locked']);
 await verifyManifest(manifest,root);
 const release=path.join('src-tauri/target',target,'release');
 fs.mkdirSync('output',{recursive:true});
 const receipt={version,edition:spec.edition,target,localTest:true,checks:['isolated-backend-startup','cli-registration','bundled-python','payload-hashes','private-data-scan','fixed-edition'],artifacts:[]};
 if(!mac)receipt.checks.push('glibc-sharp-image-roundtrip','glibc-rolldown-transform','optional-native-platform-filter');
 if(mac){
   const app=path.join(release,'bundle/macos',spec.productName+'.app');
   run('codesign',['--verify','--deep','--strict',app]);
   run('node',['scripts/verify-native-payload.cjs',path.join(app,'Contents/Resources'),'.source-check/packaging-audit/approved-manifest.json']);
   const runtime=path.join(app,'Contents/MacOS/node'),deploy=path.join(app,'Contents/Resources/_up_/packages/backend/deploy');
   run('node',['scripts/test-desktop-deploy.cjs',deploy,runtime]);
   const stage=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'wing-dmg-'));
   run('ditto',[app,path.join(stage,spec.productName+'.app')]);
   fs.symlinkSync('/Applications',path.join(stage,'Applications'));
   const file='output/skyalyticwing_'+version+'_'+(target.startsWith('aarch64')?'arm64':'x64')+'.dmg';
   run('hdiutil',['create','-volname',spec.productName,'-srcfolder',stage,'-ov','-format','UDZO',file]);
   run('hdiutil',['verify',file]);
   receipt.checks.push('actual-app-payload','ad-hoc-signature','installed-backend-startup','dmg-integrity');
   receipt.artifacts.push({path:file,...await digest(file,file)});
 }else{
   const bundle=path.join(release,'bundle/deb'), files=fs.readdirSync(bundle).filter(n=>n.endsWith('.deb'));
   if(files.length!==1)throw Error('Expected one DEB');
   const file=path.join(bundle,files[0]),extracted=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'wing-deb-'));
   run('dpkg-deb',['-x',file,extracted]);
   const resource=path.join(extracted,'usr/lib',spec.linuxProductName);
   run('node',['scripts/verify-native-payload.cjs',resource,'.source-check/packaging-audit/approved-manifest.json']);
   run('node',['scripts/test-desktop-deploy.cjs',path.join(resource,'_up_/packages/backend/deploy'),path.join(extracted,'usr/bin/skyalyticwing-node')]);
   const dest='output/skyalyticwing_'+version+'_amd64.deb';fs.copyFileSync(file,dest);
   receipt.checks.push('actual-deb-payload','installed-backend-startup');receipt.artifacts.push({path:dest,...await digest(dest,dest)});
   const images=fs.readdirSync(path.join(release,'bundle/appimage')).filter(n=>n.endsWith('.AppImage'));
   if(images.length!==1)throw Error('Expected one AppImage; Linux publication requires both formats');
   const image=path.resolve(release,'bundle/appimage',images[0]);
   const imageExtract=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'wing-appimage-'));
   fs.chmodSync(image,0o755);
   const extractLog=fs.openSync(path.join(imageExtract,'extract.log'),'w');
   try {cp.execFileSync(image,['--appimage-extract'],{cwd:imageExtract,stdio:['ignore',extractLog,extractLog]});}finally{fs.closeSync(extractLog);}
   const initialAppdir=path.join(imageExtract,'squashfs-root');
   require('./restore-appimage-payload.cjs').restore(image,initialAppdir,path.join(initialAppdir,'usr/lib',spec.linuxProductName),manifest,root);
   const finalExtract=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'wing-appimage-final-'));
   const finalLog=fs.openSync(path.join(finalExtract,'extract.log'),'w');
   try{cp.execFileSync(image,['--appimage-extract'],{cwd:finalExtract,stdio:['ignore',finalLog,finalLog]});}finally{fs.closeSync(finalLog);}
   const appdir=path.join(finalExtract,'squashfs-root');
   const appResources=path.join(appdir,'usr/lib',spec.linuxProductName);
   run('node',['scripts/verify-native-payload.cjs',appResources,'.source-check/packaging-audit/approved-manifest.json']);
   run('node',['scripts/test-desktop-deploy.cjs',path.join(appResources,'_up_/packages/backend/deploy'),path.join(appdir,'usr/bin/skyalyticwing-node')]);
   const testProfile=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'wing-appimage-cli-'));
   const output=cp.execFileSync(path.join(appdir,'AppRun'),['--wing-cli','--version'],{cwd:appdir,encoding:'utf8',timeout:60000,
     env:{...process.env,APPDIR:appdir,HOME:testProfile,XDG_CONFIG_HOME:path.join(testProfile,'config'),XDG_DATA_HOME:path.join(testProfile,'data'),DISPLAY:''}});
   if(!output.split(/\r?\n/).some(line=>line.trim()===version))throw Error('AppImage CLI version check failed');
   const imageDest='output/skyalyticwing_'+version+'_amd64.AppImage';fs.copyFileSync(image,imageDest);fs.chmodSync(imageDest,0o755);
   receipt.checks.push('actual-appimage-payload','appimage-backend-startup','appimage-headless-cli');
   receipt.artifacts.push({path:imageDest,...await digest(imageDest,imageDest)});
 }
 fs.writeFileSync('output/package-receipt.json',JSON.stringify(receipt,null,2));
 console.log('PASS platform installer and runtime verification');
})().catch(e=>{console.error(e);process.exitCode=1;});
