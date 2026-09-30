"""Open the current focused chat's file picker. Never press Send or navigate."""
import importlib.util
import json
import pathlib
import sys
import time
import ctypes as c

spec = importlib.util.spec_from_file_location('qibox_manual_controls', pathlib.Path(__file__).with_name('ai-native-controls.py'))
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)


def editor_text(ins, obj):
    iface = ins.bind('atspi_accessible_get_text_iface', c.c_void_p, [c.c_void_p])(obj)
    if not iface:
        raise ValueError('text unavailable')
    error = c.c_void_p()
    pointer = ins.bind('atspi_text_get_text', c.c_void_p, [c.c_void_p, c.c_int, c.c_int, c.POINTER(c.c_void_p)])(iface, 0, -1, c.byref(error))
    if error.value or not pointer:
        if error.value:
            ins.glib.g_error_free(error)
        raise ValueError('text unavailable')
    try:
        value = c.string_at(pointer).decode('utf-8')
        if len(value) > 20000:
            raise ValueError('draft too large')
        return value
    finally:
        ins.glib.g_free(pointer)


def open_picker(ins):
    ins.require_foreground('微信')
    layout = ins.locate()
    if ins._visible_roots(layout['app'], layout['frame']):
        raise ValueError('existing dialog')
    # AT-SPI FOCUSABLE=11, FOCUSED=12. Focus must already be in this editor;
    # a drop on a search, login or another field must not select a chat for it.
    if 12 not in ins.states(layout['editor']):
        raise ValueError('chat editor not focused')
    attach = ins.find(layout['frame'], '发送文件', 'push button', True)
    if not attach or not ins.visible(attach):
        raise ValueError('file picker unavailable')
    current = ins.locate()
    if current['editor'] != layout['editor'] or current['label'] != layout['label']:
        raise ValueError('chat changed')
    ins.require_foreground('微信')
    if 12 not in ins.states(current['editor']):
        raise ValueError('focus changed')
    before = editor_text(ins, current['editor'])
    ins.press(attach)
    return current, before


def wait_for_files(ins, original, before, names):
    stable = 0
    for _ in range(20):
        time.sleep(.1)
        ins.check()
        current = ins.locate()
        if any(current[key] != original[key] for key in ('app', 'frame', 'header', 'editor', 'label')):
            raise ValueError('chat changed')
        roots = ins._visible_roots(current['app'], current['frame'])
        if roots:
            stable = 0
            if len(roots) != 1:
                continue
            nodes = ins.tree(roots[0])
            if not all(any(name in node['name'] for node in nodes) for name in names):
                continue
            if not ins.find(roots[0], '发送', 'push button', True) or not ins.find(roots[0], '取消', 'push button', True):
                continue
            ins.require_foreground()
            return True
        ins.require_foreground('微信')
        after = editor_text(ins, current['editor'])
        added = after.count('\ufffc') - before.count('\ufffc')
        if added == len(names) and after.replace('\ufffc', '').strip() == before.replace('\ufffc', '').strip():
            stable += 1
            if stable >= 2:
                return True
        else:
            stable = 0
    raise ValueError('file preview unavailable')


if __name__ == '__main__':
    phase = 'focus'
    try:
        names = json.loads(sys.argv[1])
        if not isinstance(names, list) or not 1 <= len(names) <= 10 or not all(isinstance(name, str) for name in names):
            raise ValueError('invalid files')
        with controls.NativeControls(int(sys.argv[2]), seconds=10) as inspector:
            original, before = open_picker(inspector)
            phase = 'preview'
            wait_for_files(inspector, original, before, names)
        print('{"ready":true}', flush=True)
    except Exception:
        # No content, contact names or native diagnostics enter the response.
        print(json.dumps({'ready': False, 'reason': phase}), flush=True)
