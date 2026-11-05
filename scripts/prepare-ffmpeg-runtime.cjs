// Build-time acquisition only. Runtime never downloads dependencies or modifies PATH.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const config = require('../config/ffmpeg-runtime.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function download(url, digest, cache) {
  fs.mkdirSync(cache, {recursive:true});
  const file = path.join(cache, digest + (url.endsWith('.zip') ? '.zip' : url.endsWith('.xz') ? '.tar.xz' : '.tar.gz'));
  if (fs.existsSync(file) && sha(file) === digest) return file;
  const response = await fetch(url, {signal:AbortSignal.timeout(300_000)});
  if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
  const temporary = file + '.' + crypto.randomUUID() + '.partial';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, {flags:'wx'}));
  if (sha(temporary) !== digest) throw Error('FFmpeg download checksum mismatch: ' + temporary);
  fs.renameSync(temporary, file);
  return file;
}
function extract(archive, directory) {
  const entries = execFileSync('tar', ['-tf', archive], {encoding:'utf8', maxBuffer:16*1024*1024});
  for (const name of entries.split('\n').filter(Boolean)) {
    if (/^[\\/]|^[a-z]:/i.test(name) || name.replaceAll('\\','/').split('/').includes('..')) throw Error('Unsafe archive path');
  }
  fs.mkdirSync(directory, {recursive:true});
  execFileSync('tar', ['-xf', archive, '-C', directory], {stdio:'inherit',windowsHide:true});
  const roots = fs.readdirSync(directory);
  if (roots.length !== 1) throw Error('Expected one FFmpeg archive root');
  return path.join(directory, roots[0]);
}
function inventory(directory, relative = '') {
  return fs.readdirSync(path.join(directory,relative),{withFileTypes:true}).flatMap(entry => {
    const name = path.join(relative,entry.name);
    if (entry.isSymbolicLink()) throw Error('Unexpected runtime symlink');
    return entry.isDirectory() ? inventory(directory,name) : [{path:name.replaceAll('\\','/'),sha256:sha(path.join(directory,name))}];
  });
}
async function prepare(deploy) {
  const target = process.platform + '-' + process.arch;
  const recipe = config.targets[target];
  if (!recipe) throw Error('Unsupported FFmpeg target: ' + target);
  const destination = path.join(path.resolve(deploy), 'vendor', 'ffmpeg');
  if (fs.existsSync(destination)) {
    const previous = JSON.parse(fs.readFileSync(path.join(destination,'runtime.json'),'utf8'));
    if (previous.source?.commit !== config.source.commit || previous.recipe?.sha256 !== recipe.sha256) throw Error('Existing FFmpeg runtime differs from pinned version; regenerate the deploy directory');
    require('./test-bundled-ffmpeg.cjs').verify(destination);
    return destination;
  }
  const cache = path.join(root,'build','ffmpeg-cache');
  const sourceArchive = await download(config.source.url,config.source.sha256,cache);
  const work = fs.mkdtempSync(path.join(os.tmpdir(),'wing-ffmpeg-build-'));
  const source = extract(sourceArchive,path.join(work,'source'));
  const stage = path.join(work,'runtime');
  fs.mkdirSync(path.join(stage,'bin'),{recursive:true});
  let configure;
  if (recipe.buildFromSource) {
    if (process.platform !== 'darwin') throw Error('macOS runtime must be built on macOS');
    configure = ['--prefix='+stage,'--disable-gpl','--disable-nonfree','--disable-autodetect','--disable-doc','--disable-ffplay','--disable-debug','--disable-x86asm','--enable-static','--disable-shared'];
    const buildEnv = {...process.env,MACOSX_DEPLOYMENT_TARGET:'15.0'};
    execFileSync('/bin/sh',['configure',...configure],{cwd:source,stdio:'inherit',env:buildEnv});
    execFileSync('make',['-j',String(Math.max(1,os.availableParallelism()))],{cwd:source,stdio:'inherit',env:buildEnv});
    for (const name of ['ffmpeg','ffprobe']) {fs.copyFileSync(path.join(source,name),path.join(stage,'bin',name));fs.chmodSync(path.join(stage,'bin',name),0o755);}
  } else {
    const archive = await download(recipe.url,recipe.sha256,cache);
    const extracted = extract(archive,path.join(work,'binaries'));
    for (const file of fs.readdirSync(path.join(extracted,'bin'))) {
      if (/^ffmpeg(?:\.exe)?$|^ffprobe(?:\.exe)?$|\.dll$/i.test(file)) {
        fs.copyFileSync(path.join(extracted,'bin',file),path.join(stage,'bin',file));
        if (process.platform !== 'win32') fs.chmodSync(path.join(stage,'bin',file),0o755);
      }
    }
    fs.copyFileSync(path.join(extracted,'LICENSE.txt'),path.join(stage,'BINARY-LICENSE.txt'));
  }
  for (const file of ['LICENSE.md','COPYING.LGPLv2.1','COPYING.LGPLv3']) {
    if (fs.existsSync(path.join(source,file))) fs.copyFileSync(path.join(source,file),path.join(stage,file));
  }
  fs.copyFileSync(sourceArchive,path.join(stage,'ffmpeg-source.tar.gz'));
  fs.writeFileSync(path.join(stage,'NOTICE.txt'),`Wing includes the separate FFmpeg and ffprobe executables. Copyright belongs to the FFmpeg contributors and their dependencies.\nFFmpeg source commit: ${config.source.commit}\nCorresponding FFmpeg source archive: ffmpeg-source.tar.gz\nBinary build: ${recipe.url || 'Built from bundled source on macOS'}\nUpstream build recipes and dependency source instructions: ${config.buildRecipes.url}\nLicense: ${recipe.license || 'LGPL-2.1-or-later'}; see included license files.\nThese components can be replaced independently of Wing.\n`);
  const extension = process.platform==='win32'?'.exe':'';
  const version = execFileSync(path.join(stage,'bin','ffmpeg'+extension),['-version'],{encoding:'utf8',windowsHide:true});
  if (/--enable-gpl|--enable-nonfree/.test(version)) throw Error('Unexpected GPL/nonfree FFmpeg build');
  fs.writeFileSync(path.join(stage,'BUILD-CONFIGURATION.txt'),version+'\n'+(configure ? JSON.stringify(configure):config.buildRecipes.url)+'\n');
  fs.writeFileSync(path.join(stage,'runtime.json'),JSON.stringify({target,version:config.version,source:config.source,recipe,files:inventory(stage)},null,2));
  require('./test-bundled-ffmpeg.cjs').verify(stage);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  // Destination was absent. Preserve any existing runtime rather than silently replacing it.
  if (fs.existsSync(destination)) throw Error('FFmpeg runtime appeared while preparing');
  fs.cpSync(stage,destination,{recursive:true,errorOnExist:true,force:false});
  console.log('Bundled FFmpeg ready: '+destination);
  return destination;
}
module.exports = {prepare};
if (require.main === module) prepare(process.argv[2] || path.join(root,'packages/backend/deploy')).catch(error => {console.error(error);process.exitCode=1;});
