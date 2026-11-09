const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const { releaseConfig, assertPublish } = require('./release-config.cjs');
const {version, baseUrl} = releaseConfig();
assertPublish(version);
if (!process.argv[2]) throw Error('Supply the verified artifact directory');
const root=path.resolve(process.argv[2]);
const definitions=[
 [`Windows/SkyalyticWing_${version}_x64-setup.exe`,'windows','下载 Windows x64','windows-x86_64'],
 [`Linux/SkyalyticWing_${version}_amd64.deb`,'linux','下载 DEB',''],
 [`Linux/SkyalyticWing_${version}_amd64.AppImage`,'linux','下载 AppImage','linux-x86_64'],
 [`MacOS/SkyalyticWing_${version}_arm64.dmg`,'macos','下载 Apple Silicon',''],
 [`MacOS/SkyalyticWing_${version}_x64.dmg`,'macos','下载 Intel',''],
 [`MacOS/SkyalyticWing_${version}_arm64.app.tar.gz`,'macos','Apple Silicon 自动更新','darwin-aarch64'],
 [`MacOS/SkyalyticWing_${version}_x64.app.tar.gz`,'macos','Intel 自动更新','darwin-x86_64'],
];
const publishedAt=new Date().toISOString(),base=baseUrl,platforms={};
const files=definitions.map(([file,platform,label,target])=>{
 const full=path.join(root,file);if(fs.statSync(full).size<10_000_000)throw Error('Unexpected artifact size: '+file);
 cp.execFileSync(process.execPath,['scripts/verify-release-signature.cjs',full],{stdio:'pipe'});
 const data=fs.readFileSync(full),signature=fs.readFileSync(full+'.sig','utf8').trim();
 const item={file,platform,label,url:base+file,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
 if(target)platforms[target]={url:item.url,signature};return item;
});
fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),files.map(f=>f.sha256+'  '+f.file).join('\n')+'\n');
fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify({version,publishedAt,status:'release',files},null,2));
const readme=fs.readFileSync(path.join(__dirname,'../README.zh-CN.md'),'utf8');
const block=readme.split(/^## /m).find(part=>part.split(/\r?\n/,1)[0].trim()===version+' 更新');
const section=block ? version+'\n'+block.slice(block.indexOf('\n')+1).trim() : '';
if(!section)throw Error('Release changelog section missing');
fs.writeFileSync(path.join(root,'CHANGELOG.txt'),section.trim()+'\n');
fs.writeFileSync(path.join(root,'wing-release.json'),JSON.stringify({version,publishedAt,files:files.filter(f=>!f.file.endsWith('.app.tar.gz')),checksumsUrl:base+'SHA256SUMS.txt',notesUrl:base+'CHANGELOG.txt'},null,2));
fs.writeFileSync(path.join(root,'latest.json'),JSON.stringify({version,pub_date:publishedAt,notes:section.trim(),platforms},null,2));
console.log('PASS: seven signed release artifacts; five installers and four update targets');
