'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const failures = [];
for (const name of ['docx','pdf','pptx','xlsx','org-learning-ops-skill','web-dev','web-artisan']) {
 if (!fs.existsSync(path.join(root,'packages/web/skills',name,'SKILL.md'))) failures.push('Missing bundled skill: '+name);
}
for (const item of ['LICENSE','README.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md']) if (!fs.existsSync(path.join(root,item))) failures.push('Missing repository document: ' + item);
const extensionRoot = path.join(root,'packages/backend/src/extensions/bundled');
for (const name of fs.readdirSync(extensionRoot)) {
 const base=path.join(extensionRoot,name), file=path.join(base,'manifest.json');
 if (!fs.existsSync(file)) continue;
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 const guides=[...(manifest.guides || []),...Object.values(manifest.platformGuides || {}).flat()];
 for (const guide of guides) {
  const resolved=path.resolve(base,guide);
  if(!resolved.startsWith(base+path.sep) || !fs.existsSync(resolved)) failures.push('Missing or escaping guide: '+name+'/'+guide);
 }
}
const skip=new Set(['.git','node_modules','build','dist','target','gen','.source-check','.turbo','.pnpm-store','coverage']);
function walk(dir) {
 for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
  const file=path.join(dir,item.name), rel=path.relative(root,file).replaceAll('\\','/');
  if(item.isSymbolicLink()) continue;
  if(item.isDirectory()) { if(!skip.has(item.name)) walk(file);continue; }
  if(/\.(?:png|jpg|jpeg|gif|ico|woff2?|ttf|mp4|pdf)$/i.test(item.name) || fs.statSync(file).size>4_000_000) continue;
  const text=fs.readFileSync(file,'utf8');
  if(/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(text)) failures.push('Credential pattern: '+rel);
 }
}
walk(root);
if(failures.length) { console.error(failures.join('\n'));process.exitCode=1; }
else console.log('PASS public source scope, repository documents and extension guide references');
