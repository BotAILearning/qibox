"""Run native portal checks on a disposable X display and private bus. No WeChat account is used.
Usage: python3 test-file-portal-linux.py RUNTIME_ROOT FILE_PORTAL_SOURCE
"""
import pathlib,subprocess,json,tempfile,os,select,time,shutil,sys
base=pathlib.Path(tempfile.mkdtemp(prefix='qibox-050-portal-',dir='/tmp'))
runtime=pathlib.Path(sys.argv[1]).resolve(); PORTAL_SOURCE=pathlib.Path(sys.argv[2]).read_bytes(); processes=[]
env=os.environ.copy()
env.update(HOME=str(base),XDG_CONFIG_HOME=str(base/'config'),XDG_DATA_HOME=str(base/'data'),XDG_CACHE_HOME=str(base/'cache'),XDG_RUNTIME_DIR=str(base),TMPDIR=str(base),PYTHONHOME=str(runtime/'usr'),PYTHONNOUSERSITE='1',PYTHONDONTWRITEBYTECODE='1')
env.pop('LD_PRELOAD',None);env.pop('XAUTHORITY',None)
env.update(LANG='C.UTF-8',PATH=str(runtime/'usr/bin')+':/usr/bin:/bin',XKB_CONFIG_ROOT=str(runtime/'usr/share/X11/xkb'))
env['LD_LIBRARY_PATH']=':'.join(str(runtime/p) for p in ['usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu','usr/lib','lib'])
def launch(args,**kwargs):
    p=subprocess.Popen(args,env=env,cwd=base,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs);processes.append(p);return p
def event(p,kind,timeout=8):
    limit=time.monotonic()+timeout
    while time.monotonic()<limit:
        if select.select([p.stdout],[],[],.25)[0]:
            line=p.stdout.readline()
            if not line: raise RuntimeError('Portal stopped: '+p.stderr.read().decode()[-500:])
            value=json.loads(line)
            if value.get('type')==kind:return value
    p.terminate();p.wait(timeout=3)
    raise RuntimeError('Portal event timed out: '+kind+' '+p.stderr.read().decode()[-800:])
def call(interface,method,args,object_path='/org/freedesktop/portal/desktop'):
    code='''import ctypes as c,sys
g=c.CDLL('libgio-2.0.so.0');b=c.CDLL('libglib-2.0.so.0');p=c.c_void_p;s=c.c_char_p
def fn(lib,name,ret,args):
 f=getattr(lib,name);f.restype=ret;f.argtypes=args;return f
bus=fn(g,'g_bus_get_sync',p,[c.c_int,p,p])(2,None,None)
params=fn(b,'g_variant_parse',p,[p,s,p,p,p])(None,sys.argv[5].encode(),None,None,None)
assert params
value=fn(g,'g_dbus_connection_call_sync',p,[p,s,s,s,s,p,p,c.c_int,c.c_int,p,p])(bus,sys.argv[1].encode(),sys.argv[2].encode(),sys.argv[3].encode(),sys.argv[4].encode(),params,None,0,4000,None,None)
assert value,'D-Bus call failed'
'''
    iface,member=method.rsplit('.',1)
    params="('', '保存', {'current_name': <'测试.txt'>})" if member=='SaveFile' else '('+args[0]+", '')"
    result=subprocess.run([str(runtime/'usr/bin/python3.11'),'-c',code,interface,object_path,iface,member,params],env=env,capture_output=True,timeout=8)
    if result.returncode: raise RuntimeError(result.stderr.decode()[-400:])
    return result.stdout
