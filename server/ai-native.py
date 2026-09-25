"""External Linux WeChat text adapter; no hooks or patches.

Current native account/contact fields establish identity. AT-SPI names and
independently checked live rendering form a bounded text snapshot. The parent
assigns temporary message IDs in memory. Content never goes to files or logs.
"""
import ctypes as c
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import select
import signal
import sys
import time


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def contact_key(account, contact):
    return digest(account + '\0' + contact['id'])


def snapshot_revision(messages):
    return digest(json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def confirmed_append(before, after, text):
    """A unique retained suffix followed by one outgoing text and optional time."""
    if not after or after[-1] != {'direction': 'self', 'text': text}:
        return False
    if not before:
        return all(m['direction'] == 'system' for m in after[:-1])
    overlaps = [k for k in range(1, min(len(before), len(after))+1) if before[-k:] == after[:k]]
    if len(overlaps) != 1 or overlaps[0] >= len(after):
        return False
    additions = after[overlaps[0]:]
    return all(m['direction'] == 'system' for m in additions[:-1])


class SnapshotChanged(ValueError):
    """Rows changed inside an otherwise verified, unchanged native session."""


class ChatAdapter:
    def __init__(self, pid, seconds=28):
        self.controls = module('qibox_ai_controls', 'ai-native-controls.py').NativeControls(pid, seconds=seconds)
        self.render = module('qibox_ai_render', 'ai-native-render.py')
        self.possibly_written = False
        self.owned_draft = None
        self.send_pressed = False
        self.send_confirmed = False
        self.session_identity = None
        self.background_target = None
        self.phase = 'native-session'

    def verify_session(self):
        """Read the current account/session again; labels are never identity."""
        if getattr(self, 'session_identity', None) is not None:
            self.session_identity.verify(**self.background_target)

    def open_chat(self, request, account, contact):
        ins = self.controls
        ins.check(); self.verify_session()
        if ins.locate()['label'] != contact['label']:
            raise ValueError('chat changed while navigating')
        self.phase = 'native-chat-opened'
        return {'account': account, 'contact': contact['id'], 'opened': True}

    def resolve_background(self, request):
        ins = self.controls
        target = request.get('background')
        if (not isinstance(target, dict) or set(target) != {'account', 'contact'}
                or any(not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v) for v in target.values())
                or any(not isinstance(request.get(k), str) or not re.fullmatch('[a-f0-9]{64}', request[k]) for k in ('account', 'contact'))):
            raise ValueError('invalid session identity')
        label = request.get('label')
        if not isinstance(label, str) or not 0 < len(label) <= 120:
            raise ValueError('invalid target')
        self.session_identity = module('qibox_wechat_session', 'wechat-session.py').SessionIdentity(
            ins.pid, os.environ['HOME'], fd=3, check=ins.check, hint=request.get('sessionHint'))
        self.background_target = dict(target)
        self.phase = 'native-navigation'
        # SessionIdentity authenticates which chat is selected in WeChat's
        # private session model, but the visible window may still be on another
        # tab (for example Contacts). Always restore the chat tab before using
        # conversation controls, even when the private identity already matches.
        ins.ensure_conversations()
        # When the target is already selected, avoid scanning the virtualized
        # conversation list. Live session identity and header are still checked.
        if not self.session_identity.matches(**target):
            ins.navigate_background(label, self.verify_session,
                                    expected_contact=request['contact'], account=request['account'], group=request.get('kind') == 'group')
        self.verify_session()
        self.phase = 'native-prepare'
        ins.require_foreground('微信')
        actual_label = ins.locate()['label']
        group_header = request.get('kind') == 'group' and re.fullmatch(re.escape(label) + r'\s*[（(]\d+[）)]', actual_label)
        if actual_label != label and not group_header:
            raise ValueError('target changed')
        return {'account': request['account'], 'contact': {'id': request['contact'], 'label': actual_label, 'kind': request.get('kind', 'person')}}

    def editor_text(self, obj):
        ins = self.controls
        iface = ins.bind('atspi_accessible_get_text_iface', c.c_void_p, [c.c_void_p])(obj)
        if not iface:
            raise ValueError('text unavailable')
        error = c.c_void_p()
        ptr = ins.bind('atspi_text_get_text', c.c_void_p, [c.c_void_p, c.c_int, c.c_int, c.POINTER(c.c_void_p)])(iface, 0, -1, c.byref(error))
        if error.value or not ptr:
            if error.value:
                ins.glib.g_error_free(error)
            raise ValueError('text unavailable')
        try:
            text = c.string_at(ptr).decode('utf-8')
            if len(text) > 20000:
                raise ValueError('draft too large')
            return text
        finally:
            ins.glib.g_free(ptr)

    def write_text(self, obj, text):
        ins = self.controls
        ins.check()
        iface = ins.bind('atspi_accessible_get_editable_text_iface', c.c_void_p, [c.c_void_p])(obj)
        if not iface:
            raise ValueError('editor unavailable')
        error = c.c_void_p()
        self.possibly_written = True
        ok = ins.bind('atspi_editable_text_set_text_contents', c.c_int, [c.c_void_p, c.c_char_p, c.POINTER(c.c_void_p)])(iface, text.encode(), c.byref(error))
        if not ok or error.value:
            if error.value:
                ins.glib.g_error_free(error)
            raise ValueError('edit unavailable')

    def rows(self, layout):
        ins = self.controls
        count = ins.call('get_child_count', c.c_int, layout['message_list'])
        if not 0 <= count <= 300:
            raise ValueError('message range unavailable')
        result = []
        for i in range(count):
            row = ins.call('get_child_at_index', c.c_void_p, layout['message_list'], i)
            if ins.string('get_role_name', row) != 'list item':
                raise ValueError('message row unavailable')
            result.append((ins.string('get_name', row), ins.bounds(row)))
        return result

    def snapshot(self, account, contact, label):
        ins = self.controls
        ins.require_foreground('微信')
        layout = ins.locate()
        if layout['label'] != label or ins._visible_roots(layout['app'], layout['frame']):
            raise ValueError('target changed')
        viewport = ins.bounds(layout['message_list'])
        rows = self.rows(layout)
        messages = []
        with self.render.DesktopFrame(viewport) as frame:
            for index, (text, bounds) in enumerate(rows):
                ins.check()
                # Only a partially clipped first historical row is excluded.
                # An unknown/clipped latest message must stop the operation.
                if index == 0 and bounds[1] < viewport[1] and len(rows) > 1:
                    continue
                direction = frame.direction(text, bounds)
                messages.append({'direction': direction, 'text': text})
        ins.refresh(layout['app'])
        fresh = ins.locate()
        if fresh['label'] != label or ins._visible_roots(fresh['app'], fresh['frame']) or ins.bounds(fresh['message_list']) != viewport or self.rows(fresh) != rows:
            raise ValueError('messages changed while reading')
        ins.require_foreground('微信')
        if len(json.dumps(messages, ensure_ascii=False)) > 90000:
            raise ValueError('message range too large')
        return {'account': account, 'contact': contact, 'messages': messages, 'revision': snapshot_revision(messages)}, fresh

    def resolve(self, request):
        ins = self.controls
        if 'background' in request:
            return self.resolve_background(request)
        account = ins.account()
        if not account or account != request.get('account'):
            return {'available': False, 'error': 'account-changed', 'account': account}
        label = request.get('label')
        if not isinstance(label, str) or not 0 < len(label) <= 120:
            raise ValueError('invalid target')
        if request.get('source') == 'contacts':
            open_chat = request.get('action') in ('read', 'send', 'read-guard', 'send-guard', 'prepare-send', 'open-chat')
            current = None
            if open_chat:
                try:
                    current = ins.locate()
                except (ValueError, RuntimeError):
                    ins.check()
            if current and current['label'] == label:
                contact = ins.contact()
            else:
                # Existing conversations avoid a full directory traversal.
                # The row is only a candidate: navigate() opens its live
                # personal profile and the account-scoped key is checked below.
                candidates = [row for row in ins.scan() if row['label'] == label] if current and open_chat else []
                if len(candidates) == 1 and ins.visible(candidates[0]['obj']):
                    contact = ins.navigate(label)
                else:
                    contact = ins.directory_contact(label, open_chat=open_chat,
                                                    expected_contact=request.get('contact'), account=account)
        else:
            contact = ins.navigate(label)
        target = {'id': contact_key(account, contact), 'label': contact['label'], 'kind': contact['kind']}
        if request.get('contact') and target['id'] != request['contact']:
            return {'available': False, 'error': 'target-changed', 'account': account}
        return {'account': account, 'contact': target}

    def guard_snapshot(self, account, contact, label):
        """Opaque change guard only; chat content/directions come from the data API.

        No rendered bubble colours or parsed messages are returned. The database
        bridge must independently confirm a new outgoing message after dispatch.
        """
        ins = self.controls
        ins.require_foreground('微信')
        self.verify_session()
        layout = ins.locate()
        if layout['label'] != label or ins._visible_roots(layout['app'], layout['frame']):
            raise ValueError('target changed')
        viewport, rows = ins.bounds(layout['message_list']), self.rows(layout)
        fresh = ins.locate()
        if (any(fresh[key] != layout[key] for key in ('app', 'frame', 'header', 'editor', 'message_list', 'label'))
                or fresh['label'] != label or ins._visible_roots(fresh['app'], fresh['frame'])
                or ins.bounds(fresh['message_list']) != viewport):
            raise ValueError('target changed')
        fresh_rows = self.rows(fresh)
        ins.require_foreground('微信')
        self.verify_session()
        if fresh_rows != rows:
            raise SnapshotChanged('messages changed while checking')
        revision = digest(json.dumps([account, contact, label, viewport, rows], ensure_ascii=False, separators=(',', ':')))
        return {'account': account, 'contact': contact, 'revision': revision}, fresh

    def execute(self, request, commit=None):
        ins = self.controls
        action = request.get('action')
        if action == 'input-status':
            # Inspect only; never navigate, erase a draft or press Send here.
            ins.require_foreground('微信')
            layout = ins.locate()
            event = request.get('event') or {}
            draft = request.get('draft') or {}
            if event.get('type') == 'pointer':
                x, y, width, height = ins.bounds(layout['send'])
                px, py = event.get('x'), event.get('y')
                if type(px) is int and type(py) is int and not (x <= px < x + width and y <= py < y + height):
                    return {'safe': True, 'resolved': False}
            text = self.editor_text(layout['editor'])
            if not text:
                return {'safe': True, 'resolved': layout['label'] == draft.get('label')}
            if draft.get('label') and layout['label'] != draft['label']:
                return {'safe': True, 'resolved': False}
            if isinstance(draft.get('text'), str) and draft['text'] and draft['text'] not in text:
                return {'safe': True, 'resolved': True}
            return {'safe': False, 'resolved': False}
        if action == 'list':
            ins.prepare_scan()
        ins.require_foreground('微信')
        if action == 'list':
            account = ins.account()
            if not account:
                raise ValueError('account unavailable')
            candidates = [row['label'] for row in ins.contacts()]
            return {'available': True, 'account': account, 'source': 'contacts',
                    'candidates': candidates, 'current': None, 'batchResolve': True}
        if action == 'resolve-batch':
            account = ins.account()
            if account != request.get('account'):
                return {'available': False, 'error': 'account-changed', 'account': account}
            labels = request.get('labels')
            if (not isinstance(labels, list) or not 1 <= len(labels) <= 10
                    or any(not isinstance(label, str) or not 0 < len(label) <= 120 for label in labels)
                    or len(set(labels)) != len(labels)):
                raise ValueError('invalid contact batch')
            contacts = ins.resolve_contacts(labels)
            return {'account': account, 'results': [
                {'account': account, 'contact': {'id': contact_key(account, contact), 'label': contact['label'], 'kind': contact['kind']}}
                if contact else {'available': False, 'error': 'unsupported'} for contact in contacts]}
        if action not in ('resolve', 'read', 'send', 'read-guard', 'send-guard', 'prepare-send', 'open-chat', 'transcribe'):
            raise ValueError('invalid operation')
        resolved = self.resolve(request)
        if resolved.get('error') or action == 'resolve':
            return resolved
        account, contact = resolved['account'], resolved['contact']
        if action == 'transcribe':
            return module('qibox_ai_voice', 'ai-native-voice.py').convert(self, request, account, contact)
        if action == 'open-chat':
            return self.open_chat(request, account, contact)
        guarded = action in ('read-guard', 'send-guard', 'prepare-send')
        snapshot = self.guard_snapshot if guarded else self.snapshot
        before, layout = snapshot(account, contact['id'], contact['label'])
        if action in ('read', 'read-guard'):
            return before
        if action == 'prepare-send':
            if not callable(commit): raise ValueError('commit unavailable')
            # No draft is touched until the parent rechecks the database after
            # native account/contact navigation and explicitly commits this guard.
            request = commit(before)
            ins.check()
            if not request or request.get('action') != 'commit': return {'status': 'stale'}
            fresh, layout = snapshot(account, contact['id'], contact['label'])
            if fresh['revision'] != before['revision']: return {'status': 'stale'}
        text = request.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 3000:
            raise ValueError('invalid text')
        if before['revision'] != request.get('revision') or self.editor_text(layout['editor']):
            return {'status': 'stale'}
        ins.check()
        self.verify_session()
        self.owned_draft = {key: layout[key] for key in ('app', 'frame', 'header', 'editor', 'label')}
        self.owned_draft['text'] = text
        self.write_text(layout['editor'], text)
        time.sleep(.08)
        fresh, layout = snapshot(account, contact['id'], contact['label'])
        if fresh['revision'] != before['revision'] or self.editor_text(layout['editor']) != text:
            return {'status': 'uncertain'}
        ins.check()
        if not ins.visible(layout['send']):
            return {'status': 'uncertain'}
        ins.require_foreground('微信')
        self.verify_session()
        # Once the native click may have happened, never delete a draft as a
        # cancellation cleanup: the database bridge must check the send receipt.
        self.send_pressed = True
        ins.press(layout['send'])
        for _ in range(6):
            time.sleep(.15)
            ins.check()
            try:
                after, layout = snapshot(account, contact['id'], contact['label'])
            except SnapshotChanged:
                # The send itself can append a row during observation. Only
                # repeat this read; never repeat the input or native send click.
                self.verify_session()
                continue
            if not self.editor_text(layout['editor']) and (guarded or confirmed_append(before['messages'], after['messages'], text)):
                self.send_confirmed = True
                return {'status': 'submitted'} if guarded else {'status': 'sent', 'snapshot': after}
        return {'status': 'uncertain'}

    def cleanup_draft(self):
        if not self.possibly_written or self.send_confirmed:
            return 'not-needed'
        if not self.owned_draft:
            return 'blocked'
        if self.send_pressed and getattr(self, 'session_identity', None) is None:
            return 'blocked'
        ins, owned = self.controls, self.owned_draft
        status = 'blocked'

        def cleanup():
            nonlocal status
            ins.require_foreground('微信')
            self.verify_session()
            layout = ins.locate()
            if any(layout[key] != owned[key] for key in ('app', 'frame', 'header', 'editor', 'label')):
                return
            if ins._visible_roots(layout['app'], layout['frame']):
                return
            current = self.editor_text(layout['editor'])
            if not current:
                if self.send_pressed:
                    # A submitted send may clear the editor before its receipt
                    # can be observed. Prove the owned session is still empty
                    # using only reads; history rows may legitimately change.
                    ins.require_foreground('微信')
                    self.verify_session()
                    fresh = ins.locate()
                    if any(fresh[key] != owned[key] for key in ('app', 'frame', 'header', 'editor', 'label')):
                        return
                    if ins._visible_roots(fresh['app'], fresh['frame']):
                        return
                    ins.refresh(fresh['header'])
                    if ins.string('get_name', fresh['header']) != owned['label']:
                        return
                    ins.require_foreground('微信')
                    self.verify_session()
                    if self.editor_text(fresh['editor']):
                        return
                status = 'not-needed'
                return
            if self.send_pressed:
                return
            if current != owned['text']:
                return
            ins.require_foreground('微信')
            # A fresh label on the same header must still match immediately
            # before modifying the original editor. Never navigate to recover it.
            ins.refresh(layout['header'])
            if ins.string('get_name', layout['header']) != owned['label']:
                return
            if self.editor_text(layout['editor']) != owned['text']:
                return
            self.verify_session()
            self.write_text(layout['editor'], '')
            if not self.editor_text(layout['editor']):
                status = 'cleared'

        try:
            ins._cleanup_budget(cleanup, seconds=1.5)
        except Exception:
            pass
        return status

    def close(self):
        cleanup = self.cleanup_draft()
        try:
            self.controls.close()
        except Exception:
            if self.possibly_written and not self.send_confirmed:
                cleanup = 'blocked'
            else:
                raise
        return cleanup


