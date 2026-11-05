/** Editing runs inside the sandboxed design document. The saved HTML contains no editor UI. */
export const DESIGN_EDITOR_SCRIPT = String.raw`
(() => {
  const history = []; let cursor = -1, selected = null, editing = null, drag = null, clipboard = null;
  let mode = 'edit', started = false;
  const overlay = document.createElement('div');
  overlay.id = '__sky_canvas_layer';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const send = (type,payload) => parent.postMessage({type,payload}, '*');
  const editable = el => el && !['HTML','BODY','SCRIPT','STYLE','LINK','META'].includes(el.tagName) && !el.closest('#__sky_canvas_layer');
  function html() {
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('#__sky_canvas_layer,script[data-sky-editor]').forEach(n => n.remove());
    root.querySelectorAll('[data-sky-editing]').forEach(n => { n.removeAttribute('contenteditable'); n.removeAttribute('data-sky-editing'); });
    return '<!DOCTYPE html>\n' + root.outerHTML;
  }
  function path(el) {
    if(el.id)return '#'+CSS.escape(el.id);
    const parts=[];
    while(el && el!==document.documentElement){const p=el.parentElement;if(!p)break;parts.unshift(el.tagName.toLowerCase()+':nth-child('+(Array.from(p.children).indexOf(el)+1)+')');el=p;}
    return 'html > '+parts.join(' > ');
  }
  function describe(el) {
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return {tag:el.tagName.toLowerCase(),text:el.textContent||'',selector:path(el),outerHTML:el.outerHTML.slice(0,8000),rect:{x:r.x,y:r.y,w:r.width,h:r.height},
      styles:Object.fromEntries(['color','backgroundColor','fontSize','fontFamily','fontWeight','textAlign','width','height','borderRadius','opacity','rotate'].map(k=>[k,s[k]])),
      textEditable:['H1','H2','H3','H4','P','SPAN','A','BUTTON','LABEL'].includes(el.tagName)||(el.children.length===0&&!['IMG','INPUT','TEXTAREA','SVG','CANVAS','VIDEO','IFRAME','HR'].includes(el.tagName))};
  }
  function render() {
    if(!document.body)return;
    if(!overlay.isConnected)document.body.appendChild(overlay);
    overlay.replaceChildren();
    if(!selected?.isConnected){selected=null;return;}
    if(mode!=='edit')return;
    const r=selected.getBoundingClientRect(),box=document.createElement('div');
    box.style.cssText='position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #2563eb;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px';
    overlay.appendChild(box);
    for(const [direction,x,y] of [['nw',0,0],['n',.5,0],['ne',1,0],['e',1,.5],['se',1,1],['s',.5,1],['sw',0,1],['w',0,.5]]){
      const handle=document.createElement('div');handle.dataset.resize=direction;
      handle.style.cssText='position:fixed;pointer-events:auto;width:10px;height:10px;background:white;border:2px solid #2563eb;border-radius:2px;box-sizing:border-box;cursor:'+direction+'-resize;left:'+(r.x+r.width*x-5)+'px;top:'+(r.y+r.height*y-5)+'px';
      overlay.appendChild(handle);
    }
  }
  function select(el){selected=editable(el)?el:null;render();send(selected?'sky-canvas-select':'sky-canvas-clear',selected?describe(selected):null);}
  function report(changed){
    const layers=Array.from(document.body.querySelectorAll('[data-wing-element],h1,h2,h3,p,button,a,img,section,article,header,footer,svg,hr')).filter(el=>!el.closest('#__sky_canvas_layer')).slice(0,200).map(el=>({selector:path(el),label:el.getAttribute('data-wing-name')||el.tagName.toLowerCase()+' '+(el.textContent||el.getAttribute('alt')||'').trim().slice(0,36)}));
    send('sky-canvas-document',{html:html(),undo:cursor>0,redo:cursor<history.length-1,changed,layers});
  }
  function checkpoint(){const next=html();if(next===history[cursor])return;history.splice(cursor+1);history.push(next);if(history.length>60)history.shift();cursor=history.length-1;report(true);}
  function finishText(){if(!editing)return;editing.removeAttribute('contenteditable');editing.removeAttribute('data-sky-editing');editing=null;checkpoint();select(selected);}
  function restore(){
    editing=null;drag=null;
    const doc=new DOMParser().parseFromString(history[cursor],'text/html');
    document.head.querySelectorAll(':not(script[data-sky-editor])').forEach(n=>n.remove());
    Array.from(doc.head.children).forEach(n=>document.head.appendChild(document.importNode(n,true)));
    for(const a of Array.from(document.body.attributes))document.body.removeAttribute(a.name);
    for(const a of Array.from(doc.body.attributes))document.body.setAttribute(a.name,a.value);
    document.body.replaceChildren(...Array.from(doc.body.childNodes).map(n=>document.importNode(n,true)));
    select(null);report(true);
  }
  function placement(el){
    el.dataset.wingElement='true';
    Object.assign(el.style,{position:'absolute',left:Math.round(window.scrollX+Math.max(20,(innerWidth-240)/2))+'px',top:Math.round(window.scrollY+Math.max(20,(innerHeight-100)/2))+'px',margin:'0',boxSizing:'border-box'});
    document.body.appendChild(el);select(el);checkpoint();
  }
  function insert(kind,value){
    const el=document.createElement(kind==='image'?'img':kind==='text'?'p':'div');
    if(kind==='text'){el.textContent='双击编辑文字';Object.assign(el.style,{fontSize:'32px',fontFamily:'Arial, Microsoft YaHei, sans-serif',color:'#172033',width:'300px',minHeight:'44px',whiteSpace:'pre-wrap'});el.dataset.wingName='文字';}
    else if(kind==='image'){
      if(typeof value!=='string'||!/^data:image\/(png|jpeg|webp|gif);base64,/.test(value)||value.length>2700000)throw Error('请选择 2 MB 以内的 PNG/JPEG/WebP/GIF 图片');
      el.src=value;el.alt='图片素材';Object.assign(el.style,{width:'320px',height:'220px',objectFit:'contain'});el.dataset.wingName='图片';
    }else{
      Object.assign(el.style,{width:kind==='line'?'280px':'200px',height:kind==='line'?'4px':'150px',backgroundColor:'#5b8def'});
      if(kind==='ellipse')el.style.borderRadius='50%';
      if(kind==='card')el.style.borderRadius='20px';
      el.dataset.wingName={rectangle:'矩形',ellipse:'圆形',card:'圆角矩形',line:'线条'}[kind]||'形状';
    }
    placement(el);
  }
  function clone(el){const copy=el.cloneNode(true);copy.removeAttribute('id');copy.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));copy.removeAttribute('contenteditable');copy.removeAttribute('data-sky-editing');return copy;}
  function duplicate(){const copy=clone(selected);selected.after(copy);const s=getComputedStyle(selected);if(s.position==='absolute'){copy.style.left=(parseFloat(s.left)||0)+24+'px';copy.style.top=(parseFloat(s.top)||0)+24+'px';}select(copy);checkpoint();}
  function translation(el){const parts=(getComputedStyle(el).translate||'').split(/\s+/);return {x:parseFloat(parts[0])||0,y:parseFloat(parts[1])||0};}
  function execute(command,value){
    try{
      if(command==='mode'){finishText();mode=value==='preview'?'preview':'edit';render();return;}
      if(command==='undo'){finishText();if(cursor>0){cursor--;restore();}return;}
      if(command==='redo'){if(cursor<history.length-1){cursor++;restore();}return;}
      if(command==='select'){finishText();select(document.querySelector(value));return;}
      if(command==='clear'){finishText();select(null);return;}
      if(command==='inspect'){report(false);return;}
      if(command==='insert'){finishText();insert(value);return;}
      if(command==='image'){finishText();insert('image',value);return;}
      if(command==='paste'&&clipboard){const copy=clone(clipboard);document.body.appendChild(copy);copy.style.translate='24px 24px';select(copy);checkpoint();return;}
      if(!selected?.isConnected)throw Error('请先选择元素');
      if(command==='copy'){clipboard=clone(selected);return;}
      if(command==='duplicate'){finishText();duplicate();return;}
      if(command==='delete'){selected.remove();select(null);checkpoint();return;}
      if(command==='text'){if(!describe(selected).textEditable)throw Error('请双击文字图层编辑');selected.textContent=String(value);}
      else if(command==='style'){
        for(const [key,v] of Object.entries(value||{})){
          if(!['color','backgroundColor','fontSize','fontFamily','fontWeight','textAlign','width','height','borderRadius','opacity','rotate'].includes(key)||typeof v!=='string'||v.length>100||/url|expression|[;{}]/i.test(v))continue;
          if(CSS.supports(key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v))selected.style[key]=v;
        }
      }else if(command==='front'||command==='back'){
        const siblings=Array.from(selected.parentElement.children).filter(n=>n!==overlay&&n!==selected);
        if(command==='front')selected.parentElement.appendChild(selected);else selected.parentElement.prepend(selected);
        Array.from(selected.parentElement.children).filter(n=>n!==overlay).forEach((n,i)=>{if(getComputedStyle(n).position!=='static')n.style.zIndex=String(i+1);});
      }else if(command==='align'){
        const r=selected.getBoundingClientRect(),t=translation(selected);
        const dx=value==='left'?16-r.x:value==='right'?innerWidth-16-r.right:innerWidth/2-r.x-r.width/2;
        selected.style.translate=(t.x+dx)+'px '+t.y+'px';
      }else return;
      select(selected);checkpoint();
    }catch(error){send('sky-canvas-error',{message:error.message});}
  }
  window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='sky-canvas-edit')execute(e.data.command,e.data.value);});
  document.addEventListener('pointerdown',e=>{
    if(mode!=='edit'||e.button!==0)return;
    const handle=e.target.closest?.('[data-resize]');
    if(editing&&(e.target===editing||editing.contains(e.target)))return;
    finishText();
    if(!handle){if(!editable(e.target)){select(null);return;}select(e.target);}
    if(!selected)return;
    e.preventDefault();e.stopImmediatePropagation();
    const r=selected.getBoundingClientRect(),s=getComputedStyle(selected),t=translation(selected);
    drag={x:e.clientX,y:e.clientY,w:parseFloat(s.width)||r.width,h:parseFloat(s.height)||r.height,tx:t.x,ty:t.y,handle:handle?.dataset.resize||'',moved:false};
    try{selected.setPointerCapture(e.pointerId);}catch{}
  },true);
  document.addEventListener('pointermove',e=>{
    if(!drag||!selected)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!drag.moved&&Math.abs(dx)+Math.abs(dy)<3)return;
    drag.moved=true;e.preventDefault();
    let tx=drag.tx,ty=drag.ty;
    if(drag.handle){
      if(/[ew]/.test(drag.handle)){const w=Math.max(12,drag.w+(/w/.test(drag.handle)?-dx:dx));selected.style.width=w+'px';if(/w/.test(drag.handle))tx+=drag.w-w;}
      if(/[ns]/.test(drag.handle)){const h=Math.max(4,drag.h+(/n/.test(drag.handle)?-dy:dy));selected.style.height=h+'px';if(/n/.test(drag.handle))ty+=drag.h-h;}
    }else{tx+=dx;ty+=dy;}
    selected.style.translate=tx+'px '+ty+'px';render();
  },true);
  const endDrag=()=>{if(!drag)return;const changed=drag.moved;drag=null;if(changed){checkpoint();select(selected);}};
  document.addEventListener('pointerup',endDrag,true);document.addEventListener('pointercancel',endDrag,true);
  document.addEventListener('click',e=>{if(mode==='edit'&&!editing){e.preventDefault();e.stopImmediatePropagation();}},true);
  document.addEventListener('dblclick',e=>{
    if(mode!=='edit'||!editable(e.target)||!describe(e.target).textEditable)return;
    select(e.target);editing=selected;editing.setAttribute('data-sky-editing','true');editing.contentEditable='true';editing.focus();
    const range=document.createRange();range.selectNodeContents(editing);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);e.preventDefault();
  },true);
  document.addEventListener('focusout',e=>{if(e.target===editing)finishText();},true);
  document.addEventListener('paste',e=>{
    if(!editing)return;e.preventDefault();const text=e.clipboardData?.getData('text/plain')||'';
    const selection=getSelection();if(!selection?.rangeCount)return;const r=selection.getRangeAt(0);r.deleteContents();const n=document.createTextNode(text);r.insertNode(n);r.setStartAfter(n);r.collapse(true);selection.removeAllRanges();selection.addRange(r);
  },true);
  document.addEventListener('keydown',e=>{
    if(mode!=='edit'||e.isComposing||e.keyCode===229)return;
    const mod=/mac|iphone|ipad/i.test(navigator.platform)?e.metaKey&&!e.ctrlKey:e.ctrlKey&&!e.metaKey;
    if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();finishText();send('sky-canvas-save',{});return;}
    if(editing){if(e.key==='Escape'){e.preventDefault();finishText();}return;}
    if(e.key==='Escape'){select(null);return;}
    const cmd=mod?({z:e.shiftKey?'redo':'undo',y:'redo',d:'duplicate',c:'copy',v:'paste'}[e.key.toLowerCase()]):(['Delete','Backspace'].includes(e.key)?'delete':null);
    if(cmd){e.preventDefault();execute(cmd);return;}
    if(selected&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const t=translation(selected),step=e.shiftKey?10:1;selected.style.translate=(t.x+(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0))+'px '+(t.y+(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0))+'px';select(selected);checkpoint();}
  });
  document.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();send('sky-canvas-zoom',{deltaY:e.deltaY});}},{passive:false});
  document.addEventListener('scroll',render,true);window.addEventListener('resize',()=>{render();if(selected)select(selected);});
  function start(){if(started)return;started=true;history.push(html());cursor=0;render();report(false);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
`;
