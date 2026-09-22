"""Own the private X clipboard briefly; no text is saved to disk or logged."""
import ctypes as c
import sys

gtk = c.CDLL('libgtk-3.so.0')
gdk = c.CDLL('libgdk-3.so.0')
glib = c.CDLL('libglib-2.0.so.0')
gtk.gtk_init(None, None)
gdk.gdk_atom_intern.argtypes = [c.c_char_p, c.c_int]
gdk.gdk_atom_intern.restype = c.c_void_p
gtk.gtk_clipboard_get.argtypes = [c.c_void_p]
gtk.gtk_clipboard_get.restype = c.c_void_p
gtk.gtk_clipboard_set_text.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
text = sys.stdin.buffer.read(60001)
if not text or len(text) > 60000 or b'\0' in text:
    raise SystemExit(2)
text.decode('utf-8', errors='strict')
clipboard = gtk.gtk_clipboard_get(gdk.gdk_atom_intern(b'CLIPBOARD', 0))
gtk.gtk_clipboard_set_text(clipboard, text, len(text))
gdk.gdk_flush()
print('ready', flush=True)
callback_type = c.CFUNCTYPE(c.c_int, c.c_void_p)
@callback_type
def finish(_):
    gtk.gtk_main_quit()
    return 0
glib.g_timeout_add.argtypes = [c.c_uint, callback_type, c.c_void_p]
glib.g_timeout_add(30000, finish, None)
gtk.gtk_main()