def main():
    adapter = None
    result = {'available': False, 'error': 'unsupported'}
    try:
        prepared = '--prepare' in sys.argv[2:]
        request = json.loads(sys.stdin.buffer.readline(100000) if prepared else sys.stdin.buffer.read(100000))
        if prepared != (request.get('action') == 'prepare-send'): raise ValueError('invalid protocol')
        seconds = 90 if request.get('action') in ('list', 'resolve-batch', 'read', 'read-guard', 'resolve', 'prepare-send', 'open-chat') else 28
        adapter = ChatAdapter(int(sys.argv[1]), seconds=seconds)
        signal.signal(signal.SIGTERM, lambda *_: setattr(adapter.controls, 'cancelled', True))
        def commit(before):
            print(json.dumps({'stage': 'prepared', **before}, ensure_ascii=False), flush=True)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                adapter.controls.check()
                if select.select([sys.stdin.buffer], [], [], .1)[0]:
                    value = json.loads(sys.stdin.buffer.readline(100000))
                    adapter.controls.deadline = time.monotonic() + 28
                    return value
            raise TimeoutError('commit timed out')
        result = adapter.execute(request, commit=commit if prepared else None)
    except Exception as error:
        if adapter and adapter.possibly_written:
            result = {'status': 'uncertain'}
        elif adapter and adapter.controls.cancelled:
            result = {'available': False, 'error': 'cancelled'}
        elif adapter and request.get('action') == 'list':
            result = {'available': False, 'error': 'contacts-unavailable'}
        else:
            result = {'available': False, 'error': 'unsupported'}
        result['diagnostic'] = {'phase': getattr(adapter, 'phase', 'native-start'),
                                'code': 'timeout' if isinstance(error, TimeoutError) else 'cancelled' if adapter and adapter.controls.cancelled else 'controls-unavailable'}
    finally:
        if adapter:
            try:
                cleanup = adapter.close()
                if request.get('action') in ('send', 'send-guard', 'prepare-send'):
                    result['draftCleanup'] = cleanup
            except Exception:
                result = {'status': 'uncertain'} if adapter.possibly_written else {'available': False, 'error': 'unsupported'}
                if request.get('action') in ('send', 'send-guard', 'prepare-send'):
                    result['draftCleanup'] = 'blocked' if adapter.possibly_written else 'not-needed'
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
