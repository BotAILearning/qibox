"""Navigate only; never edit the composer or send a message.

The server resolves the requested ID in authenticated database history. Native
rows must match a unique multi-message sequence, including a verified anchor.
Low-confidence bubble pixels may leave a row direction unknown, but its text
must still participate in the unique sequence and a classified anchor must
confirm the contact and viewport alignment.
"""
import re


MEDIA_LABEL = re.compile(r'\[(?:图片|动画表情|视频|语音|文件|位置|链接|聊天记录|小程序|视频号|转账|红包)\].*', re.S)


def _media(message):
    return bool(MEDIA_LABEL.fullmatch((message.get('text') or '').strip()))


def align(rows, messages, target):
    messages = [m for m in messages if m.get('direction') != 'system' and m.get('text')
                and (m.get('id') == target or not _media(m))]
    target_messages = [m for m in messages if m.get('id') == target and m.get('direction') in ('self', 'other')]
    if len(target_messages) != 1: return None
    target_direction = target_messages[0].get('direction')
    targets = [i for i, m in enumerate(messages) if m.get('id') == target and m.get('direction') == target_direction]
    if len(targets) != 1 or len(rows) < 3: return None
    if any(row.get('direction') not in ('self', 'other', 'unknown') or not row.get('text') for row in rows): return None
    candidates = [i for i in range(len(messages) - len(rows) + 1)
                  if all(row.get('text') == message.get('text') and
                         (row.get('direction') == 'unknown' or row.get('direction') == message.get('direction'))
                         for row, message in zip(rows, messages[i:i + len(rows)]))]
    if len(candidates) != 1: return None
    start, target_index = candidates[0], targets[0]
    if not start <= target_index < start + len(rows): return None
    anchors = [(messages[start + offset].get('direction'), row.get('text'))
               for offset, row in enumerate(rows)
               if messages[start + offset].get('id') != target and row.get('direction') in ('self', 'other')]
    if not any(sum((m.get('direction'), m.get('text')) == anchor for m in messages) == 1 for anchor in anchors): return None
    return target_index - start


def locate(adapter, request, label):
    ins = adapter.controls
    messages, target = request.get('messages'), request.get('messageId')
    if not adapter.session_identity or not isinstance(messages, list) or not 3 <= len(messages) <= 61:
        return False
    clean_messages = [m for m in messages if m.get('direction') != 'system' and m.get('text')
                      and (m.get('id') == target or not _media(m))]

    def verified_layout():
        ins.check(); adapter.verify_session(); ins.require_foreground('微信')
        layout = ins.locate()
        if layout['label'] != label or ins._visible_roots(layout['app'], layout['frame']):
            raise ValueError('target changed')
        return layout

    layout = verified_layout()
    stable_at_latest = False
    previous = None
    # open-chat can leave a prior viewport at the oldest part of history. First
    # return the message list to its latest stable viewport, then search upward.
    for _ in range(18):
        native = adapter.rows(layout)
        before = [(name, bounds) for name, bounds in native]
        if previous is not None and before == previous:
            stable_at_latest = True
            break
        previous = before
        ins.scroll_directory('down', {**layout, 'contact_list': layout['message_list']})
        layout = verified_layout()
        after = [(name, bounds) for name, bounds in adapter.rows(layout)]
        if after == before:
            stable_at_latest = True
            break
    if not stable_at_latest:
        return False

    previous = None
    for _ in range(18):
        layout = verified_layout()
        viewport = ins.bounds(layout['message_list'])
        native = adapter.rows(layout)
        visible = []
        with adapter.render.DesktopFrame(viewport) as frame:
            for name, bounds in native:
                vx, vy, vw, vh = viewport
                x, y, w, h = bounds
                if x != vx or w != vw or h < 39 or y < vy or y + h > vy + vh: continue
                try:
                    direction = frame.direction(name, bounds)
                except ValueError as error:
                    reason = error.args[0] if error.args else ''
                    media = bool(adapter.render.MEDIA_LABEL.fullmatch(name.strip()))
                    if reason == 'unsupported message rendering':
                        direction = 'unknown'
                    elif reason == 'unsupported message content' and media:
                        # Non-target attachment rows may be absent from parsed
                        # history. Keep a target attachment only when its exact
                        # ID and text are in the authenticated message context.
                        if not any(m.get('id') == target and m.get('text') == name for m in clean_messages): continue
                        direction = 'unknown'
                    else:
                        return False
                if direction != 'system': visible.append({'direction': direction, 'text': name, 'bounds': bounds})
        index = align(visible, messages, target)
        if index is not None:
            layout = verified_layout()
            if adapter.rows(layout) != native: raise ValueError('history changed')
            x, y, w, h = visible[index]['bounds']
            ins.move_pointer(x + w // 2, y + h // 2)
            return True
        signature = [(name, bounds) for name, bounds in native]
        if signature == previous: return False
        previous = signature
        ins.scroll_directory('up', {**layout, 'contact_list': layout['message_list']})
    return False
