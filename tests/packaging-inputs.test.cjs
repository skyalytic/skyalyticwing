'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {audit,configForManifest,verifyManifest,verifyNsis,validatePolicy,enumerate,digest,checkPath,omission} = require('../scripts/audit-installer-inputs.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'wing-package-audit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  function write(rel,value) {
    const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,typeof value==='object'?JSON.stringify(value):value);return file;
  }
  const product={edition:'community',identifier:'com.fixture.community',binaryName:'WingCommunity',dataDirectory:'WingCommunity',port:19111,cliCommand:'wing-community',updateEndpoint:'https://example.invalid/community'};
  const resources=['../packages/backend/deploy/','../packages/web/skills/'];
  const builtins=['packages/web/skills/example/SKILL.md','packages/web/skills/example/scripts/run.py','packages/web/skills/example/references/spec.md','packages/web/skills/example/assets/logo.svg'];
  write('config/source-edition.json',product);
  write('config/release-policy.json',{version:'2.0.2',packagingAllowed:false});
  write('package.json',{version:'2.0.2'});
  write('src-tauri/Cargo.toml','version = "2.0.2"\n');
  write('src-tauri/tauri.conf.json',{version:'2.0.2',identifier:product.identifier,mainBinaryName:product.binaryName,bundle:{resources}});
  write('config/packaging-inputs.json',{resources,embedded:['packages/frontend/public/desktop-startup.html'],builtins,required:['packages/backend/deploy/dist/main.js']});
  write('packages/backend/deploy/product-edition.json',product);
  write('packages/backend/deploy/app-version.json',{version:'2.0.2'});
  write('packages/backend/deploy/package.json',{version:'2.0.2'});
  write('packages/backend/deploy/dist/main.js','console.log("app");');
  write('packages/frontend/public/desktop-startup.html','<!doctype html>startup');
  for(const rel of builtins)write(rel,'fixture');
  return {root,write,product};
}
test('resource scope must match policy and remain inside its own edition',t=>{
 const f=fixture(t);validatePolicy(f.root);
 const c=JSON.parse(fs.readFileSync(path.join(f.root,'src-tauri/tauri.conf.json')));c.bundle.resources.push('../../企业版/packages/');
 f.write('src-tauri/tauri.conf.json',c);assert.throws(()=>validatePolicy(f.root),/reviewed packaging policy/);
});
test('user state, credentials and unexpected certificates fail closed',()=>{
 for(const rel of ['packages/x/.env','packages/x/.env.local','packages/x/.git/config','packages/x/sessions.json','packages/x/a.pfx','packages/x/API.txt','packages/x/data/state.json','packages/x/private.pem'])assert.throws(()=>checkPath(rel));
 assert.doesNotThrow(()=>checkPath('packages/backend/deploy/python/Lib/site-packages/pip/_vendor/certifi/cacert.pem'));
 assert.doesNotThrow(()=>checkPath('packages/web/skills/pptx/data/charts.csv',true));
 assert.throws(()=>checkPath('packages/web/skills/pptx/data/.env',true));
 assert.throws(()=>checkPath('packages/web/skills/pptx/data/unreviewed.csv'));
});
test('debug metadata is omitted but runtime sources, declarations and licenses are retained',t=>{
 const f=fixture(t);
 for(const rel of ['dist/main.js.map','node_modules/pty/pty.pdb','python/__pycache__/a.pyc'])f.write('packages/backend/deploy/'+rel,'cache');
 for(const rel of ['node_modules/typescript/lib/lib.dom.d.ts','node_modules/tool/src/index.ts','vendor/ffmpeg/LICENSE.txt','vendor/ffmpeg/ffmpeg-source.tar.gz'])f.write('packages/backend/deploy/'+rel,'runtime');
 return audit(f.root,{target:''}).then(m=>{
   assert.equal(m.excluded.length,3);
   for(const rel of ['scripts/run.py','references/spec.md','assets/logo.svg'])assert.ok(m.files.some(x=>x.path.endsWith(rel)));
   assert.ok(m.files.some(x=>x.path.endsWith('lib.dom.d.ts')));
   assert.ok(m.files.some(x=>x.path.endsWith('ffmpeg-source.tar.gz')));
   const c=configForManifest(m,{},f.root);assert.equal(Object.keys(c.bundle.resources).length,m.files.length);
   assert.ok(Object.values(c.bundle.resources).every(x=>x.startsWith('_up_/')));
   assert.deepEqual(c.build.frontendDist,['../packages/frontend/public/desktop-startup.html']);
 });
});
test('missing critical file, changed edition and unknown built-in each block packaging',async t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.root,'packages/backend/deploy/dist/main.js'));
 await assert.rejects(audit(f.root,{target:''}),/Required packaged file missing/);
 f.write('packages/backend/deploy/dist/main.js','fixed');
 f.write('packages/backend/deploy/product-edition.json',{...f.product,edition:'enterprise'});
 await assert.rejects(audit(f.root,{target:''}),/edition disagrees/);
 f.write('packages/backend/deploy/product-edition.json',f.product);
 f.write('packages/web/skills/example/accidental.txt','unexpected');
 await assert.rejects(audit(f.root,{target:''}),/Unreviewed built-in/);
});
test('secret-like values are detected without printing the value, even in omitted maps',async t=>{
 const f=fixture(t),secret='ghp_'+'Ab7'.repeat(15);
 const file=f.write('packages/backend/deploy/dist/private.js.map',JSON.stringify({sourcesContent:[secret]}));
 await assert.rejects(digest(file,'private.js.map'),e=>e.message.includes('redacted')&&!e.message.includes(secret));
 await assert.rejects(audit(f.root,{target:''}),/redacted/);
});
test('hash check rejects changed bytes and late-added payload files',async t=>{
 const f=fixture(t),m=await audit(f.root,{target:''});
 await verifyManifest(m,f.root);
 f.write('packages/backend/deploy/dist/main.js','changed');
 await assert.rejects(verifyManifest(m,f.root),/input changed/);
 f.write('packages/backend/deploy/dist/main.js','console.log("app");');
 f.write('packages/backend/deploy/dist/late.js','late addition');
 await assert.rejects(verifyManifest(m,f.root),/input changed/);
});
test('resource symlink to another tree is rejected',async t=>{
 const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'wing-outside-'));
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.writeFileSync(path.join(outside,'file.js'),'outside');
 fs.symlinkSync(outside,path.join(f.root,'packages/backend/deploy/escape'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(enumerate(f.root,['../packages/backend/deploy/']),/escapes/);
});
test('NSIS must use exactly the approved destination and source paths',()=>{
 const root=path.resolve(os.tmpdir(),'nsis-fixture'),rel='packages/backend/deploy/dist/main.js';
 const m={files:[{path:rel,target:'_up_/'+rel}],inputs:[]};
 const line=' File /a "/oname=_up_/'+rel+'" "'+path.join(root,rel)+'"\n';
 assert.doesNotThrow(()=>verifyNsis(line,m,root));
 assert.throws(()=>verifyNsis(line+line,m,root),/Duplicate/);
 assert.throws(()=>verifyNsis(line.replace('main.js','other.js'),m,root),/Unexpected/);
 assert.throws(()=>verifyNsis(line.replace(path.join(root,rel),path.join(os.tmpdir(),'outside.js')),m,root),/origin/);
 assert.throws(()=>verifyNsis('',m,root),/missing/);
 const sidecar='src-tauri/binaries/node-x86_64-pc-windows-msvc.exe';
 const withNode={...m,inputs:[{path:sidecar}]};
 assert.throws(()=>verifyNsis(line,withNode,root),/omitted Node/);
 const nodeLine=' File /a "/oname=node.exe" "'+path.join(root,sidecar)+'"\n';
 assert.doesNotThrow(()=>verifyNsis(line+nodeLine,withNode,root));
 assert.throws(()=>verifyNsis(line+nodeLine+nodeLine,withNode,root),/Duplicate/);
});
test('native symbols are excluded without removing native runtime binaries',()=>{
 assert.equal(omission('node_modules/pty/winpty.pdb'),'debug-metadata');
 for(const name of ['winpty.dll','pty.node','soffice.wasm','ffmpeg.exe','python312.zip','assets/world.map','assets/protein.pdb'])assert.equal(omission(name),null);
});
test('a token-shaped substring inside encoded data is not a standalone credential',async t=>{
 const f=fixture(t),rel='packages/backend/deploy/encoded.js';
 const file=f.write(rel,'const data = "'+'X'.repeat(5)+'AKIA'+'Z'.repeat(24)+'";');
 await assert.doesNotReject(digest(file,rel));
});
