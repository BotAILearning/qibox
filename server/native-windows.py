"""Read-only, PID-scoped X11 window metadata shared by native inspectors."""

import ctypes as c
from contextlib import contextmanager


class ControlsUnavailable(RuntimeError):
    pass


class XWindowAttributes(c.Structure):
    _fields_ = [(name, c.c_int) for name in ('x', 'y', 'width', 'height', 'border_width', 'depth')] + [
        ('visual', c.c_void_p), ('root', c.c_ulong), ('window_class', c.c_int),
        ('bit_gravity', c.c_int), ('win_gravity', c.c_int), ('backing_store', c.c_int),
        ('backing_planes', c.c_ulong), ('backing_pixel', c.c_ulong), ('save_under', c.c_int),
        ('colormap', c.c_ulong), ('map_installed', c.c_int), ('map_state', c.c_int),
        ('all_event_masks', c.c_long), ('your_event_mask', c.c_long),
        ('do_not_propagate_mask', c.c_long), ('override_redirect', c.c_int), ('screen', c.c_void_p)]


def x11_property32(xlib, display, window, atom, expected_type):
    """Read exactly one typed EWMH item. Xlib format-32 storage is native long.

    https://www.x.org/releases/X11R7.5/doc/libX11/libX11.html section 4.4
    https://specifications.freedesktop.org/wm/latest-single/
    """
    actual_type, actual_format = c.c_ulong(), c.c_int()
    count, remaining, data = c.c_ulong(), c.c_ulong(), c.c_void_p()
    try:
        status = xlib.XGetWindowProperty(
            display, window, atom, 0, 1, 0, expected_type, c.byref(actual_type),
            c.byref(actual_format), c.byref(count), c.byref(remaining), c.byref(data))
        if (status != 0 or actual_type.value != expected_type or actual_format.value != 32
                or count.value != 1 or remaining.value != 0 or not data.value):
            raise ControlsUnavailable('foreground property unavailable')
        # Wire items are 32-bit; on LP64 Xlib pads each returned item to long.
        return c.cast(data, c.POINTER(c.c_ulong))[0] & 0xffffffff
    finally:
        if data.value:
            xlib.XFree(data)


def x11_property_array(xlib, display, window, atom, expected_type, wire_format, limit=128, optional=False):
    actual_type, actual_format = c.c_ulong(), c.c_int()
    count, remaining, data = c.c_ulong(), c.c_ulong(), c.c_void_p()
    try:
        status = xlib.XGetWindowProperty(
            display, window, atom, 0, limit, 0, expected_type, c.byref(actual_type),
            c.byref(actual_format), c.byref(count), c.byref(remaining), c.byref(data))
        if optional and status == 0 and not actual_type.value and not count.value and not remaining.value:
            return None
        max_count = limit if wire_format == 32 else limit * 4
        if (status != 0 or actual_type.value != expected_type or actual_format.value != wire_format
                or count.value > max_count or remaining.value or (count.value and not data.value)):
            raise ControlsUnavailable('window property unavailable')
        if wire_format == 32:
            return [value & 0xffffffff for value in c.cast(data, c.POINTER(c.c_ulong))[:count.value]]
        if wire_format == 8:
            return c.string_at(data, count.value)
        raise ControlsUnavailable('window format unavailable')
    finally:
        if data.value:
            xlib.XFree(data)


def x11_window_title(xlib, display, window, atoms=None):
    if atoms is None:
        atoms = {name: xlib.XInternAtom(display, name.encode('ascii'), 1)
                 for name in ('_NET_WM_NAME', 'UTF8_STRING', 'WM_NAME', 'STRING')}
    title = None
    for prop, kind in (('_NET_WM_NAME', 'UTF8_STRING'), ('WM_NAME', 'STRING')):
        if atoms[prop] and atoms[kind]:
            title = x11_property_array(xlib, display, window, atoms[prop], atoms[kind], 8, optional=True)
            if title is not None:
                break
    if not title:
        raise ControlsUnavailable('window name unavailable')
    try:
        label = title.decode('utf-8', errors='strict')
    except UnicodeError:
        raise ControlsUnavailable('window name unavailable') from None
    if '\x00' in label:
        raise ControlsUnavailable('window name unavailable')
    return label


@contextmanager
def x11_connection():
    try:
        xlib = c.CDLL('libX11.so.6')
        signatures = {
            'XOpenDisplay': (c.c_void_p, [c.c_char_p]),
            'XCloseDisplay': (c.c_int, [c.c_void_p]),
            'XDefaultRootWindow': (c.c_ulong, [c.c_void_p]),
            'XInternAtom': (c.c_ulong, [c.c_void_p, c.c_char_p, c.c_int]),
            'XGetWindowProperty': (c.c_int, [c.c_void_p, c.c_ulong, c.c_ulong,
                c.c_long, c.c_long, c.c_int, c.c_ulong, c.POINTER(c.c_ulong),
                c.POINTER(c.c_int), c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                c.POINTER(c.c_void_p)]),
            'XGetWindowAttributes': (c.c_int, [c.c_void_p, c.c_ulong, c.POINTER(XWindowAttributes)]),
            'XFree': (c.c_int, [c.c_void_p]),
            'XSetErrorHandler': (c.c_void_p, [c.c_void_p]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(xlib, name)
            function.restype, function.argtypes = result, arguments
    except (OSError, AttributeError):
        raise ControlsUnavailable('X11 unavailable') from None
    display = xlib.XOpenDisplay(None)
    if not display:
        raise ControlsUnavailable('X11 display unavailable')
    errors = []
    callback_type = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_void_p)
    def native_error(_display, _error):
        errors.append(True)
        return 0
    callback = callback_type(native_error)
    previous = xlib.XSetErrorHandler(c.cast(callback, c.c_void_p))
    try:
        yield xlib, display, errors
        if errors:
            raise ControlsUnavailable('X11 window changed')
    finally:
        try:
            xlib.XCloseDisplay(display)
        finally:
            xlib.XSetErrorHandler(previous)


def mapped_frames(pid, check):
    """Actual mapped EWMH clients for this PID, including Settings dialogs."""
    check()
    with x11_connection() as (xlib, display, errors):
        root = xlib.XDefaultRootWindow(display)
        names = ('_NET_CLIENT_LIST', '_NET_WM_PID', 'WINDOW', 'CARDINAL',
                 '_NET_WM_NAME', 'UTF8_STRING', 'WM_NAME', 'STRING')
        atoms = {name: xlib.XInternAtom(display, name.encode('ascii'), 1) for name in names}
        if not root or not all(atoms[name] for name in names[:4]):
            raise ControlsUnavailable('mapped window metadata unavailable')
        clients = x11_property_array(xlib, display, root, atoms['_NET_CLIENT_LIST'], atoms['WINDOW'], 32)
        result = set()
        for window in clients:
            check()
            if not window:
                raise ControlsUnavailable('mapped client unavailable')
            owner = x11_property32(xlib, display, window, atoms['_NET_WM_PID'], atoms['CARDINAL'])
            if owner != pid:
                continue
            attributes = XWindowAttributes()
            if not xlib.XGetWindowAttributes(display, window, c.byref(attributes)) or errors:
                raise ControlsUnavailable('window mapping unavailable')
            if attributes.map_state not in (0, 1, 2):
                raise ControlsUnavailable('unknown window mapping')
            if attributes.map_state != 2:
                continue
            label = x11_window_title(xlib, display, window, atoms)
            if label in result:
                raise ControlsUnavailable('ambiguous mapped window')
            result.add(label)
        check()
        return result

