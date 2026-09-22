"""Navigate only; never edit the composer or send a message.

The server resolves the requested ID in authenticated database history. Native
rows must match a unique multi-message sequence, including a surrounding anchor.
Repeated/ambiguous text cannot establish a message identity by itself.
"""
def align(rows, messages, target):
    messages = [m for m in messages if m.get('direction') != 'system' and m.get('text')]
    targets = [i for i, m in enumerate(messages) if m.get('id') == target and m.get('direction') == 'self']
    if len(targets) != 1 or len(rows) < 3: return None
    signature = lambda m: (m.get('direction'), m.get('text'))
    visible = [signature(m) for m in rows]
    candidates = [i for i in range(len(messages) - len(rows) + 1)
                  if visible == [signature(m) for m in messages[i:i + len(rows)]]]
    if len(candidates) != 1: return None
    start, target_index = candidates[0], targets[0]
    if not start <= target_index < start + len(rows): return None
    # At least one other message must be a unique anchor in the DB context.
    anchors = [signature(m) for m in messages[start:start + len(rows)] if m.get('id') != target]
    if not any(sum(signature(m) == anchor for m in messages) == 1 for anchor in anchors): return None
    return target_index - start


def locate(adapter, request, label):
    ins = adapter.controls
    messages, target = request.get('messages'), request.get('messageId')
    if not adapter.session_identity or not isinstance(messages, list) or not 3 <= len(messages) <= 61: return False
    previous = None
    for _ in range(18):
        ins.check(); adapter.verify_session(); ins.require_foreground('微信')
        layout = ins.locate()
        if layout['label'] != label or ins._visible_roots(layout['app'], layout['frame']): raise ValueError('target changed')
        viewport, native = ins.bounds(layout['message_list']), adapter.rows(layout)
        visible = []
        with adapter.render.DesktopFrame(viewport) as frame:
            for name, bounds in native:
                if bounds[1] < viewport[1] or bounds[1] + bounds[3] > viewport[1] + viewport[3]: continue
                direction = frame.direction(name, bounds)
                if direction != 'system': visible.append({'direction': direction, 'text': name, 'bounds': bounds})
        index = align(visible, messages, target)
        if index is not None:
            adapter.verify_session()
            fresh = ins.locate()
            if fresh['label'] != label or adapter.rows(fresh) != native: raise ValueError('history changed')
            x, y, w, h = visible[index]['bounds']
            ins.move_pointer(x + w // 2, y + h // 2)
            return True
        signature = [(name, bounds) for name, bounds in native]
        if signature == previous: return False
        previous = signature
        ins.scroll_directory('up', {**layout, 'contact_list': layout['message_list']})
    return False
