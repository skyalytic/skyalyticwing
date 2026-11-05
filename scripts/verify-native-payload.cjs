const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const root=path.resolve(process.argv[2]),manifest=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expected=new Set();
for(const file of manifest.files){
 const p=path.resolve(root,file.target);assert(p.startsWith(root+path.sep));assert(fs.statSync(p).isFile(),file.target);assert.equal(hash(p),file.sha256,'Bundled file differs: '+file.target);expected.add(file.target.replaceAll('\\','/'));
}
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name),rel=path.relative(root,p).replaceAll('\\','/');if(ent.isDirectory())walk(p);else assert(expected.has(rel),'Unexpected packaged resource '+rel);}}
walk(path.join(root,'_up_/packages'));
console.log('PASS actual native resource file list and '+manifest.files.length+' hashes');
