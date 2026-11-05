/** macOS Quartz and Linux X11 real desktop input. */
export const UNIX_DESKTOP_SOURCE = String.raw`import sys, os, json, ctypes as C, ctypes.util, subprocess, tempfile, base64, time, signal, shutil
P=C.c_void_p

def cancelled(signum, frame):
    raise RuntimeError('Desktop control cancelled; observe before continuing.')
signal.signal(signal.SIGTERM, cancelled)

def executable(name, package):
    path=shutil.which(name)
    if not path:raise RuntimeError('桌面适配缺少 '+name+'，请安装 '+package+'；未切换输入模式。')
    return path

def fn(lib,name,restype,args):
    f=getattr(lib,name);f.restype=restype;f.argtypes=args;return f

def result(root, data):
    return dict(base64=base64.b64encode(data).decode(), mimeType='image/png', width=root['bounds']['width'],height=root['bounds']['height'],originX=root['bounds']['x'],originY=root['bounds']['y'],bounds=root['bounds'],coordinateSpace='window-coordinates',cursor=dict(x=0,y=0,visible=False))

def selected(roots, req):
    wanted=req['root']
    r=next((r for r in roots if r['windowId']==wanted['windowId'] and r['pid']==wanted['pid']),None)
    if not r:raise RuntimeError('目标窗口已经关闭或替换，请重新列窗口。')
    if req['command']=='input' and r['bounds']!=wanted['bounds']:raise RuntimeError('窗口已移动，请重新观察；未发送输入。')
    return r

def mac(req):
    cg=C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');cf=C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    release=fn(cf,'CFRelease',None,[P]);string=fn(cf,'CFStringCreateWithCString',P,[P,C.c_char_p,C.c_uint]);get=fn(cf,'CFDictionaryGetValue',P,[P,P]);number=fn(cf,'CFNumberGetValue',C.c_bool,[P,C.c_int,P]);text=fn(cf,'CFStringGetCString',C.c_bool,[P,C.c_char_p,C.c_long,C.c_uint]);cnt=fn(cf,'CFArrayGetCount',C.c_long,[P]);at=fn(cf,'CFArrayGetValueAtIndex',P,[P,C.c_long])
    def field(d,k):
        key=string(None,k.encode(),0x08000100)
        try:return get(d,key)
        finally:release(key)
    def num(v):
        if not v:return 0
        out=C.c_double();number(v,13,C.byref(out));return out.value
    def txt(v):
        if not v:return ''
        out=C.create_string_buffer(8192);text(v,out,len(out),0x08000100);return out.value.decode('utf-8',errors='replace')
    arr=fn(cg,'CGWindowListCopyWindowInfo',P,[C.c_uint,C.c_uint])(1|16,0);roots=[]
    try:
        for i in range(cnt(arr)):
            d=at(arr,i);title=txt(field(d,'kCGWindowName'));owner=txt(field(d,'kCGWindowOwnerName'));pid=int(num(field(d,'kCGWindowOwnerPID')));wid=int(num(field(d,'kCGWindowNumber')))
            if title.startswith('Wing · ') or int(num(field(d,'kCGWindowLayer')))!=0:continue
            b=field(d,'kCGWindowBounds');bounds={key:int(num(field(b,n))) for key,n in [('x','X'),('y','Y'),('width','Width'),('height','Height')]}
            if bounds['width']>0 and bounds['height']>0:roots.append(dict(rootRef='mac:%s:%s'%(wid,pid),windowId=wid,pid=pid,title=title or owner,bounds=bounds))
    finally:release(arr)
    class Point(C.Structure):_fields_=[('x',C.c_double),('y',C.c_double)]
    class Size(C.Structure):_fields_=[('width',C.c_double),('height',C.c_double)]
    class Rect(C.Structure):_fields_=[('origin',Point),('size',Size)]
    displayIds=(C.c_uint*32)();displayCount=C.c_uint()
    fn(cg,'CGGetActiveDisplayList',C.c_int,[C.c_uint,P,P])(32,displayIds,C.byref(displayCount))
    displayBounds=fn(cg,'CGDisplayBounds',Rect,[C.c_uint])
    displays=[displayBounds(displayIds[i]) for i in range(displayCount.value)]
    active=roots[0]['bounds'] if roots else None
    if displays and req.get('inputMode','physical')=='physical':
        for i,b in reversed(list(enumerate(displays))):
            roots.insert(0,dict(rootRef='desktop:%s'%i,windowId=-i,pid=0,title='Display %s'%(i+1),isForeground=bool(active and b.origin.x<=active['x']+active['width']/2<b.origin.x+b.size.width and b.origin.y<=active['y']+active['height']/2<b.origin.y+b.size.height),bounds=dict(x=int(b.origin.x),y=int(b.origin.y),width=int(b.size.width),height=int(b.size.height))))
    if req['command']=='list':return roots
    r=selected(roots,req);mode=req.get('inputMode','physical');pid=r['pid']
    # AppKit queries/activation avoid an extra Apple Events permission prompt.
    C.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit')
    objc=C.CDLL('/usr/lib/libobjc.A.dylib')
    cls=fn(objc,'objc_getClass',P,[C.c_char_p]);sel=fn(objc,'sel_registerName',P,[C.c_char_p])
    def message(receiver,name,restype=P,args=(),values=()):
        if not receiver:raise RuntimeError('macOS 目标应用不可用。')
        call=fn(objc,'objc_msgSend',restype,[P,P]+list(args))
        return call(receiver,sel(name.encode()),*values)
    def foreground_pid():
        workspace=message(cls(b'NSWorkspace'),'sharedWorkspace')
        app=message(workspace,'frontmostApplication')
        return message(app,'processIdentifier',C.c_int)
    def ensure_foreground():
        expected=req['root'].get('foregroundWindowId') if r['windowId']<=0 else pid
        if foreground_pid()!=expected:raise RuntimeError('前台应用已改变；未发送后续输入，请重新观察。')
    if req['command']=='inspect_window':return dict(r,foregroundWindowId=foreground_pid())
    if req['command']=='window_info':return dict(bounds=r['bounds'],foregroundWindowId=foreground_pid())
    if req['command']=='focus':
        if mode=='physical' and r['windowId']>0:
            app=message(cls(b'NSRunningApplication'),'runningApplicationWithProcessIdentifier:',P,[C.c_int],[pid])
            if not message(app,'activateWithOptions:',C.c_bool,[C.c_ulong],[3]):raise RuntimeError('macOS 未允许激活目标应用，请由用户切换后重试。')
            time.sleep(.1);ensure_foreground()
        return dict(focused=mode=='physical',bounds=r['bounds'])
    if req['command']=='capture':
        if hasattr(cg,'CGPreflightScreenCaptureAccess') and not fn(cg,'CGPreflightScreenCaptureAccess',C.c_bool,[])():raise RuntimeError('请在 macOS 系统设置中授予 Wing 屏幕录制权限。')
        with tempfile.TemporaryDirectory(prefix='wing-observe-') as tmp:
            path=os.path.join(tmp,'window.png');b=r['bounds']
            target=['-R','%s,%s,%s,%s'%(b['x'],b['y'],b['width'],b['height'])]
            observed=foreground_pid()
            subprocess.run(['screencapture','-x','-o',*target,path],check=True,timeout=15,capture_output=True)
            with open(path,'rb') as f:shot=result(r,f.read());shot['foregroundWindowId']=observed;return shot
    ax=C.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    if not fn(ax,'AXIsProcessTrusted',C.c_bool,[])():raise RuntimeError('请在 macOS 系统设置中授予 Wing 辅助功能权限。')
    class Point(C.Structure):_fields_=[('x',C.c_double),('y',C.c_double)]
    createMouse=fn(cg,'CGEventCreateMouseEvent',P,[P,C.c_uint,Point,C.c_uint]);createKey=fn(cg,'CGEventCreateKeyboardEvent',P,[P,C.c_ushort,C.c_bool]);flags=fn(cg,'CGEventSetFlags',None,[P,C.c_uint64]);setInt=fn(cg,'CGEventSetIntegerValueField',None,[P,C.c_uint,C.c_int64]);postGlobal=fn(cg,'CGEventPost',None,[C.c_uint,P])
    keyboard=req.get('action',{}).get('kind') in ['typeText','keypress']
    if mode=='physical' and (r['windowId']>0 or keyboard):ensure_foreground()
    def post(e, releasing=False):
        if not e:raise RuntimeError('macOS 无法创建输入事件。')
        try:
            if r['windowId']>0:setInt(e,91,r['windowId']);setInt(e,92,r['windowId'])
            if not releasing and (r['windowId']>0 or keyboard):ensure_foreground()
            postGlobal(0,e)
        finally:release(e)
    a=req['action'];kind=a['kind'];p=a.get('params',{});x=float(a.get('x',0));y=float(a.get('y',0))
    if kind in ['click','moveMouse','drag','scroll']:
        b=r['bounds']
        if not (b['x']<=x<b['x']+b['width'] and b['y']<=y<b['y']+b['height']):raise RuntimeError('坐标超出目标窗口。')
    if kind=='moveMouse':
        if mode=='physical':post(createMouse(None,5,Point(x,y),0))
    elif kind=='click':
        button=p.get('button','left');buttons={'left':(0,1,2),'right':(1,3,4),'middle':(2,25,26)}
        if button not in buttons:raise RuntimeError('不支持的鼠标键。')
        b,down,up=buttons[button];count=int(p.get('clickCount',2 if p.get('doubleClick') else 1))
        if count<1 or count>3:raise RuntimeError('clickCount must be 1, 2 or 3')
        for i in range(count):
            try:
                e=createMouse(None,down,Point(x,y),b);setInt(e,1,i+1);post(e);time.sleep(.035)
            finally:
                e=createMouse(None,up,Point(x,y),b);setInt(e,1,i+1);post(e,True)
    elif kind=='drag':
        tx=float(p['toX']);ty=float(p['toY']);b=r['bounds']
        if not (b['x']<=tx<b['x']+b['width'] and b['y']<=ty<b['y']+b['height']):raise RuntimeError('拖动终点超出目标窗口。')
        post(createMouse(None,1,Point(x,y),0))
        try:
            for i in range(1,21):post(createMouse(None,6,Point(x+(tx-x)*i/20,y+(ty-y)*i/20),0));time.sleep(.015)
        finally:post(createMouse(None,2,Point(tx,ty),0),True)
    elif kind=='scroll':
        create=fn(cg,'CGEventCreateScrollWheelEvent',P,[P,C.c_uint,C.c_uint]);e=create(None,0,2,C.c_int(int(p.get('deltaY',-120))),C.c_int(int(p.get('deltaX',0))));fn(cg,'CGEventSetLocation',None,[P,Point])(e,Point(x,y));post(e)
    elif kind=='typeText':
        data=p['text'].encode('utf-16-le');chars=(C.c_ushort*(len(data)//2)).from_buffer_copy(data)
        setText=fn(cg,'CGEventKeyboardSetUnicodeString',None,[P,C.c_long,P])
        try:
            e=createKey(None,0,True);setText(e,len(chars),chars);post(e)
        finally:
            e=createKey(None,0,False);setText(e,len(chars),chars);post(e,True)
    elif kind=='keypress':
        keys={'ENTER':36,'RETURN':36,'TAB':48,'SPACE':49,'BACKSPACE':51,'ESC':53,'ESCAPE':53,'DELETE':117,'LEFT':123,'RIGHT':124,'DOWN':125,'UP':126,'A':0,'C':8,'V':9,'X':7,'F':3,'Z':6}
        mods={'CMD':1<<20,'COMMAND':1<<20,'META':1<<20,'CTRL':1<<18,'CONTROL':1<<18,'SHIFT':1<<17,'ALT':1<<19,'OPTION':1<<19}
        parts=[str(v).upper() for v in p.get('modifiers',[])]+p['key'].upper().split('+');mask=0
        for mod in parts[:-1]:
            if mod not in mods:raise RuntimeError('不支持的组合键。')
            mask|=mods[mod]
        if parts[-1] not in keys:raise RuntimeError('不支持的按键，请使用 typeText 或界面控件。')
        try:
            e=createKey(None,keys[parts[-1]],True);flags(e,mask);post(e)
        finally:
            e=createKey(None,keys[parts[-1]],False);flags(e,mask);post(e,True)
    else:raise RuntimeError('Unsupported input')
    return dict(performed=True,inputMode=mode,verification='Events delivered; inspect the new screenshot.')

def linux(req):
    if os.environ.get('XDG_SESSION_TYPE')=='wayland' or os.environ.get('WAYLAND_DISPLAY'):raise RuntimeError('当前为 Wayland：没有获授权的远程桌面 Portal 会话，不能把 XWayland 当成全桌面控制，也不会切换为全局鼠标注入。请使用 X11 会话。')
    lib=C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6');display=fn(lib,'XOpenDisplay',P,[C.c_char_p])(None)
    if not display:raise RuntimeError('无法连接 X11 桌面；请在已登录的桌面会话中运行 Wing。')
    W=C.c_ulong;root=fn(lib,'XDefaultRootWindow',W,[P])(display)
    errors=[];cb=C.CFUNCTYPE(C.c_int,P,P)(lambda d,e:errors.append(True) or 0);fn(lib,'XSetErrorHandler',P,[P])(cb)
    sync=fn(lib,'XSync',C.c_int,[P,C.c_int]);free=fn(lib,'XFree',C.c_int,[P]);atom=fn(lib,'XInternAtom',W,[P,C.c_char_p,C.c_int])
    propfn=fn(lib,'XGetWindowProperty',C.c_int,[P,W,W,C.c_long,C.c_long,C.c_int,W,C.POINTER(W),C.POINTER(C.c_int),C.POINTER(W),C.POINTER(W),C.POINTER(P)])
    def prop(w,n):
        typ=W();fmt=C.c_int();count=W();left=W();data=P();propfn(display,w,atom(display,n.encode(),0),0,65536,0,0,C.byref(typ),C.byref(fmt),C.byref(count),C.byref(left),C.byref(data))
        if not data:return []
        try:
            if fmt.value==32:return list(C.cast(data,C.POINTER(W))[:count.value])
            return C.string_at(data,count.value).decode('utf-8',errors='replace')
        finally:free(data)
    geo=fn(lib,'XGetGeometry',C.c_int,[P,W,C.POINTER(W),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_uint),C.POINTER(C.c_uint),C.POINTER(C.c_uint),C.POINTER(C.c_uint)])
    translate=fn(lib,'XTranslateCoordinates',C.c_int,[P,W,W,C.c_int,C.c_int,C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(W)])
    roots=[]
    for w in prop(root,'_NET_CLIENT_LIST_STACKING') or prop(root,'_NET_CLIENT_LIST'):
        pid=prop(w,'_NET_WM_PID');title=prop(w,'_NET_WM_NAME') or prop(w,'WM_NAME') or '[无标题窗口]'
        if not pid or str(title).startswith('Wing · '):continue
        rr=W();x=C.c_int();y=C.c_int();width=C.c_uint();height=C.c_uint();border=C.c_uint();depth=C.c_uint();child=W()
        if not geo(display,w,C.byref(rr),C.byref(x),C.byref(y),C.byref(width),C.byref(height),C.byref(border),C.byref(depth)):continue
        translate(display,w,root,0,0,C.byref(x),C.byref(y),C.byref(child))
        roots.append(dict(rootRef='x11:%s:%s'%(w,pid[0]),windowId=w,pid=pid[0],title=title,bounds=dict(x=x.value,y=y.value,width=width.value,height=height.value)))
    if req.get('inputMode','physical')=='physical':
        monitors=[]
        try:
            xi=C.CDLL(ctypes.util.find_library('Xinerama') or 'libXinerama.so.1')
            class Monitor(C.Structure):_fields_=[('number',C.c_int),('x',C.c_short),('y',C.c_short),('width',C.c_short),('height',C.c_short)]
            count=C.c_int();screens=fn(xi,'XineramaQueryScreens',C.POINTER(Monitor),[P,C.POINTER(C.c_int)])(display,C.byref(count))
            if screens:
                try:monitors=[dict(x=screens[i].x,y=screens[i].y,width=screens[i].width,height=screens[i].height) for i in range(count.value)]
                finally:free(screens)
        except OSError:pass
        if not monitors:
            rr=W();x=C.c_int();y=C.c_int();width=C.c_uint();height=C.c_uint();border=C.c_uint();depth=C.c_uint()
            if geo(display,root,C.byref(rr),C.byref(x),C.byref(y),C.byref(width),C.byref(height),C.byref(border),C.byref(depth)):monitors=[dict(x=0,y=0,width=width.value,height=height.value)]
        activeId=(prop(root,'_NET_ACTIVE_WINDOW') or [0])[0];active=next((w['bounds'] for w in roots if w['windowId']==activeId),None)
        for i,b in reversed(list(enumerate(monitors))):roots.insert(0,dict(rootRef='desktop:%s'%i,windowId=-i,pid=0,title='Display %s'%(i+1),isForeground=bool(active and b['x']<=active['x']+active['width']/2<b['x']+b['width'] and b['y']<=active['y']+active['height']/2<b['y']+b['height']),bounds=b))
    if req['command']=='list':return roots
    r=selected(roots,req);wid=r['windowId'];mode=req.get('inputMode','physical')
    if req['command']=='inspect_window':return dict(r,foregroundWindowId=(prop(root,'_NET_ACTIVE_WINDOW') or [0])[0])
    if req['command']=='window_info':return dict(bounds=r['bounds'],foregroundWindowId=(prop(root,'_NET_ACTIVE_WINDOW') or [0])[0])
    if req['command']=='focus':
        if mode=='physical' and wid>0:subprocess.run([executable('xdotool','xdotool'),'windowactivate','--sync',str(wid)],check=True,timeout=10,capture_output=True)
        return dict(focused=mode=='physical',bounds=r['bounds'])
    if req['command']=='capture':
        # Read the observed desktop region, preserving visible popups and occlusion.
        target=['-window','root','-crop','%sx%s%+d%+d'%(r['bounds']['width'],r['bounds']['height'],r['bounds']['x'],r['bounds']['y'])]
        capture=subprocess.run([executable('import','ImageMagick'),'-silent',*target,'png:-'],check=True,timeout=15,capture_output=True)
        shot=result(r,capture.stdout);shot['foregroundWindowId']=(prop(root,'_NET_ACTIVE_WINDOW') or [0])[0];return shot
    a=req['action'];p=a.get('params',{});kind=a['kind'];b=r['bounds'];x=int(a.get('x',req.get('keyboardPoint',{}).get('x',b['x']+1)));y=int(a.get('y',req.get('keyboardPoint',{}).get('y',b['y']+1)))
    if not (b['x']<=x<b['x']+b['width'] and b['y']<=y<b['y']+b['height']):raise RuntimeError('坐标超出目标窗口。')
    if mode=='physical':
        def xd(*args):subprocess.run([executable('xdotool','xdotool'),*map(str,args)],check=True,timeout=20,capture_output=True)
        active=subprocess.run([executable('xdotool','xdotool'),'getactivewindow'],check=True,timeout=5,capture_output=True,text=True)
        expected=req['root'].get('foregroundWindowId') if wid<=0 else wid
        if (wid>0 or kind in ['typeText','keypress']) and int(active.stdout.strip())!=expected:raise RuntimeError('前台窗口已改变，请重新观察；未发送输入。')
        if kind in ['click','moveMouse','drag','scroll']:xd('mousemove','--sync',x,y)
        if kind=='click':xd('click','--repeat',p.get('clickCount',2 if p.get('doubleClick') else 1),{'left':1,'middle':2,'right':3}[p.get('button','left')])
        elif kind=='typeText':xd('type','--clearmodifiers','--',p['text'])
        elif kind=='keypress':xd('key','--clearmodifiers','+'.join(list(p.get('modifiers',[]))+[p['key']]))
        elif kind=='scroll':xd('click','--repeat',max(1,abs(int(p.get('deltaY',-120)))//120),5 if p.get('deltaY',-120)<0 else 4)
        elif kind=='drag':
            xd('mousedown',1)
            try:xd('mousemove','--sync',p['toX'],p['toY'])
            finally:xd('mouseup',1)
        return dict(performed=True,inputMode=mode)
    raise RuntimeError('Unsupported desktop input')

def main(req):
    command=req['command']
    if command=='ping':return dict(protocolVersion=1,platform=sys.platform)
    if command.startswith('overlay_'):return dict(visible=False,managedBy='tauri')
    if req.get('inputMode','physical') != 'physical':raise RuntimeError('Invalid input mode')
    if command=='list_apps':
        roots=mac(dict(command='list')) if sys.platform=='darwin' else linux(dict(command='list'))
        apps={}
        for root in roots:
            if root['windowId']<=0:continue
            key=root.get('processPath') or str(root['pid'])+'.exe'
            apps[key]=dict(id=key,displayName=root['title'],isRunning=True)
        return list(apps.values())
    if command=='launch_app':raise RuntimeError('Use an observed desktop/Dock/taskbar icon to open this application.')
    if command in ['accessibility','accessibility_input']:raise RuntimeError('Use screenshot coordinates for this desktop adapter.')
    if sys.platform=='darwin':return mac(req)
    if sys.platform.startswith('linux'):return linux(req)
    raise RuntimeError('Unsupported desktop platform')

if __name__=='__main__':
    try:print(json.dumps(dict(ok=True,result=main(json.load(sys.stdin))),ensure_ascii=False))
    except Exception as e:print(json.dumps(dict(ok=False,error=str(e)),ensure_ascii=False))
`;
