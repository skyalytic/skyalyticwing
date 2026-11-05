// npm ships bundled dependencies; root overrides cannot replace those bundles.
// Apply narrowly pinned upstream security patches and retain an accurate SBOM lock.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const deploy=path.resolve(process.argv[2]||'packages/backend/deploy');
const npmDir=path.join(deploy,'node_modules/npm');
const file=path.join(npmDir,'package.json');
const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
delete pkg.devDependencies;delete pkg.workspaces;
Object.assign(pkg.dependencies,{'brace-expansion':'5.0.12','http-cache-semantics':'4.3.0',undici:'6.29.0','ip-address':'10.7.4','postcss-selector-parser':'7.1.6'});
fs.writeFileSync(file,JSON.stringify(pkg,null,2)+'\n');
const result=spawnSync(process.execPath,[path.join(npmDir,'bin/npm-cli.js'),'install','--prefix',npmDir,'--workspaces=false','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
const rootLockFile=path.join(deploy,'package-lock.json');
const rootLock=JSON.parse(fs.readFileSync(rootLockFile,'utf8'));
const npmLock=JSON.parse(fs.readFileSync(path.join(npmDir,'package-lock.json'),'utf8'));
for(const key of Object.keys(rootLock.packages))if(key.startsWith('node_modules/npm/node_modules/'))delete rootLock.packages[key];
for(const [key,value]of Object.entries(npmLock.packages)) {
  if(key)rootLock.packages['node_modules/npm/'+key]={...value,inBundle:true};
}
rootLock.packages['node_modules/npm'].dependencies=pkg.dependencies;
fs.writeFileSync(rootLockFile,JSON.stringify(rootLock,null,2)+'\n');
console.log('Bundled npm security patches applied.');
