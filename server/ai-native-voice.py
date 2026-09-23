"""WeChat's own conversion menu. No recording, audio upload or ASR engine.

Requires a uniquely aligned visible history, an incoming voice bubble with its
own accessible bounds, and a conversion result inside that same row. Unknown
client layouts fail closed. Message text stays in the private request pipe.
"""
import ctypes as c
import re
import time

VOICE = re.compile(r'^(?:\[语音\]|语音消息|语音)(?:\s*\d{1,3}\s*(?:秒|["″”](?:秒)?))?\s*$')
VOICE_PREFIX = re.compile(r'^(?:\[语音\]|语音消息|语音)\s*\d{1,3}\s*(?:秒|["″”](?:秒)?)')
CONVERT = {'转文字', '转为文字', '转换为文字', '语音转文字'}
STATUS = re.compile(r'^(?:正在转换.*|转换中.*|转换失败.*|无法识别.*|识别失败.*|未播放|已播放|播放中|正在播放|暂停播放|播放语音|播放|重新转换|重试|收起|展开|转文字|转为文字|取消|已转文字|语音转文字)$')


def transcript(value):
    if not isinstance(value, str): return None
    value = value.strip()
    if not value or len(value) > 20000 or '\0' in value or VOICE.fullmatch(value) or STATUS.fullmatch(value): return None
    return value

def converted_transcript(value):
    if not isinstance(value, str): return None
    value = value.strip()
    if VOICE.fullmatch(value): return None
    prefix = VOICE_PREFIX.match(value)
    if not prefix: return None
    return transcript(value[prefix.end():].strip())


def voice_row(value):
    """Recognize raw, converted, and playback-status forms of a voice row."""
    if not isinstance(value, str): return False
    value = value.strip()
    if VOICE.fullmatch(value) or converted_transcript(value): return True
    prefix = VOICE_PREFIX.match(value)
    return bool(prefix and STATUS.fullmatch(value[prefix.end():].strip()))


