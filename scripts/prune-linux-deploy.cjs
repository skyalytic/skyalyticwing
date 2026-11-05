// npm 10 installs both GNU and musl optional packages on Linux. AppImage's
// dependency scanner cannot load musl binaries on the GNU build host.
const fs=require('node:fs'),path=require('node:path');
if(process.platform!=='linux'||!process.report.getReport().header.glibcVersionRuntime)throw Error('Requires a glibc Linux build host');
const deploy=path.resolve(process.argv[2]);
if(path.basename(deploy)!=='deploy'||!fs.existsSync(path.join(deploy,'package.json')))throw Error('Expected generated backend deploy directory');
for(const name of ['@img/sharp-libvips-linuxmusl-x64','@img/sharp-linuxmusl-x64','@rolldown/binding-linux-x64-musl']){
 const dir=path.join(deploy,'node_modules',name);
 if(!fs.existsSync(dir))continue;
 const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
 if(!pkg.libc?.includes('musl')||pkg.libc.includes('glibc'))throw Error('Unexpected platform package '+name);
 fs.rmSync(dir,{recursive:true});console.log('Excluded incompatible optional package '+name);
}
