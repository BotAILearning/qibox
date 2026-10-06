"""Paste into the user's focused WeChat field and acknowledge actual UI insertion.

Uses normal Ctrl+V and read-only accessibility verification. Never navigates,
presses Send, modifies WeChat files, or logs field contents.
"""
import ctypes as c
import importlib.util
import json
import pathlib
import sys
import time

spec = importlib.util.spec_from_file_location('manual_text_controls', pathlib.Path(__file__).with_name('ai-native-controls.py'))
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


class Range(c.Structure):
    _fields_ = [('start', c.c_int), ('end', c.c_int)]


def focused(ins):
    ins.require_foreground()
    nodes = ins.tree(ins.application(), prune_lists=True)
    node = controls.unique([n for n in nodes if controls.shown(n) and 12 in n['states'] and 'editable_text' in n['interfaces']], nodes)
    return node['obj']


def text_call(ins, obj, method, result, *args):
    ins.check()
    iface = ins.bind('atspi_accessible_get_text_iface', c.c_void_p, [c.c_void_p])(obj)
    if not iface:
        raise ValueError('text unavailable')
    error = c.c_void_p()
    value = ins.bind('atspi_text_' + method, result, [c.c_void_p] + [c.c_int] * len(args) + [c.POINTER(c.c_void_p)])(iface, *args, c.byref(error))
    if error.value:
        ins.glib.g_error_free(error)
        raise ValueError('text unavailable')
    return value


def value(ins, obj):
    pointer = text_call(ins, obj, 'get_text', c.c_void_p, 0, -1)
    if not pointer:
        raise ValueError('text unavailable')
    try:
        data = c.string_at(pointer)
        if len(data) > 120000:
            raise ValueError('field too large')
        return data.decode('utf8')
    finally:
        ins.glib.g_free(pointer)


def expected_text(before, inserted, start, end, count):
    inserted = inserted.replace('\r\n', '\n').replace('\r', '\n')
    if not 0 <= start <= end <= count:
        raise ValueError('invalid selection')
    if count == len(before):
        return before[:start] + inserted + before[end:]
    encoded = before.encode('utf-16-le')
    if count != len(encoded) // 2:
        raise ValueError('unsupported text offsets')
    return encoded[:start * 2].decode('utf-16-le') + inserted + encoded[end * 2:].decode('utf-16-le')


def paste_keys():
    # Reading accessibility controls does not initialize the inspector's
    # pointer helper. Open an independent X11 connection without moving focus.
    with controls.x11_connection() as (xlib, display, errors):
        xtest = c.CDLL('libXtst.so.6')
        xlib.XKeysymToKeycode.argtypes = [c.c_void_p, c.c_ulong]
        xlib.XKeysymToKeycode.restype = c.c_uint
        xtest.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
        control = xlib.XKeysymToKeycode(display, 0xffe3)
        key = xlib.XKeysymToKeycode(display, ord('v'))
        if not control or not key or errors:
            raise ValueError('paste key unavailable')
        try:
            xtest.XTestFakeKeyEvent(display, control, 1, 0)
            xtest.XTestFakeKeyEvent(display, key, 1, 0)
            xtest.XTestFakeKeyEvent(display, key, 0, 0)
        finally:
            xtest.XTestFakeKeyEvent(display, control, 0, 0)
            xlib.XSync(display, False)
        if errors:
            raise ValueError('paste key unavailable')


def paste(ins, inserted):
    obj = focused(ins)
    before = value(ins, obj)
    count = text_call(ins, obj, 'get_character_count', c.c_int)
    selections = text_call(ins, obj, 'get_n_selections', c.c_int)
    if selections == 0:
        start = end = text_call(ins, obj, 'get_caret_offset', c.c_int)
    elif selections == 1:
        selected = text_call(ins, obj, 'get_selection', c.POINTER(Range), 0)
        if not selected:
            raise ValueError('selection unavailable')
        try:
            start, end = sorted([selected.contents.start, selected.contents.end])
        finally:
            ins.glib.g_free(selected)
    else:
        raise ValueError('ambiguous selection')
    expected = expected_text(before, inserted, start, end, count)
    ins.require_foreground()
    if 12 not in ins.states(obj) or value(ins, obj) != before:
        raise ValueError('focus changed')
    paste_keys()
    for _ in range(60):
        ins.check()
        ins.require_foreground()
        if 12 not in ins.states(obj):
            raise ValueError('focus changed')
        if value(ins, obj) == expected:
            return
        time.sleep(.025)
    raise ValueError('paste not confirmed')


if __name__ == '__main__':
    try:
        text = sys.stdin.buffer.read(60001).decode('utf8')
        if not text or len(text.encode('utf8')) > 60000 or '\0' in text:
            raise ValueError('invalid text')
        with controls.NativeControls(int(sys.argv[1]), seconds=6) as inspector:
            paste(inspector, text)
        print('{"ready":true}', flush=True)
    except Exception:
        print('{"ready":false}', flush=True)
        raise SystemExit(1)
