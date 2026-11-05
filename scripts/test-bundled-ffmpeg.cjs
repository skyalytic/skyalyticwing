// Non-generating smoke test. It never creates, converts, concatenates or submits video.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));
  if (manifest.target !== process.platform+'-'+process.arch) throw Error('Wrong FFmpeg platform/architecture');
  for (const item of manifest.files) {
    const file = path.resolve(directory,item.path);
    if (!file.startsWith(path.resolve(directory)+path.sep)) throw Error('Unsafe FFmpeg manifest path');
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== item.sha256) throw Error('FFmpeg runtime checksum mismatch: '+item.path);
  }
  const results = {};
  for (const name of ['ffmpeg','ffprobe']) {
    const binary = path.join(directory,'bin',name+(process.platform==='win32'?'.exe':''));
    const version = execFileSync(binary,['-version'],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,PATH:path.dirname(binary)}});
    if (!version.startsWith(name+' version ') || /--enable-gpl|--enable-nonfree/.test(version)) throw Error('Invalid FFmpeg build');
    results[name] = version.split('\n')[0];
  }
  const ffmpeg = path.join(directory,'bin','ffmpeg'+(process.platform==='win32'?'.exe':''));
  const formats = execFileSync(ffmpeg,['-hide_banner','-formats'],{encoding:'utf8',windowsHide:true,timeout:15000});
  if (!/concat/.test(formats) || !/mp4/.test(formats)) throw Error('Required concat/MP4 formats missing');
  console.log(JSON.stringify({target:manifest.target,verifiedFiles:manifest.files.length,systemPathRequired:false,...results}));
  return results;
}
module.exports={verify};
if(require.main===module) {try{
  const directory = path.resolve(process.argv[2]||'packages/backend/deploy/vendor/ffmpeg');
  if (process.argv.includes('--record-macos-signatures')) {
    if (process.platform!=='darwin') throw Error('macOS signatures require macOS');
    const file=path.join(directory,'runtime.json'), manifest=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const item of manifest.files) {
      if (!['bin/ffmpeg','bin/ffprobe'].includes(item.path)) continue;
      const binary=path.join(directory,item.path);
      execFileSync('codesign',['--verify','--strict',binary],{stdio:'inherit'});
      item.unsignedSha256 ||= item.sha256;
      item.sha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    }
    fs.writeFileSync(file,JSON.stringify(manifest,null,2));
  }
  verify(directory);
}catch(e){console.error(e);process.exitCode=1;}}
