"""Explicit clipboard targets, including a marker for local input/paste."""
import ctypes as c

LOCAL_TARGET = b'application/x-qibox-local-clipboard'


def own_payloads(gtk, gdk, clipboard, payloads):
    values = {**payloads, LOCAL_TARGET: b'local'}

    class Target(c.Structure):
        _fields_ = [('target', c.c_char_p), ('flags', c.c_uint), ('info', c.c_uint)]

    names = list(values)
    targets = (Target * len(names))(*(Target(name, 0, i) for i, name in enumerate(names)))
    get_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint, c.c_void_p)
    clear_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p)
    gtk.gtk_selection_data_set.argtypes = [c.c_void_p, c.c_void_p, c.c_int, c.c_void_p, c.c_int]

    @get_type
    def get_data(_owner, selection, info, _user):
        payload = values[names[info]]
        gtk.gtk_selection_data_set(selection, gdk.gdk_atom_intern(names[info], 0), 8, payload, len(payload))

    @clear_type
    def clear_data(_owner, _user):
        gtk.gtk_main_quit()

    gtk.gtk_clipboard_set_with_data.argtypes = [c.c_void_p, c.POINTER(Target), c.c_uint, get_type, clear_type, c.c_void_p]
    if not gtk.gtk_clipboard_set_with_data(clipboard, targets, len(names), get_data, clear_data, None):
        raise RuntimeError('Clipboard unavailable')
    return targets, get_data, clear_data
