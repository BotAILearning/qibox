"""Advertise only this instance's private AT-SPI bus to Qt 5/6 clients."""
import ctypes as c
import os
import signal

gio = c.CDLL('libgio-2.0.so.0')
glib = c.CDLL('libglib-2.0.so.0')


def api(lib, name, result, args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, args
    return fn


xml = b'''<node>
<interface name="org.a11y.Bus"><method name="GetAddress"><arg name="address" type="s" direction="out"/></method></interface>
<interface name="org.a11y.Status"><property name="IsEnabled" type="b" access="read"/><property name="ScreenReaderEnabled" type="b" access="read"/></interface>
</node>'''
connection = api(gio, 'g_bus_get_sync', c.c_void_p, [c.c_int, c.c_void_p, c.c_void_p])(2, None, None)
info = api(gio, 'g_dbus_node_info_new_for_xml', c.c_void_p, [c.c_char_p, c.c_void_p])(xml, None)
if not connection or not info:
    raise SystemExit(1)

method_type = c.CFUNCTYPE(None, *([c.c_void_p] * 8))
property_type = c.CFUNCTYPE(c.c_void_p, *([c.c_void_p] * 7))


@method_type
def method(_connection, _sender, _path, _interface, method_name, _parameters, invocation, _data):
    if c.string_at(method_name) == b'GetAddress':
        value = api(glib, 'g_variant_new', c.c_void_p, [c.c_char_p, c.c_char_p])(b'(s)', os.environ['AT_SPI_BUS_ADDRESS'].encode())
        api(gio, 'g_dbus_method_invocation_return_value', None, [c.c_void_p, c.c_void_p])(invocation, value)


@property_type
def get_property(_connection, _sender, _path, _interface, property_name, _error, _data):
    return api(glib, 'g_variant_new_boolean', c.c_void_p, [c.c_int])(c.string_at(property_name) == b'IsEnabled')


class VTable(c.Structure):
    _fields_ = [('method', method_type), ('get_property', property_type), ('set_property', c.c_void_p), ('padding', c.c_void_p * 8)]


table = VTable(method, get_property, None)
for name in (b'org.a11y.Bus', b'org.a11y.Status'):
    interface = api(gio, 'g_dbus_node_info_lookup_interface', c.c_void_p, [c.c_void_p, c.c_char_p])(info, name)
    registered = api(gio, 'g_dbus_connection_register_object', c.c_uint, [c.c_void_p, c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p])(connection, b'/org/a11y/bus', interface, c.byref(table), None, None, None)
    if not registered:
        raise SystemExit(1)
api(gio, 'g_bus_own_name_on_connection', c.c_uint, [c.c_void_p, c.c_char_p, c.c_int, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p])(connection, b'org.a11y.Bus', 0, None, None, None, None)
loop = api(glib, 'g_main_loop_new', c.c_void_p, [c.c_void_p, c.c_int])(None, 0)
quit_loop = api(glib, 'g_main_loop_quit', None, [c.c_void_p])
signal.signal(signal.SIGTERM, lambda *_: quit_loop(loop))
tick_type = c.CFUNCTYPE(c.c_int, c.c_void_p)


@tick_type
def tick(_data):
    return 1  # Let Python deliver SIGTERM while the GLib loop is running.


api(glib, 'g_timeout_add', c.c_uint, [c.c_uint, tick_type, c.c_void_p])(200, tick, None)
api(glib, 'g_main_loop_run', None, [c.c_void_p])(loop)
