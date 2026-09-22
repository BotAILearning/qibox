"""Private instance clipboard; bounded local staging removed on owner exit."""
import ctypes as c
import base64,json,os,pathlib,signal,sys,tempfile

gtk=c.CDLL('libgtk-3.so.0');gdk=c.CDLL('libgdk-3.so.0');glib=c.CDLL('libglib-2.0.so.0')
gtk.gtk_init(None,None)
gdk.gdk_atom_intern.argtypes=[c.c_char_p,c.c_int];gdk.gdk_atom_intern.restype=c.c_void_p
gtk.gtk_clipboard_get.argtypes=[c.c_void_p];gtk.gtk_clipboard_get.restype=c.c_void_p
clipboard=gtk.gtk_clipboard_get(gdk.gdk_atom_intern(b'CLIPBOARD',0))
files=json.loads(sys.stdin.buffer.read(29*1024*1024+1))
if not isinstance(files,list) or not 1<=len(files)<=10:raise ValueError('invalid files')
staging=pathlib.Path(os.environ['TMPDIR'])/'clipboard-files'
staging.mkdir(mode=0o700,exist_ok=True)
if sum(p.stat().st_size for p in staging.glob('*/*') if p.is_file())>200*1024*1024:raise ValueError('clipboard staging full')
folder=tempfile.mkdtemp(prefix='paste-',dir=staging)
# Keep imported files until the application exits; WeChat can read them after preview.
if True:
 paths=[];total=0
 for f in files:
  name=f['name']
  if not isinstance(name,str) or not 0<len(name)<=180 or name in ('.','..') or any(ord(x)<32 or x in '/\\' for x in name):raise ValueError('invalid name')
  path=pathlib.Path(folder)/name
  data=base64.b64decode(f['data'],validate=True);total+=len(data)
  if total>20*1024*1024 or path.exists():raise ValueError('invalid size or name')
  with path.open('xb') as output:output.write(data)
  path.chmod(0o600);paths.append(path)
 if len(files)==1 and files[0]['type'] in ('image/png','image/jpeg','image/gif','image/webp'):
  pix=c.CDLL('libgdk_pixbuf-2.0.so.0');obj=c.CDLL('libgobject-2.0.so.0')
  pix.gdk_pixbuf_get_file_info.argtypes=[c.c_char_p,c.POINTER(c.c_int),c.POINTER(c.c_int)];pix.gdk_pixbuf_get_file_info.restype=c.c_void_p
  width,height=c.c_int(),c.c_int();filename=os.fsencode(paths[0])
  if not pix.gdk_pixbuf_get_file_info(filename,c.byref(width),c.byref(height)) or width.value<1 or height.value<1 or width.value*height.value>24000000:raise ValueError('invalid image')
  pix.gdk_pixbuf_new_from_file.argtypes=[c.c_char_p,c.c_void_p];pix.gdk_pixbuf_new_from_file.restype=c.c_void_p
  image=pix.gdk_pixbuf_new_from_file(filename,None)
  if not image:raise ValueError('invalid image')
  gtk.gtk_clipboard_set_image.argtypes=[c.c_void_p,c.c_void_p];gtk.gtk_clipboard_set_image(clipboard,image)
  obj.g_object_unref.argtypes=[c.c_void_p];obj.g_object_unref(image)
 else:
  class Target(c.Structure):_fields_=[('target',c.c_char_p),('flags',c.c_uint),('info',c.c_uint)]
  names=[b'text/uri-list',b'x-special/gnome-copied-files']
  targets=(Target*2)(*(Target(name,0,i) for i,name in enumerate(names)))
  get_type=c.CFUNCTYPE(None,c.c_void_p,c.c_void_p,c.c_uint,c.c_void_p)
  clear_type=c.CFUNCTYPE(None,c.c_void_p,c.c_void_p)
  gtk.gtk_selection_data_set.argtypes=[c.c_void_p,c.c_void_p,c.c_int,c.c_void_p,c.c_int]
  @get_type
  def get_data(owner,selection,info,user):
   payload=(('copy\n' if info==1 else '')+ ('\n' if info==1 else '\r\n').join(p.as_uri() for p in paths)+ ('\r\n' if info==0 else '')).encode()
   gtk.gtk_selection_data_set(selection,gdk.gdk_atom_intern(names[info],0),8,payload,len(payload))
  @clear_type
  def clear_data(owner,user):gtk.gtk_main_quit()
  gtk.gtk_clipboard_set_with_data.argtypes=[c.c_void_p,c.POINTER(Target),c.c_uint,get_type,clear_type,c.c_void_p]
  if not gtk.gtk_clipboard_set_with_data(clipboard,targets,2,get_data,clear_data,None):raise ValueError('clipboard unavailable')
 callback_type=c.CFUNCTYPE(c.c_int,c.c_void_p)
 @callback_type
 def finish(_):gtk.gtk_main_quit();return 0
 glib.g_timeout_add.argtypes=[c.c_uint,callback_type,c.c_void_p];glib.g_timeout_add(120000,finish,None)
 @callback_type
 def pump(_):return 1
 # Periodic Python entry lets SIGTERM be handled while GTK owns the event loop.
 glib.g_timeout_add(250,pump,None)
 signal.signal(signal.SIGTERM,lambda *_:gtk.gtk_main_quit())
 gdk.gdk_flush();print('ready',flush=True);gtk.gtk_main()