def incoming_bubble_point(frame, bounds, incoming_color):
    """Find a click point from the verified incoming bubble pixels.

    The native row itself spans both sender lanes. Its accessible children may
    be unnamed, so fixed row-relative offsets can hit whitespace or another
    control. The rendering classifier has already established the incoming
    lane; require a substantial incoming-color run within that same row.
    """
    vx, vy, width, _ = frame.bounds
    x, y, w, h = bounds
    if x != vx or w != width or h < 39: raise ValueError('voice bubble unavailable')
    top = y - vy
    runs = []
    for yy in range(top + 8, top + min(h, 42)):
        start = None
        for xx in range(0, width):
            incoming = frame.pixel(xx, yy) == incoming_color
            if incoming and start is None: start = xx
            if start is not None and (not incoming or xx == width - 1):
                end = xx if not incoming else xx + 1
                if end - start >= 20 and end <= int(width * .48):
                    runs.append((end - start, start, end, yy))
                start = None
    if not runs: raise ValueError('voice bubble unavailable')
    longest = max(run[0] for run in runs)
    matching = [run for run in runs if run[0] == longest]
    _, left, right, py = matching[len(matching) // 2]
    px = (left + right) // 2
    if frame.pixel(px, py) != incoming_color: raise ValueError('voice bubble unavailable')
    return vx + px, vy + py


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


def rebase_visible_rows(rows, baseline, target_index, viewport_top, row_objects):
    """Allow only leading history to leave a virtualized viewport.

    The target and every retained row must still form an unchanged suffix of
    the previously verified snapshot. A changed target voice row may grow and
    change its accessible name, but cannot move any later message or admit a
    newly arrived tail message.
    """
    if not isinstance(row_objects, list) or len(row_objects) != len(rows):
        raise ValueError('voice context changed')
    current = []
    for index, (name, bounds) in enumerate(rows):
        if index == 0 and bounds[1] < viewport_top: continue
        current.append({'index': index, 'text': name, 'obj': row_objects[index]})
    if not current or len(current) > len(baseline): raise ValueError('voice context changed')
    start = len(baseline) - len(current)
    if target_index < start: raise ValueError('voice target left viewport')
    retained = baseline[start:]
    for offset, (item, expected) in enumerate(zip(current, retained)):
        baseline_index = start + offset
        # A retained row must be the same accessible object even when its
        # accessible name is unchanged; names/durations are not identities.
        if expected.get('obj') != item['obj']:
            raise ValueError('voice context changed')
        if baseline_index == target_index:
            old_prefix = VOICE_PREFIX.match(expected['text']) if expected.get('type') == 'voice' else None
            new_prefix = VOICE_PREFIX.match(item['text'])
            if (not old_prefix or not new_prefix or not voice_row(item['text'])
                    or old_prefix.group(0) != new_prefix.group(0) or expected.get('obj') != item['obj']):
                raise ValueError('voice target changed')
        elif item['text'] != expected['text']:
            old_prefix = VOICE_PREFIX.match(expected['text']) if expected.get('type') == 'voice' else None
            new_prefix = VOICE_PREFIX.match(item['text']) if old_prefix else None
            # Only a raw/status voice can transition. Once it had a transcript,
            # a different transcript is ambiguous and must fail closed.
            old_unresolved = bool(old_prefix and not converted_transcript(expected['text']))
            if (not old_unresolved or not new_prefix or not voice_row(item['text'])
                    or old_prefix.group(0) != new_prefix.group(0) or expected.get('obj') != item['obj']):
                raise ValueError('voice context changed')
    # At least one unchanged text message must remain beside the target. Voice
    # rows alone cannot prove that a similarly sized replacement is the same
    # native message after virtualization.
    target_offset = target_index - start
    if not any(offset != target_offset and entry.get('type') != 'voice'
               and entry.get('direction') in ('self', 'other')
               for offset, entry in enumerate(retained)):
        raise ValueError('voice context ambiguous')
    return current[target_offset]['index']


def convert(adapter, request, account, contact):
    ins = adapter.controls
    if not adapter.session_identity: raise ValueError('voice requires background identity')
    adapter.verify_session(); layout = ins.locate()
    if layout['label'] != contact['label'] or ins._visible_roots(layout['app'], layout['frame']): raise ValueError('voice target changed')
    viewport = ins.bounds(layout['message_list']); native = adapter.rows(layout)
    visible, baseline = [], []
    with adapter.render.DesktopFrame(viewport) as frame:
        for i, (name, bounds) in enumerate(native):
            ins.check()
            if i == 0 and bounds[1] < viewport[1]: continue
            voice = voice_row(name)
            direction = frame.direction('语音消息' if voice else name, bounds)
            item = {'text': name, 'direction': direction, **({'type': 'voice'} if voice else {}),
                    'index': i, 'obj': ins.call('get_child_at_index', c.c_void_p, layout['message_list'], i)}
            baseline.append(item)
            if direction != 'system': visible.append(item)
    target_visible_index = align(visible, request.get('messages'), request.get('messageId'))
    index = visible[target_visible_index]['index']
    target_baseline_index = next(i for i, item in enumerate(baseline) if item['index'] == index)
    row = ins.call('get_child_at_index', c.c_void_p, layout['message_list'], index)
    nodes = ins.tree(row)
    voice_label = ins.string('get_name', row).strip()
    already_converted = converted_transcript(voice_label)
    if already_converted:
        return {'account': account, 'contact': contact['id'], 'messageId': request['messageId'], 'text': already_converted}
    # A list row spans both sender lanes; never right-click its centre. Require
    # the voice widget's actual accessible bounds wholly inside the viewport.
    widgets = [n for n in nodes if n['obj'] != row and voice_row(n['name']) and
               ins.visible(n['obj']) and n['bounds'] and 0 < n['bounds'][2] < viewport[2] * .7 and
               n['bounds'][0] >= viewport[0] and n['bounds'][1] >= viewport[1] and
               n['bounds'][0] + n['bounds'][2] <= viewport[0] + viewport[2] and n['bounds'][1] + n['bounds'][3] <= viewport[1] + viewport[3]]
    positions = {n['bounds'] for n in widgets}
    if len(positions) > 1: raise ValueError('voice bubble unavailable')
    if positions:
        x, y, w, h = positions.pop(); click_point = (x + w // 2, y + h // 2)
    elif voice_row(voice_label) and ins.visible(row):
        with adapter.render.DesktopFrame(viewport) as frame:
            if frame.direction('语音消息', native[index][1]) != 'other': raise ValueError('voice target changed')
            click_point = incoming_bubble_point(frame, native[index][1], adapter.render.INCOMING)
    else: raise ValueError('voice bubble unavailable')
    before_names = {n['name'] for n in nodes}
    def unchanged():
        nonlocal row, index
        ins.check(); ins.require_foreground('微信'); adapter.verify_session()
        fresh = ins.locate()
        if any(fresh[k] != layout[k] for k in ('app', 'frame', 'message_list', 'label')): raise ValueError('voice target changed')
        if ins.bounds(fresh['message_list']) != viewport: raise ValueError('voice viewport changed')
        rows = adapter.rows(fresh)
        row_objects = [ins.call('get_child_at_index', c.c_void_p, fresh['message_list'], i) for i in range(len(rows))]
        index = rebase_visible_rows(rows, baseline, target_baseline_index, viewport[1], row_objects)
        row = ins.call('get_child_at_index', c.c_void_p, fresh['message_list'], index)
        if not voice_row(ins.string('get_name', row)): raise ValueError('voice row changed')
    unchanged()
    ins.move_pointer(*click_point)
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
            # WeChat 4.1.23 may expose the converted text only by replacing
            # the list-row name, without adding a text child.
            row_name = ins.string('get_name', row).strip()
            if row_name != voice_label:
                values.add(converted_transcript(row_name))
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
