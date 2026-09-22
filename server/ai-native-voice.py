"""WeChat's own conversion menu. No recording, audio upload or ASR engine.

Requires a uniquely aligned visible history, an incoming voice bubble with its
own accessible bounds, and a conversion result inside that same row. Unknown
client layouts fail closed. Message text stays in the private request pipe.
"""
import ctypes as c
import re
import time

VOICE = re.compile(r'^(?:\[语音\]|语音消息|语音)(?:\s*\d{1,3}\s*(?:秒|["″”]))?\s*$')
CONVERT = {'转文字', '转为文字', '转换为文字'}
STATUS = re.compile(r'^(?:正在转换.*|转换中.*|转换失败.*|无法识别.*|识别失败.*|重新转换|重试|收起|展开|转文字|转为文字|取消|已转文字|语音转文字)$')


def transcript(value):
    if not isinstance(value, str): return None
    value = value.strip()
    if not value or len(value) > 20000 or '\0' in value or VOICE.fullmatch(value) or STATUS.fullmatch(value): return None
    return value


def align(rows, messages, target):
    """Require the complete visible suffix and a unique retained text anchor."""
    if not isinstance(messages, list) or not 2 <= len(messages) <= 60: raise ValueError('voice context unavailable')
    messages = [m for m in messages if m.get('direction') != 'system']
    candidates = [i for i, m in enumerate(messages) if m.get('id') == target and m.get('type') == 'voice' and m.get('direction') == 'other']
    if len(candidates) != 1: raise ValueError('incoming voice unavailable')
    # Native history includes date/time separator rows; callers remove only
    # independently classified system rows, never arbitrary unknown messages.
    if len(rows) > len(messages) or len(rows) < 2: raise ValueError('voice context unavailable')
    def signature(m): return (m['direction'], '[语音]' if m.get('type') == 'voice' else m['text'])
    visible = [signature(m) for m in rows]
    start = len(messages) - len(rows)
    if visible != [signature(m) for m in messages[start:]]: raise ValueError('voice context changed')
    anchor = [m['text'] for m in rows if m.get('type') != 'voice' and m.get('direction') in ('self', 'other')]
    if not anchor or not any(sum(x.get('text') == text and x.get('type') != 'voice' for x in messages) == 1 for text in anchor):
        raise ValueError('voice context ambiguous')
    index = candidates[0] - start
    if index < 0: raise ValueError('voice outside viewport')
    return index


def convert(adapter, request, account, contact):
    ins = adapter.controls
    if not adapter.session_identity: raise ValueError('voice requires background identity')
    adapter.verify_session(); layout = ins.locate()
    if layout['label'] != contact['label'] or ins._visible_roots(layout['app'], layout['frame']): raise ValueError('voice target changed')
    viewport = ins.bounds(layout['message_list']); native = adapter.rows(layout)
    visible = []
    with adapter.render.DesktopFrame(viewport) as frame:
        for i, (name, bounds) in enumerate(native):
            ins.check()
            if i == 0 and bounds[1] < viewport[1]: continue
            voice = bool(VOICE.fullmatch(name.strip()))
            direction = frame.direction('语音消息' if voice else name, bounds)
            if direction != 'system': visible.append({'text': name, 'direction': direction, **({'type': 'voice'} if voice else {}), 'index': i})
    index = visible[align(visible, request.get('messages'), request.get('messageId'))]['index']
    row = ins.call('get_child_at_index', c.c_void_p, layout['message_list'], index)
    nodes = ins.tree(row)
    # A list row spans both sender lanes; never right-click its centre. Require
    # the voice widget's actual accessible bounds wholly inside the viewport.
    widgets = [n for n in nodes if n['obj'] != row and VOICE.fullmatch(n['name'].strip()) and
               ins.visible(n['obj']) and n['bounds'] and 0 < n['bounds'][2] < viewport[2] * .7 and
               n['bounds'][0] >= viewport[0] and n['bounds'][1] >= viewport[1] and
               n['bounds'][0] + n['bounds'][2] <= viewport[0] + viewport[2] and n['bounds'][1] + n['bounds'][3] <= viewport[1] + viewport[3]]
    positions = {n['bounds'] for n in widgets}
    if len(positions) != 1: raise ValueError('voice bubble unavailable')
    before_names = {n['name'] for n in nodes}
    def unchanged():
        ins.check(); ins.require_foreground('微信'); adapter.verify_session()
        fresh = ins.locate()
        if any(fresh[k] != layout[k] for k in ('app', 'frame', 'message_list', 'label')): raise ValueError('voice target changed')
        rows = adapter.rows(fresh)
        if len(rows) != len(native) or any(a[0] != b[0] for i, (a, b) in enumerate(zip(rows, native)) if i != index): raise ValueError('voice context changed')
        if ins.call('get_child_at_index', c.c_void_p, fresh['message_list'], index) != row: raise ValueError('voice row changed')
    unchanged()
    x, y, w, h = positions.pop()
    ins.move_pointer(x + w // 2, y + h // 2)
    ins.xtest.XTestFakeButtonEvent(ins.display, 3, 1, 0); ins.xtest.XTestFakeButtonEvent(ins.display, 3, 0, 0); ins.xlib.XFlush(ins.display)
    menu = True
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            ins.check(); adapter.verify_session()
            candidates = [n for n in ins.tree(layout['app'], prune_lists=True) if n['name'] in CONVERT and n['role'] in ('menu item', 'push button') and ins.visible(n['obj'])]
            if candidates: break
            time.sleep(.1)
        if len(candidates) != 1: raise ValueError('WeChat conversion unavailable')
        unchanged(); ins.press(candidates[0]['obj']); menu = False
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            unchanged()
            fresh = ins.tree(row)
            values = {transcript(n['name']) for n in fresh if n['role'] in ('text', 'label') and n['name'] not in before_names and ins.visible(n['obj'])}
            values.discard(None)
            if len(values) == 1:
                value = values.pop(); unchanged()
                return {'account': account, 'contact': contact['id'], 'messageId': request['messageId'], 'text': value}
            if len(values) > 1: raise ValueError('ambiguous conversion result')
            time.sleep(.2)
        raise ValueError('WeChat conversion timed out')
    finally:
        if menu:
            # Dismiss only our context menu; never type into the editor.
            def dismiss():
                ins.require_foreground('微信'); adapter.verify_session()
                menus = [n for n in ins.tree(layout['app'], prune_lists=True) if n['role'] in ('popup menu', 'menu') and ins.visible(n['obj'])]
                if len(menus) != 1: return
                ins.xlib.XKeysymToKeycode.argtypes = [c.c_void_p, c.c_ulong]; ins.xlib.XKeysymToKeycode.restype = c.c_uint
                ins.xtest.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
                key = ins.xlib.XKeysymToKeycode(ins.display, 0xff1b)
                ins.xtest.XTestFakeKeyEvent(ins.display, key, 1, 0); ins.xtest.XTestFakeKeyEvent(ins.display, key, 0, 0); ins.xlib.XFlush(ins.display)
            try: ins._cleanup_budget(dismiss)
            except Exception: pass
