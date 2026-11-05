// Local fixture server for the isolated Tauri browser example. No account or API key is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve(__dirname, '../build/browser-2.0.1-work/native-probe');
fs.mkdirSync(out, {recursive:true});
const fixture = `<!doctype html><meta charset="utf-8"><title>Wing 原生浏览器测试</title>
<style>body{font:18px system-ui;background:#f4f8fc;color:#16354b;margin:40px}button,input{font:inherit;padding:10px;border:1px solid #92afc4;border-radius:8px}section{height:1200px;background:linear-gradient(#d2e9f5,#fff);padding:20px}h1{color:#216891}</style>
<h1>Wing 2.0.1 · 原生网页</h1><p>在网页内输入、滚动、缩放与选择元素。</p><form id="form"><input id="query" placeholder="输入中文"/><button id="send">提交</button></form>
<p id="result">等待输入</p><button id="click">测试点击</button> <button id="security">检查权限隔离</button> <a id="popup" target="_blank" href="/second">新标签页</a> <a id="download" href="/download">下载测试文件</a>
<p><a id="slow" href="/slow-redirect">慢速重复下载</a> <a id="unknown" href="/slow-unknown">未知大小下载</a> <a id="broken" href="/slow-broken">中断下载</a> <a href="/slow-recover">重试恢复下载</a></p>
<button id="delayed" onclick="const w=window.open('','_blank');if(w)setTimeout(()=>w.location.href='/second?delayed=1',150)">延迟跳转新窗口</button><form method="post" action="/post-result" target="_blank"><input type="hidden" name="value" value="popup-post-data"><button>新窗口提交表单</button></form>
<section>长页面滚动区域<div style="margin-top:1000px"><button id="bottom">已到达下方</button></div></section>
<script>document.getElementById('form').onsubmit=e=>{e.preventDefault();document.getElementById('result').textContent='提交：'+document.getElementById('query').value};document.getElementById('click').onclick=e=>e.target.textContent='点击成功 '+e.isTrusted;document.getElementById('security').onclick=async e=>{try{await window.__TAURI_INTERNALS__.invoke('native_browser_command',{command:{op:'state',session_id:'probe'}});e.target.textContent='权限泄漏'}catch{e.target.textContent='权限隔离通过'}};</script>`;
function runner() {
  return `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;background:#f7f9fb;padding:12px;color:#15364a}#status{white-space:pre-wrap}h2{margin:8px}</style><h2>Wing 2.0.1 浏览器验证</h2><div id="status">连接原生网页引擎…</div><script>(${run.toString()})();</script>`;
}
async function run() {
  const results=[], screenshots={};
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  while(!window.__TAURI_INTERNALS__) await wait(50);
  const invoke=(n,a)=>window.__TAURI_INTERNALS__.invoke(n,a);
  const cmd=(op,args={},session_id='probe')=>invoke('native_browser_command',{command:{op,args,session_id}});
  const check=(name,condition,detail)=>{results.push({name,passed:!!condition,detail});document.getElementById('status').textContent=results.map(r=>(r.passed?'✓ ':'✗ ')+r.name).join('  ·  ');if(!condition)throw Error(name+' '+JSON.stringify(detail||''));};
  const snap=()=>cmd('snapshot');
  const index=(s,id)=>s.elements.find(e=>e.hint===id||e.text===id)?.index;
  try {
    await cmd('clear-downloads');
    await cmd('navigate',{url:'http://127.0.0.1:19112/fixture',pageId:'probe-tab'});
    await invoke('native_browser_bounds',{bounds:{x:0,y:150,width:1100,height:600,visible:true,page_id:'probe-tab'}});
    let s=await snap();check('原生页面加载',s.title==='Wing 原生浏览器测试'&&s.viewport.width>900,s.title);
    check('AI 页面截图',s.screenshot?.length>1000);screenshots.initial=s.screenshot;
    await cmd('click',{index:index(s,'测试点击')});s=await snap();check('真实鼠标事件',s.elements.some(e=>e.text==='点击成功 true'));
    await cmd('fill',{index:index(s,'输入中文'),text:'中文输入 ABC 123'});
    await cmd('key',{key:'Enter'});s=await snap();check('中文输入和回车',s.elements.some(e=>e.text==='中文输入 ABC 123')&&s.pageText.includes('提交：中文输入 ABC 123'));
    await cmd('click',{index:index(s,'检查权限隔离')});s=await snap();check('网页没有应用权限',s.elements.some(e=>e.text==='权限隔离通过'));
    await cmd('annotate',{enabled:true});await cmd('click',{index:index(s,'点击成功 true')});
    let state=await cmd('state',{inspect:true});check('按需批注命中 DOM',state.metadata?.selected?.selector==='#click'&&!state.metadata.selecting,state.metadata);
    await cmd('annotate',{enabled:false});state=await cmd('state',{inspect:true});check('批注可清除',!state.metadata?.selected);
    await cmd('zoom',{scale:1.5});let zoomed=await snap();check('网页真实缩放',zoomed.viewport.width<s.viewport.width*.8,{before:s.viewport.width,after:zoomed.viewport.width});await cmd('zoom',{scale:1});
    await cmd('scroll',{x:500,y:500,dy:1050});await wait(350);s=await snap();check('原生页面滚动',s.elements.some(e=>e.text==='已到达下方'));screenshots.scrolled=s.screenshot;
    await cmd('scroll',{x:500,y:300,dy:-1600});await wait(350);s=await snap();
    let rejected=false;try{await cmd('navigate',{pageId:'probe-tab',url:'about:blank'},'other-session')}catch{rejected=true;}check('跨会话标签页隔离',rejected);s=await snap();check('隔离后原页面保留',s.title==='Wing 原生浏览器测试');
    await cmd('click',{index:index(s,'新标签页')});await wait(500);state=await cmd('state');check('网页新窗口留在应用',state.tabs.length===2,state.tabs);
    await cmd('activate',{pageId:'probe-tab'});s=await snap();await cmd('click',{index:index(s,'延迟跳转新窗口')});
    for(let i=0;i<30;i++){await wait(100);state=await cmd('state');if(state.tabs.some(t=>t.url.includes('delayed=1')))break;}
    check('保留窗口句柄与延迟跳转',state.tabs.some(t=>t.url.includes('delayed=1')),{tabs:state.tabs,error:state.error});
    await cmd('activate',{pageId:'probe-tab'});s=await snap();await cmd('click',{index:index(s,'新窗口提交表单')});await wait(600);s=await snap();check('新标签页保留POST正文',s.pageText.includes('popup-post-data'),s.pageText);
    await cmd('activate',{pageId:'probe-tab'});s=await snap();await cmd('click',{index:index(s,'下载测试文件')});
    for(let i=0;i<30;i++){await wait(100);state=await cmd('state');if(state.downloads.some(d=>d.status==='ready'))break;}check('原生下载记录',state.downloads.some(d=>d.status==='ready'),state.downloads);
    const samples=[];
    s=await snap();await cmd('click',{index:index(s,'慢速重复下载')});await cmd('click',{index:index(s,'慢速重复下载')});
    await cmd('navigate',{url:'http://127.0.0.1:19112/second'});
    for(let i=0;i<150;i++){
      await wait(100);state=await cmd('state');const rows=state.downloads.filter(d=>d.url.includes('/slow-known'));
      samples.push(rows.map(d=>({id:d.id,bytes:d.bytes,total:d.total_bytes,status:d.status})));
      if(rows.length===2&&rows.every(d=>d.status!=='pending'))break;
    }
    const finished=state.downloads.filter(d=>d.url.includes('/slow-known'));
    check('真实已下载字节与总字节进度',samples.some(rows=>rows.some(d=>d.status==='pending'&&d.bytes>0&&d.bytes<d.total&&d.total===2097152)),samples);
    check('相同URL同时下载均完成且路径独立',finished.length===2&&finished.every(d=>d.status==='ready'&&d.bytes===2097152)&&finished[0].path!==finished[1].path,finished);
    for(const row of finished){const file=await(await fetch('/download-check?path='+encodeURIComponent(row.path))).json();check('下载文件大小及内容校验 '+row.id,file.valid,file);}
    await cmd('navigate',{url:'http://127.0.0.1:19112/fixture'});s=await snap();
    await cmd('click',{index:index(s,'未知大小下载')});let observedUnknown=false;
    for(let i=0;i<100;i++){await wait(100);state=await cmd('state');const d=state.downloads.find(d=>d.url.includes('/slow-unknown'));if(d?.status==='pending'&&d.bytes>0&&!d.total_bytes)observedUnknown=true;if(d&&d.status!=='pending')break;}
    check('未知大小不虚构总量且能够完成',observedUnknown&&state.downloads.some(d=>d.url.includes('/slow-unknown')&&d.status==='ready'),state.downloads);
    await cmd('click',{index:index(s,'中断下载')});
    for(let i=0;i<300;i++){await wait(100);state=await cmd('state');const rows=state.downloads.filter(d=>d.url.includes('/slow-broken'));if(rows.length&&rows.every(d=>d.status!=='pending'))break;}
    const broken=state.downloads.filter(d=>d.url.includes('/slow-broken'));
    check('断流重试保留一条记录且最终失败',broken.length===1&&broken.every(d=>d.status==='failed'&&d.error),broken);
    s=await snap();await cmd('click',{index:index(s,'重试恢复下载')});
    for(let i=0;i<150;i++){await wait(100);state=await cmd('state');const rows=state.downloads.filter(d=>d.url.includes('/slow-recover'));if(rows.length&&rows.every(d=>d.status!=='pending'))break;}
    const recovered=state.downloads.filter(d=>d.url.includes('/slow-recover'));
    check('断流后自动重试恢复并完成',recovered.length===1&&recovered[0].status==='ready'&&recovered[0].bytes===2097152,recovered);
    const recoveredFile=await(await fetch('/download-check?path='+encodeURIComponent(recovered[0].path))).json();check('重试恢复文件内容完整',recoveredFile.valid,recoveredFile);
    await cmd('navigate',{url:'http://127.0.0.1:19112/second'});s=await snap();check('地址栏导航',s.title==='第二页');await cmd('back');s=await snap();check('浏览历史后退',s.title==='Wing 原生浏览器测试');await cmd('forward');s=await snap();check('浏览历史前进',s.title==='第二页');
    const download=state.downloads.find(d=>d.status==='ready');let foreignDenied=false;try{await cmd('remove-download',{id:download.id},'other-session')}catch{foreignDenied=true;}check('下载记录跨会话删除受阻',foreignDenied);await cmd('remove-download',{id:download.id});state=await cmd('state');check('下载记录可删除',!state.downloads.some(d=>d.id===download.id));check('删除记录保留文件',await(await fetch('/file-exists?path='+encodeURIComponent(download.path))).json());
    await cmd('navigate',{url:'https://www.baidu.com/s?wd=skyalytic'});s=await snap();screenshots.baidu=s.screenshot;check('百度搜索页面访问',s.url.startsWith('https://www.baidu.com/')&&s.elements.length>0,{title:s.title,elements:s.elements.length});screenshots.baidu=s.screenshot;
    await cmd('scroll',{x:500,y:500,dy:550});await wait(1200);s=await snap();
    const resultLink=s.elements.find(e=>e.tag==='a'&&/穹析科技|SkyalyticClaw/.test(e.text||''));
    if(resultLink){
      const before=(await cmd('state')).tabs.length;
      await cmd('click',{index:resultLink.index});
      for(let i=0;i<60;i++){await wait(100);state=await cmd('state');if(state.error||state.tabs.length>before||!state.tabs.some(t=>t.id===state.activePageId&&t.url.includes('baidu.com/s?')))break;}
      check('百度真实搜索结果跳转',state.tabs.length>before||state.tabs.some(t=>t.id===state.activePageId&&!t.url.includes('baidu.com/')),{tabs:state.tabs,error:state.error});
    }else results.push({name:'百度具体搜索结果',passed:true,skipped:true,detail:'当前返回结果未包含目标链接；已单独验证新窗口、延迟导航和POST表单。'});
    await cmd('download-dialog');await wait(500);const dialog=await cmd('download-dialog');check('原生下载确认入口可打开',dialog.opened,dialog);
    await cmd('close',{all:true});state=await cmd('state');check('全部关闭后状态清理',!state.tabs.length&&!state.activePageId);
  } catch(error){results.push({name:'异常',passed:false,detail:String(error)});}
  await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({results,screenshots})});
  await wait(500);await invoke('probe_finish');
}
let recoveryAttempts=0;
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/download-check?')){const p=new URL(req.url,'http://localhost').searchParams.get('path');let valid=false;let bytes=0;if(path.basename(p||'').includes('wing-browser-progress')&&fs.existsSync(p)){const b=fs.readFileSync(p);bytes=b.length;valid=bytes===2097152&&b.every(v=>v===65);}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({valid,bytes}));return;}
  if(req.url==='/slow-redirect'){res.writeHead(302,{Location:'/slow-known'});res.end();return;}
  if(['/slow-known','/slow-unknown','/slow-broken','/slow-recover'].includes(req.url)){
    const mode=req.url;const headers={'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="wing-browser-progress'+(mode==='/slow-known'?'':mode.replace('/','-'))+'.bin"'};
    if(mode!=='/slow-unknown')headers['Content-Length']='2097152';
    const interrupt=mode==='/slow-broken'||(mode==='/slow-recover'&&++recoveryAttempts<3);
    res.writeHead(200,headers);let sent=0;const timer=setInterval(()=>{res.write(Buffer.alloc(65536,65));sent+=65536;if(interrupt&&sent>=262144){clearInterval(timer);res.destroy();}else if(sent>=2097152){clearInterval(timer);res.end();}},100);res.on('close',()=>clearInterval(timer));return;
  }
  if(req.url.startsWith('/file-exists?')){const p=new URL(req.url,'http://localhost').searchParams.get('path');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(path.basename(p||'').includes('wing-browser-probe')&&fs.existsSync(p)));return;}
  if(req.url==='/post-result'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('Content-Type','text/html');res.end('<title>POST result</title><p>'+body.replace(/[<>&]/g,'')+'</p>')});return;}
  if(req.url==='/report'&&req.method==='POST'){
    let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);for(const [name,base64] of Object.entries(data.screenshots||{}))fs.writeFileSync(path.join(out,name+'.jpg'),Buffer.from(base64,'base64'));delete data.screenshots;fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(data,null,2));console.log(JSON.stringify(data));res.end('ok');setTimeout(()=>server.close(),2000);});return;
  }
  if(req.url==='/download'){res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="wing-browser-probe.txt"'});res.end('Wing native browser fixture');return;}
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(pathname==='/fixture'?fixture:pathname==='/second'?'<title>第二页</title><h1>浏览历史第二页</h1>':pathname==='/'?runner():'<title>Not found</title>');
});server.listen(19112,'127.0.0.1',()=>console.log('Native browser probe fixture ready on 19112'));