try:
    xvfb=runtime/'usr/bin/Xvfb-qibox'
    if not xvfb.is_file():raise RuntimeError('Prepare the runtime first')
    (base/'xkbcomp').symlink_to(runtime/'usr/bin/xkbcomp')
    display=launch([str(xvfb),'-displayfd','1','-screen','0','800x600x24','-nolisten','tcp','-nolisten','unix','-ac','-fp','built-ins','-xkbdir',str(runtime/'usr/share/X11/xkb')])
    if not select.select([display.stdout],[],[],8)[0]:raise RuntimeError('Display timeout')
    env['DISPLAY']=':'+display.stdout.readline().decode().strip()
    config=base/'bus.conf';address='unix:path='+str(base/'bus')
    config.write_text('<busconfig><type>session</type><listen>'+address+'</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
    bus=launch([str(runtime/'usr/bin/dbus-daemon'),'--nofork','--config-file='+str(config)])
    for _ in range(50):
        if (base/'bus').exists():break
        time.sleep(.05)
    env['DBUS_SESSION_BUS_ADDRESS']=address;env['AT_SPI_BUS_ADDRESS']=address
    portal=base/'file-portal.py';portal.write_bytes(PORTAL_SOURCE)
    child=launch([str(runtime/'usr/bin/python3.11'),str(portal)],stdin=subprocess.PIPE)
    event(child,'ready');time.sleep(.4)
    call('org.freedesktop.portal.Desktop','org.freedesktop.portal.FileChooser.SaveFile',['','保存',"{'current_name': <'测试.txt'>}"])
    request=event(child,'request');assert request['operation']=='save' and request['name']=='测试.txt'
    target=base/'saved.txt'
    child.stdin.write((json.dumps({'id':request['id'],'response':0,'uris':[target.as_uri()],'watch':str(target)})+'\n').encode());child.stdin.flush();time.sleep(.15)
    with target.open('wb') as out:out.write(b'EXACT_BYTES')
    saved=event(child,'saved');assert saved['id']==request['id']
    call('org.freedesktop.FileManager1','org.freedesktop.FileManager1.ShowItems',["['"+target.as_uri()+"']",''], '/org/freedesktop/FileManager1')
    folder=event(child,'request');assert folder['operation']=='folder' and folder['uris']==[target.as_uri()]
    clipcode='''import ctypes as c,sys,os
os.environ['NO_AT_BRIDGE']='1'
g=c.CDLL('libgtk-3.so.0');d=c.CDLL('libgdk-3.so.0');p=c.c_void_p;s=c.c_char_p
def fn(lib,name,ret,args):
 f=getattr(lib,name);f.restype=ret;f.argtypes=args;return f
assert fn(g,'gtk_init_check',c.c_int,[p,p])(None,None)
atom=fn(d,'gdk_atom_intern',p,[s,c.c_int]); clip=fn(g,'gtk_clipboard_get',p,[p])(atom(b'CLIPBOARD',0))
class Target(c.Structure):_fields_=[('name',s),('flags',c.c_uint),('info',c.c_uint)]
gettype=c.CFUNCTYPE(None,p,p,c.c_uint,p); cleartype=c.CFUNCTYPE(None,p,p)
payload=(sys.argv[1]+'\\r\\n').encode()
@gettype
def get(clip,selection,info,data):fn(g,'gtk_selection_data_set',None,[p,p,c.c_int,s,c.c_int])(selection,atom(b'text/uri-list',0),8,payload,len(payload))
@cleartype
def clear(*args):pass
targets=(Target*1)(Target(b'text/uri-list',0,0))
assert fn(g,'gtk_clipboard_set_with_data',c.c_int,[p,p,c.c_uint,gettype,cleartype,p])(clip,targets,1,get,clear,None)
fn(g,'gtk_main',None,[])()
'''
    copy=launch([str(runtime/'usr/bin/python3.11'),'-c',clipcode,target.as_uri()])
    copied=event(child,'request');assert copied['operation']=='copy' and copied['uris']==[target.as_uri()]
    print(json.dumps({'isolatedDesktop':True,'saveRequest':True,'closeWriteCompletion':True,'fileManagerRequest':True,'copiedFileUris':True,'realWechatSend':False}))
finally:
    for p in reversed(processes):
        p.terminate()
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:p.kill();p.wait()
    assert str(base).startswith('/tmp/qibox-050-portal-')
    shutil.rmtree(base)
