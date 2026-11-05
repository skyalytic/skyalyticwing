// Read-only public HTTPS checks. Never includes a real API credential or user data.
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const origin='https://api.skyalytic.com';
const checks=[],pass=name=>{checks.push(name);console.log('PASS '+name)};
async function request(url,options={}){const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000),...options});const text=await r.text();return {status:r.status,headers:r.headers,text,json:()=>JSON.parse(text)}}
(async()=>{
 let r=await request('http://api.skyalytic.com/v1/models?probe=1');assert.equal(r.status,308);assert.equal(r.headers.get('location'),origin+'/v1/models?probe=1');pass('HTTP redirects to HTTPS without changing the API path');
 r=await request(origin+'/');assert.equal(r.status,200);assert.equal(r.json().base_url,origin+'/v1');pass('API host returns service metadata, not website HTML');
 for(const pathname of ['/v1/models','/v1/models/']){r=await request(origin+pathname);assert.equal(r.status,401);assert.ok(r.headers.get('content-type').includes('application/json'));assert.ok(r.json().error);}
 pass('model listing enforces API key authentication');
 r=await request(origin+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer invalid-routing-probe','Content-Type':'application/json'},body:JSON.stringify({model:'route-check',messages:[{role:'user',content:'routing check'}]})});assert.equal(r.status,401);assert.ok(r.json().error);pass('chat completion route reaches gateway and rejects invalid keys');
 r=await request(origin+'/v1/chat/completions',{method:'OPTIONS',headers:{Origin:'https://example.com','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.ok(r.headers.get('access-control-allow-headers').includes('Authorization'));assert.equal(r.headers.get('access-control-allow-credentials'),null);pass('cross-origin API preflight works without cookie credentials');
 r=await request(origin+'/v1/models',{headers:{Origin:'https://root.skyalytic.com'}});assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.equal(r.headers.get('access-control-allow-credentials'),null);pass('backend CORS headers do not conflict with gateway policy');
 for(const pathname of ['/api/wing-admin/users','/api/auth/admin/login','/v1/unknown']){r=await request(origin+pathname);assert.equal(r.status,404);assert.ok(r.json().error);}pass('API domain does not expose admin/login pages or unknown routes');
 r=await request(origin+'/v1/models',{method:'POST',body:'{}'});assert.equal(r.status,405);assert.ok(r.json().error);pass('unsupported method returns JSON');
 r=await request('https://skyalytic.com/api/platform/v1/models');assert.equal(r.status,401);assert.ok(r.json().error);pass('previous website API URL remains compatible');
 for(const pathname of ['https://skyalytic.com/','https://root.skyalytic.com/','https://claw.skyalytic.com/','https://skyalytic.com/api/ecosystem/v1/catalog']){r=await request(pathname);assert.equal(r.status,200);}pass('website, root admin, Claw and ecosystem remain available');
 const directory=path.resolve(process.argv[2]||'build/api-domain-acceptance');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'public-results.json'),JSON.stringify({ok:true,checkedAt:new Date().toISOString(),checks},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
