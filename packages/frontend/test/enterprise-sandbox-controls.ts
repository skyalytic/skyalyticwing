import i18n from '../src/i18n';
const bar=document.createElement('aside');bar.id='enterprise-sandbox-controls';bar.setAttribute('aria-label','企业隔离测试控制');
const style=document.createElement('style');style.textContent='body{padding-top:42px!important;box-sizing:border-box}#root{height:calc(100vh - 42px)!important}#enterprise-sandbox-controls{position:fixed;inset:0 0 auto 0;height:42px;z-index:20000;display:flex;align-items:center;gap:12px;padding:0 18px;background:var(--bg-secondary,#f6f8fb);color:var(--text-primary,#172433);border-bottom:1px solid var(--border-color,#ced8e2);font:12px system-ui;box-sizing:border-box}#enterprise-sandbox-controls select,#enterprise-sandbox-controls button{background:var(--bg-primary,#fff);color:inherit;border:1px solid var(--border-color,#ccd5df);border-radius:6px;padding:4px 8px;font:inherit}#enterprise-sandbox-controls label{display:flex;align-items:center;gap:6px}#enterprise-sandbox-controls small{margin-left:auto}@media(max-width:900px){#enterprise-sandbox-controls small{display:none}}';
document.head.append(style);document.body.append(bar);
async function load(){
 const info=await(await fetch('/__enterprise-demo')).json();
 const english=i18n.language.startsWith('en');bar.replaceChildren();
 const title=document.createElement('strong');title.textContent=english?'Enterprise sandbox':'企业隔离测试';bar.append(title);
 const label=document.createElement('label');label.textContent=english?'Test identity':'测试身份';
 const select=document.createElement('select');select.setAttribute('aria-label',english?'Test identity':'测试身份');
 for(const actor of info.actors){const option=document.createElement('option');option.value=actor.id;option.textContent=actor.name+' · '+(actor.role==='owner'?(english?'Owner':'所有者'):actor.role==='admin'?(english?'Administrator':'企业管理员'):actor.manager?(english?'Department manager':'部门管理员'):(english?'Member':'普通成员'));select.append(option);}
 select.value=info.actor;select.onchange=async()=>{const r=await fetch('/__enterprise-demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:select.value})});if(r.ok)location.reload();};
 label.append(select);bar.append(label);
 const reset=document.createElement('button');reset.textContent=english?'Reset demo':'重置测试数据';reset.onclick=async()=>{await fetch('/__enterprise-demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});location.href='/enterprise-seats';};bar.append(reset);
 const note=document.createElement('small');note.textContent=english?'Isolated data · installation simulated · no real charges':'仅隔离数据 · 安装状态模拟 · 不产生真实扣款';bar.append(note);
}
void load();i18n.on('languageChanged',()=>void load());

