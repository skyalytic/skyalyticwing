// Downloads a small public installer through Wing's actual WebView2 callbacks.
// No desktop input, account data, or installer execution.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const output = path.resolve(__dirname, '../build/browser-2.0.1-work/live-installer-confirmation-test.json');
async function run() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (!window.__TAURI_INTERNALS__) await sleep(50);
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  const session_id = 'live-download-' + Date.now();
  const cmd = (op, args = {}) => invoke('native_browser_command', {command: {op, args, session_id}});
  const samples = []; let result;
  try {
    await cmd('navigate', {url: 'https://www.7-zip.org/download.html', pageId: session_id});
    await invoke('native_browser_bounds', {bounds: {x:0,y:0,width:1100,height:800,visible:true,page_id:session_id}});
    let snapshot = await cmd('snapshot');
    // Find the actual site's download link, not a synthetic HTTP client download.
    let link;
    for (let page=0; page<5; page++) {
      link = snapshot.elements.find(e => e.tag === 'a' && JSON.stringify(e).includes('7z2301-x64.exe'));
      if (link) break;
      await cmd('scroll', {x:500,y:500,dy:350}); snapshot = await cmd('snapshot');
    }
    if (!link) throw Error('7-Zip official small archive link was not found');
    await cmd('click', {index:link.index});
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(100);
      const state = await cmd('state');
      const item = state.downloads.at(-1);
      if (item) {
        samples.push({bytes:item.bytes,total:item.total_bytes,status:item.status,at:Date.now()});
        result = {item, samples, complete:item.status==='ready'};
        await fetch('/report', {method:'POST',body:JSON.stringify(result)});
        if (item.status !== 'pending') break;
        if (item.total_bytes > 0 && item.bytes >= item.total_bytes) { const dialog = await cmd('download-dialog'); result.needsConfirmation = dialog.opened; if (dialog.opened) break; }
      }
    }
    if (!result?.complete && !result?.needsConfirmation) throw Error(result?.item?.error || 'Download did not finish within the test time');
    result.done = true;
  } catch (error) { result = {...result, done:true, error:String(error), samples}; }
  await fetch('/report', {method:'POST',body:JSON.stringify(result)});
  await cmd('close', {all:true}); await invoke('probe_finish');
}
const server = http.createServer((req,res) => {
  if(req.method==='POST' && req.url==='/report') { let body=''; req.on('data', b=>body+=b); req.on('end',()=>{
    const result=JSON.parse(body); if(result.done && result.complete && result.item?.path) {
      const data=fs.readFileSync(result.item.path);result.fileBytes=data.length;result.sizeMatches=data.length===result.item.bytes && data.length===result.item.total_bytes;
      result.archiveHeader=data.subarray(0,6).toString('hex')==='377abcaf271c';
      result.sha256=require('node:crypto').createHash('sha256').update(data).digest('hex');
    }
    fs.writeFileSync(output,JSON.stringify(result,null,2));res.end('ok');if(result.done)setTimeout(()=>server.close(),1500);
  }); return; }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>Wing download acceptance</title><script>('+run.toString()+')();</script>');
});server.listen(19112,'127.0.0.1');
