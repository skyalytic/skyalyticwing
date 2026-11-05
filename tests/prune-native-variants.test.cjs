const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pruneNativeVariants}=require('../scripts/prune-native-variants.cjs');
function fixture(t,entries){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wing-native-variants-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const packages={};
 for(const [name,pkg,optional=true]of entries){const rel='node_modules/'+name;packages[rel]={optional};fs.mkdirSync(path.join(root,rel),{recursive:true});fs.writeFileSync(path.join(root,rel,'package.json'),JSON.stringify({name,...pkg}));}
 fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages}));return root;
}
const target={os:'linux',cpu:'x64',libc:'glibc'};
test('removes optional musl and foreign architecture variants, retains glibc and JS',t=>{
 const root=fixture(t,[['@img/sharp-linuxmusl-x64',{os:['linux'],cpu:['x64']}],['@img/sharp-linux-x64',{os:['linux'],cpu:['x64'],libc:['glibc']}],['@rolldown/binding-linux-x64-musl',{libc:['musl']}],['@rolldown/binding-linux-x64-gnu',{libc:['glibc']}],['foreign',{os:['darwin']}],['arm',{cpu:['arm64']}],['plain',{},false]]);
 assert.equal(pruneNativeVariants(root,target).length,4);
 for(const name of ['plain','@img/sharp-linux-x64','@rolldown/binding-linux-x64-gnu'])assert.ok(fs.existsSync(path.join(root,'node_modules',name)));
 assert.deepEqual(pruneNativeVariants(root,target),[]);
});
test('required incompatible dependencies abort before removal',t=>{
 const root=fixture(t,[['optional',{cpu:['arm64']}],['required',{os:['darwin']},false]]);
 assert.throws(()=>pruneNativeVariants(root,target),/required dependency/);
 assert.ok(fs.existsSync(path.join(root,'node_modules/optional')));
});
test('musl package without compatible replacement is retained and fails',t=>{
 const root=fixture(t,[['@rolldown/binding-linux-x64-musl',{libc:['musl']}]]);
 assert.throws(()=>pruneNativeVariants(root,target),/counterpart/);
 assert.ok(fs.existsSync(path.join(root,'node_modules/@rolldown/binding-linux-x64-musl')));
});
