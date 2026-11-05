const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const JSZip=require('../packages/backend/node_modules/jszip');
const root=path.resolve(__dirname,'..'),kit=path.join(root,'build/office-engine-linux-private'),zip=new JSZip();
function add(dir,prefix){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),name=prefix+e.name;if(e.isDirectory())add(p,name+'/');else zip.file(name,fs.readFileSync(p));}}
(async()=>{
  const lock=require('../deploy/office-engine/runtime.lock.json');
  for(const item of lock.packages){const bytes=fs.readFileSync(path.join(kit,'packages',item.name));if(crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Package digest mismatch');}
  add(path.join(kit,'packages'),'packages/');add(path.join(kit,'licenses'),'licenses/');
  zip.file('NOTICE.md',fs.readFileSync(path.join(root,'docs/OFFICE_COMMERCIAL_NOTICES.md')));
  zip.file('SOURCE.txt',`Corresponding source: ${lock.source.url}\nCommit: ${lock.source.commit}\nSHA-256: ${lock.source.sha256}\nNo code-brand package is included.\n`);
  const file=path.join(root,'build/office-components-26.04.5.zip');
  await new Promise((ok,fail)=>zip.generateNodeStream({type:'nodebuffer',streamFiles:true,compression:'STORE'}).pipe(fs.createWriteStream(file)).on('finish',ok).on('error',fail));
  const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);
  fs.writeFileSync(path.join(root,'deploy/office-engine/payload.lock.json'),JSON.stringify({version:'26.04.5',url:'https://skyalytic.com/download/components/office-components-26.04.5.zip',sha256:h.digest('hex'),bytes:fs.statSync(file).size},null,2));
  console.log('Prepared local Office payload with pinned packages, licenses and source URL: '+fs.statSync(file).size+' bytes');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
