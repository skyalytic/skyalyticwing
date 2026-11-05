// linuxdeploy rewrites RPATH in bundled runtime libraries. Preserve the audited
// application payload and keep linuxdeploy's platform libraries outside it.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const elf = file => { const fd=fs.openSync(file,'r'), b=Buffer.alloc(4); try {fs.readSync(fd,b,0,4,0);} finally {fs.closeSync(fd);} return b.equals(Buffer.from([127,69,76,70])); };
function restore(image, appdir, resources, manifest, root) {
  let restored=0;
  for (const entry of manifest.files) {
    const target=path.resolve(resources,entry.target), source=path.resolve(root,entry.path);
    if(!target.startsWith(path.resolve(resources)+path.sep)||!source.startsWith(path.resolve(root)+path.sep))throw Error('Unsafe payload path');
    if(hash(target)===entry.sha256)continue;
    if(fs.lstatSync(target).isSymbolicLink()||!elf(target)||!elf(source)||hash(source)!==entry.sha256)throw Error('Unexpected non-ELF payload change: '+entry.target);
    fs.copyFileSync(source,target);fs.chmodSync(target,fs.statSync(source).mode);restored++;
  }
  if(!restored)return;
  const offset=Number(cp.execFileSync(image,['--appimage-offset'],{encoding:'utf8'}).trim());
  if(!Number.isSafeInteger(offset)||offset<4096||offset>=fs.statSync(image).size)throw Error('Invalid AppImage runtime offset');
  const squash=path.join(path.dirname(appdir),'verified-payload.squashfs');
  cp.execFileSync('mksquashfs',[appdir,squash,'-noappend','-comp','gzip','-processors','2'],{stdio:'inherit'});
  const output=image+'.verified';
  const input=fs.openSync(image,'r'), out=fs.openSync(output,'wx',0o755), buffer=Buffer.alloc(1024*1024);
  try {
    let position=0;
    while(position<offset){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,offset-position),position);if(!n)throw Error('Truncated AppImage runtime');fs.writeSync(out,buffer,0,n);position+=n;}
    const payload=fs.openSync(squash,'r');
    try {let n;while((n=fs.readSync(payload,buffer,0,buffer.length,null)))fs.writeSync(out,buffer,0,n);}finally{fs.closeSync(payload);}
  }finally{fs.closeSync(input);fs.closeSync(out);}
  fs.renameSync(output,image);
  console.log('Restored '+restored+' audited ELF resources; rebuilt AppImage for fresh extraction and runtime validation');
}
module.exports={restore};
