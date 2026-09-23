"""Verified Linux WeChat controls and contextual identity fields.

Names locate candidate conversations; only a separately opened personal profile
can establish a contact key. This module never sends messages or edits text.
Call close() in a finally block, or use NativeControls as a context manager.
All methods share one deadline/call budget. Caller supplies the private desktop
environment and must prevent concurrent user/automation desktop navigation.
"""

import ctypes as c
import hashlib
import importlib.util
import pathlib
import re
import time
from collections import deque


spec = importlib.util.spec_from_file_location(
    'qibox_login_controls', pathlib.Path(__file__).with_name('auto-login.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

# Re-export the shared native boundaries for existing inspector callers.
ControlsUnavailable = base.windows.ControlsUnavailable
XWindowAttributes = base.windows.XWindowAttributes
x11_property32 = base.windows.x11_property32
x11_property_array = base.windows.x11_property_array
x11_window_title = base.windows.x11_window_title
x11_connection = base.windows.x11_connection

FOCUSABLE, MULTILINE = 11, 17
MAX_NODES, MAX_DEPTH, MAX_CALLS = 1000, 32, 80000
MAX_CONTACTS = 1000
DIRECTORY_GROUP = re.compile(r'^(公众号、服务号|企业微信联系人|联系人)(\d+)$')
WXID = re.compile(r'[a-zA-Z][a-zA-Z0-9_-]{5,63}')


class Rect(c.Structure):
    _fields_ = [('x', c.c_int), ('y', c.c_int), ('width', c.c_int), ('height', c.c_int)]


class StateArray(c.Structure):
    _fields_ = [('data', c.POINTER(c.c_int)), ('len', c.c_uint)]


def shown(node):
    states = node.get('states', set())
    rect = node.get('bounds')
    return (node.get('frame_viewable', True) and base.VISIBLE in states and base.SHOWING in states
            and not any(state in states for state in base.BAD_STATES)
            and rect is not None and rect[2] > 0 and rect[3] > 0)


def hidden_zero(node):
    states = node.get('states')
    return (states is not None and base.VISIBLE not in states and base.SHOWING not in states
            and node.get('bounds') == (0, 0, 0, 0))


def inside(rect, outer):
    return (rect is not None and outer is not None and rect[0] >= outer[0]
            and rect[1] >= outer[1] and rect[0] + rect[2] <= outer[0] + outer[2]
            and rect[1] + rect[3] <= outer[1] + outer[3])


def descendants(nodes, root):
    by_obj = {node['obj']: node for node in nodes}
    result = []
    for node in nodes:
        seen, current = set(), node['obj']
        while current is not None and current not in seen:
            if current == root:
                result.append(node)
                break
            seen.add(current)
            current = by_obj.get(current, {}).get('parent')
    return result


def unique(nodes, all_nodes):
    """Collapse same-bounds wrapper/child duplicates, never unrelated widgets."""
    groups = {}
    for node in nodes:
        groups.setdefault((node['name'], node.get('bounds')), []).append(node)
    result = []
    for group in groups.values():
        deepest = max(group, key=lambda node: node.get('depth', 0))
        for node in group:
            if not any(child['obj'] == deepest['obj'] for child in descendants(all_nodes, node['obj'])):
                raise ControlsUnavailable('ambiguous controls')
        result.append(deepest)
    if len(result) != 1:
        raise ControlsUnavailable('control unavailable')
    return result[0]


def is_history_import_hint(nodes):
    """The first-login history tip is non-modal and has no text input.

    Recognize the complete small widget, not a matching label inside an
    arbitrary dialog. Unknown popups must still block native navigation.
    """
    if not nodes or nodes[0]['role'] != 'filler':
        return False
    bounds = nodes[0].get('bounds')
    if not bounds or not 0 < bounds[2] <= 400 or not 0 < bounds[3] <= 80:
        return False
    visible = [n for n in nodes if shown(n)]
    if any(n['role'] not in ('filler', 'label', 'push button')
           or n.get('interfaces') or not inside(n.get('bounds'), bounds) for n in visible):
        return False
    named = [n for n in visible if n['name']]
    if len(named) != 1 or named[0]['role'] != 'label' or named[0]['name'] != '点此从手机导入更多聊天记录':
        return False
    try:
        close = unique([n for n in visible if n['role'] == 'push button' and not n['name']], nodes)
        return close['bounds'][0] >= named[0]['bounds'][0] + named[0]['bounds'][2]
    except ControlsUnavailable:
        return False


def first_line(value):
    if not isinstance(value, str):
        raise ControlsUnavailable('conversation unavailable')
    label = value.split('\n', 1)[0].rstrip('\r')
    if not label or len(label) > 120 or any(ord(char) < 32 for char in label):
        raise ControlsUnavailable('conversation unavailable')
    return label


def merge_directory_rows(previous, page):
    """Join overlapping virtual viewports without dropping duplicate nicknames."""
    if not previous:
        return list(page)
    before, after = [r['label'] for r in previous], [r['label'] for r in page]
    overlaps = [n for n in range(1, min(len(before), len(after)) + 1) if before[-n:] == after[:n]]
    if not overlaps:
        raise ControlsUnavailable('contact pages changed')
    return previous + page[max(overlaps):]


def personal_directory_rows(rows):
    grouped = any(re.fullmatch(r'(公众号、服务号|企业微信联系人)\d+', r['label']) for r in rows)
    section, expected, result = None, None, []
    for row in rows:
        group = DIRECTORY_GROUP.fullmatch(row['label']) if grouped and section != '联系人' else None
        if group:
            section = group[1]
            if section == '联系人':
                if expected is not None:
                    raise ControlsUnavailable('ambiguous contacts section')
                expected = int(group[2])
            continue
        if (not grouped or section == '联系人') and row['label'] not in ('新的朋友', '群聊', '标签'):
            result.append(row)
    return result, expected


def main_nodes(nodes, app):
    """The signed-in shell is valid even with no conversation selected."""
    frame = unique([node for node in nodes if node['role'] == 'frame' and node['name'] == '微信'
                    and node['parent'] == app and shown(node)], nodes)
    scope = descendants(nodes, frame['obj'])
    contacts = unique([node for node in scope if node['role'] == 'push button'
                       and node['name'] == '通讯录' and shown(node)], nodes)
    return {'app': app, 'frame': frame['obj'], 'contacts_button': contacts['obj']}


def directory_nodes(nodes, app):
    shell = main_nodes(nodes, app)
    scope = descendants(nodes, shell['frame'])
    by_obj = {node['obj']: node for node in scope}
    frame, navigation = by_obj[shell['frame']], by_obj[shell['contacts_button']]
    lists = [node for node in scope if node['role'] in ('list', 'tree') and shown(node)
             and inside(node['bounds'], frame['bounds'])
             and node['bounds'][0] >= navigation['bounds'][0] + navigation['bounds'][2]
             and node['name'] not in ('会话', '消息')]
    named = [node for node in lists if node['name'] in ('通讯录', '联系人', '微信联系人')]
    # Only accept a unique exposed directory. An unnamed list is accepted after
    # the Contacts navigation and never while a visible chat message pane exists.
    if not named and any(node['role'] == 'list' and node['name'] == '消息' and shown(node) for node in scope):
        raise ControlsUnavailable('contacts unavailable')
    directory = unique(named or lists, nodes)
    return {**shell, 'contact_list': directory['obj']}


def locate_nodes(nodes, app):
    frame = unique([node for node in nodes if node['role'] == 'frame' and node['name'] == '微信'
                    and node['parent'] == app and shown(node)], nodes)
    scope = descendants(nodes, frame['obj'])
    conversations = unique([node for node in scope if node['role'] == 'list'
                            and node['name'] == '会话' and shown(node)], nodes)
    messages = unique([node for node in scope if node['role'] == 'list'
                      and node['name'] == '消息' and shown(node)], nodes)
    mx, my, mw, mh = messages['bounds']
    pane = lambda node: shown(node) and inside(node['bounds'], frame['bounds']) and node['bounds'][0] >= mx
    info = unique([node for node in scope if node['role'] == 'push button'
                   and node['name'] == '聊天信息' and pane(node)
                   and node['bounds'][1] + node['bounds'][3] <= my], nodes)
    by_obj = {node['obj']: node for node in scope}
    ancestor, header, seen = info['parent'], None, set()
    while ancestor in by_obj and ancestor not in seen:
        seen.add(ancestor)
        labels = [node for node in descendants(scope, ancestor)
                  if node['role'] == 'label' and FOCUSABLE in node['states'] and pane(node)
                  and node['bounds'][1] + node['bounds'][3] <= my
                  and node['name'] and len(node['name']) <= 120 and '\n' not in node['name']]
        if labels:
            header = unique(labels, nodes)
            break
        ancestor = by_obj[ancestor]['parent']
    if not header:
        raise ControlsUnavailable('header unavailable')
    editor = unique([node for node in scope if node['role'] == 'text'
                     and 'editable_text' in node.get('interfaces', {})
                     and MULTILINE in node['states'] and pane(node)
                     and node['bounds'][1] >= my + mh], nodes)
    send = unique([node for node in scope if node['role'] == 'push button'
                   and node['name'] == '发送' and pane(node)
                   and node['bounds'][1] >= editor['bounds'][1]], nodes)
    return {'app': app, 'frame': frame['obj'], 'conversation_list': conversations['obj'],
            'message_list': messages['obj'], 'header': header['obj'], 'label': header['name'],
            'editor': editor['obj'], 'send': send['obj'], 'info': info['obj']}


def profile_identity(nodes, expected_label):
    labels = [node for node in nodes if node['role'] == 'label' and shown(node)]
    if not any(node['name'] == expected_label for node in labels):
        raise ControlsUnavailable('profile label changed')
    unique([node for node in nodes if node['role'] == 'push button'
            and node['name'] == '发消息' and shown(node)], nodes)
    values = []
    for marker in labels:
        if marker['name'] not in ('微信号：', '微信号:'):
            continue
        row = [node for node in labels if node['parent'] == marker['parent']]
        if len(row) != 2 or row[0]['obj'] != marker['obj']:
            raise ControlsUnavailable('ambiguous profile identity')
        value = row[1]['name']
        if not WXID.fullmatch(value):
            raise ControlsUnavailable('invalid profile identity')
        values.append(value)
    if len(values) != 1:
        raise ControlsUnavailable('profile identity unavailable')
    return {'id': hashlib.sha256(('wechat-contact\0' + values[0]).encode()).hexdigest(),
            'label': expected_label, 'kind': 'person'}


def profile_target(nodes, controls, before_buttons):
    """The newly visible profile button lives in the separate right overlay."""
    by_obj = {node['obj']: node for node in nodes}
    message = by_obj[controls['message_list']]['bounds']
    frame = by_obj[controls['frame']]['bounds']
    header = by_obj[controls['header']]['bounds']
    info = by_obj[controls['info']]['bounds']
    ancestor, seen, header_branch = by_obj[controls['info']]['parent'], set(), None
    while ancestor in by_obj and ancestor not in seen:
        seen.add(ancestor)
        branch = descendants(nodes, ancestor)
        if any(node['obj'] == controls['header'] for node in branch):
            header_branch = {node['obj'] for node in branch}
            break
        ancestor = by_obj[ancestor]['parent']
    if not header_branch:
        raise ControlsUnavailable('header branch unavailable')

    def overlaps(rect, other):
        return (rect[0] < other[0] + other[2] and rect[0] + rect[2] > other[0]
                and rect[1] < other[1] + other[3] and rect[1] + rect[3] > other[1])

    candidates = []
    for node in nodes:
        if (node['role'] != 'push button' or node['name'] != controls['label'] or not shown(node)
                or node['obj'] in before_buttons or node['obj'] in header_branch):
            continue
        rect = node['bounds']
        if (inside(rect, frame) and inside(rect, message)
                and rect[0] + rect[2] / 2 >= frame[0] + frame[2] / 2
                and not overlaps(rect, header) and not overlaps(rect, info)):
            candidates.append(node)
    return unique(candidates, nodes)


class NativeControls(base.Inspector):
    def __init__(self, pid, seconds=10.0):
        if not isinstance(pid, int) or pid <= 1 or not 1 <= seconds <= 90:
            raise ValueError('invalid inspection limits')
        super().__init__(pid)
        self.deadline = time.monotonic() + seconds
        self.bind('atspi_set_timeout', None, [c.c_int, c.c_int])(150, 150)
        # This short-lived helper has no GLib event loop to maintain AT-SPI's
        # child cache. Virtualized Qt rows are replaced on scroll; always ask
        # the client for current children rather than dereferencing old rows.
        self.bind('atspi_accessible_set_cache_mask', None, [c.c_void_p, c.c_uint])(self.desktop, 0)
        self.gobject = c.CDLL('libgobject-2.0.so.0')
        self.gobject.g_object_unref.argtypes = [c.c_void_p]
        self._chat_cleanup = None
        self._settings_close_requested = False
        self._closed = False

    def check(self):
        self.calls += 1
        if self.cancelled or self.calls > MAX_CALLS or time.monotonic() >= self.deadline:
            raise ControlsUnavailable('inspection interrupted')

    def children(self, obj):
        count = self.call('get_child_count', c.c_int, obj)
        if not 0 <= count <= MAX_NODES:
            raise ControlsUnavailable('control tree limit')
        return [child for index in range(count)
                if (child := self.call('get_child_at_index', c.c_void_p, obj, index))]

    def walk(self, obj, depth=0):
        """Settings/navigation lookups must not walk private message histories."""
        self.check()
        role = self.string('get_role_name', obj)
        if role in base.SKIP:
            return
        yield obj, role, self.string('get_name', obj)
        if depth >= MAX_DEPTH:
            raise ControlsUnavailable('control depth limit')
        for child in self.children(obj):
            yield from self.walk(child, depth + 1)

    def states(self, obj):
        self.check()
        state = self.bind('atspi_accessible_get_state_set', c.c_void_p, [c.c_void_p])(obj)
        if not state:
            raise ControlsUnavailable('state unavailable')
        values = None
        try:
            # contains() refreshes the remote state for each flag. Read the
            # complete current set once, retaining every visibility/error flag.
            values = self.bind('atspi_state_set_get_states', c.POINTER(StateArray), [c.c_void_p])(state)
            if not values or values.contents.len > 64 or values.contents.len and not values.contents.data:
                raise ControlsUnavailable('state unavailable')
            return {values.contents.data[index] for index in range(values.contents.len)}
        finally:
            if values:
                free = self.glib.g_array_free
                free.restype, free.argtypes = c.c_void_p, [c.POINTER(StateArray), c.c_int]
                free(values, True)
            self.gobject.g_object_unref(state)

    def interfaces(self, obj):
        result = {}
        # Locators only need to distinguish an editable text control. Bounds
        # already checks Component, and editor_text verifies Text when used.
        for name in ('editable_text',):
            self.check()
            ptr = self.bind('atspi_accessible_get_' + name + '_iface', c.c_void_p, [c.c_void_p])(obj)
            if ptr:
                result[name] = ptr
        return result

    def bounds(self, obj):
        self.check()
        component = self.bind('atspi_accessible_get_component_iface', c.c_void_p, [c.c_void_p])(obj)
        if not component:
            return None
        error = c.c_void_p()
        ptr = self.bind('atspi_component_get_extents', c.POINTER(Rect),
                        [c.c_void_p, c.c_int, c.POINTER(c.c_void_p)])(component, 0, c.byref(error))
        try:
            if error.value or not ptr:
                raise ControlsUnavailable('bounds unavailable')
            rect = ptr.contents
            return rect.x, rect.y, rect.width, rect.height
        finally:
            if error.value:
                self.glib.g_error_free(error)
            if ptr:
                self.glib.g_free(ptr)

    def tree(self, root, prune_lists=False):
        result, seen = [], set()
        mapped_frames = None
        queue = deque([(root, None, 0, 'root')])
        self.refresh(root)
        while queue:
            self.check()
            obj, parent, depth, path = queue.popleft()
            if obj in seen:
                raise ControlsUnavailable('cyclic control tree')
            if len(seen) >= MAX_NODES:
                raise ControlsUnavailable('control tree limit')
            seen.add(obj)
            self.refresh(obj)
            role = self.string('get_role_name', obj)
            node = {'obj': obj, 'parent': parent, 'depth': depth, 'path': path,
                    'role': role, 'name': self.string('get_name', obj),
                    'states': self.states(obj), 'bounds': self.bounds(obj),
                    'interfaces': self.interfaces(obj) if role == 'text' else {}}
            if node['role'] == 'frame':
                if mapped_frames is None:
                    mapped_frames = self._mapped_frames()
                node['frame_viewable'] = node['name'] in mapped_frames
            result.append(node)
            if hidden_zero(node) or node.get('frame_viewable') is False:
                continue
            # Locators need list containers, not all message/contact descendants.
            # Traversing every history row exhausted the call budget before a
            # single contact could be listed on accounts with longer histories.
            if prune_lists and node['role'] in ('list', 'tree'):
                continue
            children = self.children(obj)
            if children and depth >= MAX_DEPTH:
                raise ControlsUnavailable('control depth limit')
            if len(seen) + len(queue) + len(children) > MAX_NODES:
                raise ControlsUnavailable('control tree limit')
            queue.extend((child, obj, depth + 1, path + '/' + str(index))
                         for index, child in enumerate(children))
        return result

    def application(self):
        apps = [obj for obj in self.children(self.desktop)
                if self.call('get_process_id', c.c_uint, obj) == self.pid]
        if len(apps) != 1 or self.string('get_name', apps[0]) != 'wechat':
            raise ControlsUnavailable('application unavailable')
        self.app = apps[0]
        return apps[0]

    def locate(self):
        app = self.application()
        self._located_nodes = self.tree(app, prune_lists=True)
        return locate_nodes(self._located_nodes, app)

    def main(self):
        app = self.application()
        self._located_nodes = self.tree(app, prune_lists=True)
        return main_nodes(self._located_nodes, app)

    def directory(self):
        app = self.application()
        self._located_nodes = self.tree(app, prune_lists=True)
        return directory_nodes(self._located_nodes, app)

    def open_contacts(self):
        shell = self.main()
        if self._visible_roots(shell['app'], shell['frame']):
            raise ControlsUnavailable('existing popup unavailable')
        try:
            return directory_nodes(self._located_nodes, shell['app'])
        except ControlsUnavailable:
            self.check()
        self.require_foreground('微信')
        self.press(shell['contacts_button'])
        return self._observe(self.directory)

    def prepare_scan(self):
        shell = self.main()
        roots = self._visible_roots(shell['app'], shell['frame'])
        if not roots:
            return
        # Recover the More menu left open by older failed account lookups.
        # Unrelated popups and preexisting Settings windows stay untouched.
        if (len(roots) != 1 or self.string('get_role_name', roots[0]) != 'filler'
                or not self.find(roots[0], '设置', 'push button', True)):
            raise ControlsUnavailable('existing popup unavailable')
        more = self.find(shell['frame'], '更多', 'push button', True)
        if not more:
            raise ControlsUnavailable('settings menu unavailable')
        self.require_foreground()
        self.press(more)
        self._observe(lambda: self.require_foreground('微信'))

    def list_rows(self, obj):
        """Read all exposed rows, including off-screen rows, without chat text."""
        self.refresh(obj)
        result = []
        for child in self.children(obj):
            self.refresh(child)
            if self.string('get_role_name', child) not in ('list item', 'tree item'):
                continue
            name = self.string('get_name', child)
            if not name:
                continue
            result.append({'obj': child, 'label': first_line(name)})
            if len(result) > MAX_CONTACTS:
                raise ControlsUnavailable('contact range too large')
        return result

    def scroll_directory(self, direction, layout, bursts=1):
        self.refresh(layout['contact_list'])
        if not self.visible(layout['contact_list']):
            raise ControlsUnavailable('contacts viewport unavailable')
        if self._visible_roots(layout['app'], layout['frame']):
            raise ControlsUnavailable('existing popup unavailable')
        self.require_foreground('微信')
        bounds = self.bounds(layout['contact_list'])
        if not bounds or min(bounds[2:]) <= 0:
            raise ControlsUnavailable('contacts viewport unavailable')
        self.move_pointer(bounds[0] + bounds[2] // 2, bounds[1] + bounds[3] // 2)
        # Qt coalesces a long burst of wheel events into a single gesture and
        # then clamps it, so a large jump is sent as several short gestures and
        # only the last one is waited out. bursts=1 keeps the single gesture
        # every existing caller relies on.
        for batch in range(bursts):
            for _ in range(max(1, min(5, bounds[3] // 140))):
                self.check()
                button = 4 if direction == 'up' else 5
                self.xtest.XTestFakeButtonEvent(self.display, button, 1, 0)
                self.xtest.XTestFakeButtonEvent(self.display, button, 0, 0)
            self.xlib.XFlush(self.display)
            if bursts > 1 and batch + 1 < bursts:
                time.sleep(.12)
        # Qt animates this virtual list. Reading its transient row objects
        # while they are being replaced can crash the client's accessibility
        # implementation, so only enumerate after the wheel animation settles.
        time.sleep(.6)

    def directory_pages(self):
        layout = self.open_contacts()
        page = self.list_rows(layout['contact_list'])
        # Qt exposes only the current viewport through AT-SPI. Return to the
        # beginning, then join overlapping pages until the final stable view.
        for _ in range(500):
            before = [r['label'] for r in page]
            self.scroll_directory('up', layout)
            page = self.list_rows(layout['contact_list'])
            if before == [r['label'] for r in page]:
                break
        else:
            raise ControlsUnavailable('contact range too large')
        combined = list(page)
        yield combined, page, layout
        for _ in range(500):
            before = [r['label'] for r in page]
            self.scroll_directory('down', layout)
            page = self.list_rows(layout['contact_list'])
            if before == [r['label'] for r in page]:
                return
            combined = merge_directory_rows(combined, page)
            if len(combined) > MAX_CONTACTS + 100:
                raise ControlsUnavailable('contact range too large')
            yield combined, page, layout
        raise ControlsUnavailable('contact range too large')

    def contacts(self):
        for attempt in range(2):
            combined = []
            for combined, page, layout in self.directory_pages():
                pass
            rows, expected = personal_directory_rows(combined)
            if expected and not rows and attempt == 0:
                # The personal section may be collapsed. Expand only its
                # observed count-bearing header, never a friend or account.
                for _, page, layout in self.directory_pages():
                    headers = [r for r in page if r['label'] == '联系人' + str(expected)]
                    if len(headers) == 1 and self.row_in_view(headers[0], layout['contact_list']):
                        self.press_row(headers[0], layout['contact_list'])
                        break
                continue
            if len(rows) > MAX_CONTACTS or expected is not None and len(rows) != expected:
                raise ControlsUnavailable('incomplete contacts directory')
            self._directory_labels = [r['label'] for r in combined]
            return rows
        raise ControlsUnavailable('contacts section unavailable')

    def row_in_view(self, row, container):
        self.refresh(row['obj'])
        return self.visible(row['obj']) and inside(self.bounds(row['obj']), self.bounds(container))

    def resolve_contacts(self, labels):
        rows = self.contacts()
        counts = {label: sum(r['label'] == label for r in rows) for label in labels}
        pending = {label for label in labels if counts[label] == 1}
        results = {}
        if not pending:
            return [None for _ in labels]
        # Reestablish the top before resolving profiles. WeChat can retain a
        # shifted row layout when a selected contact is scrolled upwards.
        _, _, layout = next(self.directory_pages())
        directory_labels = getattr(self, '_directory_labels', [r['label'] for r in rows])
        personal_start = len(directory_labels) - len(rows)
        before_scroll = None
        for _ in range(MAX_CONTACTS + 500):
            page = self.list_rows(layout['contact_list'])
            signature = [r['label'] for r in page]
            if signature == before_scroll:
                break
            positions = [i for i in range(len(directory_labels) - len(page) + 1)
                         if directory_labels[i:i + len(page)] == signature]
            if not page or len(positions) != 1:
                raise ControlsUnavailable('contact pages changed')
            handled = False
            for row in page[max(0, personal_start - positions[0]):]:
                if row['label'] not in pending or not self.row_in_view(row, layout['contact_list']):
                    continue
                try:
                    results[row['label']] = self.directory_profile(row, layout)
                except ControlsUnavailable:
                    self.check()
                    if self._visible_roots(layout['app'], layout['frame']):
                        raise
                pending.discard(row['label'])
                handled = True
                break
            if not pending:
                break
            if handled:
                # Selection can rebuild rows and move the viewport. Reobserve
                # and align against the verified directory before every click.
                before_scroll = None
                continue
            before_scroll = signature
            self.scroll_directory('down', layout)
        return [results.get(label) for label in labels]

    def press_row(self, row, container):
        self.require_foreground('微信')
        self.refresh(row['obj'])
        if first_line(self.string('get_name', row['obj'])) != row['label']:
            raise ControlsUnavailable('contact row changed')
        if not self.visible(row['obj']) or not inside(self.bounds(row['obj']), self.bounds(container)):
            iface = self.bind('atspi_accessible_get_component_iface', c.c_void_p, [c.c_void_p])(row['obj'])
            if not iface:
                raise ControlsUnavailable('contact scrolling unavailable')
            error = c.c_void_p()
            ok = self.bind('atspi_component_scroll_to', c.c_int,
                           [c.c_void_p, c.c_int, c.POINTER(c.c_void_p)])(iface, 6, c.byref(error))
            if error.value:
                self.glib.g_error_free(error)
            if not ok or error.value:
                raise ControlsUnavailable('contact scrolling unavailable')
            def visible_row():
                self.refresh(row['obj'])
                if not self.visible(row['obj']) or not inside(self.bounds(row['obj']), self.bounds(container)):
                    raise ControlsUnavailable('contact row outside viewport')
            self._observe(visible_row)
        self.require_foreground('微信')
        if first_line(self.string('get_name', row['obj'])) != row['label']:
            raise ControlsUnavailable('contact row changed')
        self.press(row['obj'])

    def directory_contact(self, label, open_chat=False, expected_contact=None, account=None, verify_session=None):
        if first_line(label) != label:
            raise ControlsUnavailable('invalid contact label')
        matches = [row for row in self.contacts() if row['label'] == label]
        if len(matches) != 1:
            raise ControlsUnavailable('ambiguous contact candidate')
        # Viewport objects can be destroyed or reused after scrolling. Resolve
        # the row again within the personal section immediately before pressing.
        for combined, page, layout in self.directory_pages():
            personal, _ = personal_directory_rows(combined)
            if any(r['label'] == label for r in personal):
                visible = [r for r in page if r['label'] == label]
                if len(visible) == 1 and self.row_in_view(visible[0], layout['contact_list']):
                    if verify_session is not None:
                        return self.directory_profile(visible[0], layout, open_chat, expected_contact, account, verify_session)
                    return self.directory_profile(visible[0], layout, open_chat, expected_contact, account)
        else:
            raise ControlsUnavailable('contact row changed')

    def directory_profile(self, row, layout, open_chat=False, expected_contact=None, account=None, verify_session=None):
        label = row['label']
        self.press_row(row, layout['contact_list'])
        def observe_profile():
            fresh = self.directory()
            if self._visible_roots(fresh['app'], fresh['frame']):
                raise ControlsUnavailable('existing popup unavailable')
            nodes = descendants(self._located_nodes, fresh['frame'])
            by_obj = {node['obj']: node for node in nodes}
            bounds = by_obj[fresh['contact_list']]['bounds']
            profile = [node for node in nodes if shown(node) and inside(node['bounds'], by_obj[fresh['frame']]['bounds'])
                       and node['bounds'][0] >= bounds[0] + bounds[2]]
            identity = profile_identity(profile, label)
            button = unique([node for node in profile if node['role'] == 'push button' and node['name'] == '发消息'], profile)
            return identity, button['obj']

        contact, button = self._observe(observe_profile)
        scoped_key = hashlib.sha256((account + '\0' + contact['id']).encode()).hexdigest() if account else None
        if expected_contact is not None and scoped_key != expected_contact:
            raise ControlsUnavailable('contact identity changed')
        if open_chat:
            self.require_foreground('微信')
            # "发消息" on a verified profile only opens the conversation. It
            # never edits the composer or presses the chat's "发送" button.
            self.press(button)
            def observe_chat():
                if self.locate()['label'] != label:
                    raise ControlsUnavailable('conversation changed')
            self._observe(observe_chat)
            if verify_session is not None:
                verify_session()
            else:
                verified = self.contact()
                if verified != contact:
                    raise ControlsUnavailable('contact identity changed')
        return contact

    def require_foreground(self, expected_title=None):
        """Require a stable active X11 window owned by this PID; never focus it."""
        self.check()
        with x11_connection() as (xlib, display, errors):
            root = xlib.XDefaultRootWindow(display)
            # only_if_exists=True prevents even creating an atom on the server.
            atoms = {name: xlib.XInternAtom(display, name.encode('ascii'), 1)
                     for name in ('_NET_ACTIVE_WINDOW', '_NET_WM_PID', 'WINDOW', 'CARDINAL')}
            if not root or not all(atoms.values()) or errors:
                raise ControlsUnavailable('foreground metadata unavailable')
            self.check()
            active = x11_property32(xlib, display, root, atoms['_NET_ACTIVE_WINDOW'], atoms['WINDOW'])
            if not active:
                raise ControlsUnavailable('no foreground window')
            self.check()
            owner = x11_property32(xlib, display, active, atoms['_NET_WM_PID'], atoms['CARDINAL'])
            if expected_title is not None and x11_window_title(xlib, display, active) != expected_title:
                raise ControlsUnavailable('foreground title changed')
            self.check()
            after = x11_property32(xlib, display, root, atoms['_NET_ACTIVE_WINDOW'], atoms['WINDOW'])
            if errors or owner != self.pid or after != active:
                raise ControlsUnavailable('foreground changed or belongs to another process')
            self.check()

    def _mapped_frames(self):
        return base.windows.mapped_frames(self.pid, self.check)

    def settings(self, app):
        # Qt keeps stale Settings roots showing after the real X11 window closes.
        # Such a root must never supply a cached account key.
        if '设置' not in self._mapped_frames():
            return None
        self.refresh(app)
        matches = []
        for obj in self.children(app):
            self.refresh(obj)
            if self.string('get_role_name', obj) == 'frame' and self.string('get_name', obj) == '设置':
                if shown({'states': self.states(obj), 'bounds': self.bounds(obj)}):
                    matches.append(obj)
        if len(matches) != 1:
            raise ControlsUnavailable('settings window unavailable')
        return matches[0]

    def scan(self):
        return self.list_rows(self.conversation_list())

    def conversation_list(self):
        shell = self.main()
        conversations = unique([node for node in descendants(self._located_nodes, shell['frame'])
                                if node['role'] == 'list' and node['name'] == '会话' and shown(node)], self._located_nodes)
        return conversations['obj']

    rows = scan

    def ensure_conversations(self):
        """Return from Contacts/other tabs before resolving a chat candidate."""
        shell = self.main()
        if self._visible_roots(shell['app'], shell['frame']):
            raise ControlsUnavailable('existing popup unavailable')
        scope = descendants(self._located_nodes, shell['frame'])
        if any(n['role'] == 'list' and n['name'] == '会话' and shown(n) for n in scope):
            self.conversation_list()
            return
        # Restrict the exact button to the navigation column, never a contact.
        contacts = next(n for n in scope if n['obj'] == shell['contacts_button'])
        button = unique([n for n in scope if n['role'] == 'push button' and n['name'] == '微信'
                         and shown(n) and n['bounds'][0] == contacts['bounds'][0]
                         and n['bounds'][2] == contacts['bounds'][2]
                         and n['bounds'][1] < contacts['bounds'][1]], self._located_nodes)
        self.require_foreground()
        self.press(button['obj'])
        self._observe(self.conversation_list)

    def _visible_roots(self, app, frame=None):
        result = []
        mapped_frames = None
        self.refresh(app)
        for obj in self.children(app):
            if obj == frame:
                continue
            self.refresh(obj)
            if self.string('get_role_name', obj) == 'tool tip':
                continue
            node = {'obj': obj, 'states': self.states(obj), 'bounds': self.bounds(obj)}
            if self.string('get_role_name', obj) == 'frame':
                if mapped_frames is None:
                    mapped_frames = self._mapped_frames()
                node['frame_viewable'] = self.string('get_name', obj) in mapped_frames
            if shown(node):
                if self.string('get_role_name', obj) == 'filler':
                    try:
                        if is_history_import_hint(self.tree(obj)):
                            continue
                    except ControlsUnavailable:
                        pass  # An uninspectable popup remains a blocker.
                result.append(obj)
        return result

    def _cleanup_budget(self, operation, seconds=.9, remaining=False):
        if not 0 < seconds <= 1.5:
            raise ValueError('invalid cleanup limit')
        # Normal profile navigation shares the operation's remaining budget.
        # Only cancellation/expiry uses the short emergency cleanup allowance.
        # A live operation must not time out mid-verification after 1.5 seconds.
        if remaining and not self.cancelled and self.deadline > time.monotonic() + seconds:
            return operation()
        deadline, calls, cancelled = self.deadline, self.calls, self.cancelled
        try:
            self.deadline = time.monotonic() + seconds
            self.calls, self.cancelled = 0, False
            operation()
        finally:
            self.deadline, self.cancelled = deadline, cancelled or self.cancelled
            self.calls += calls

    def _observe(self, operation):
        """Allow bounded asynchronous UI updates; never retry a click or send."""
        for attempt in range(8):
            self.check()
            try:
                return operation()
            except RuntimeError:
                self.check()  # Cancellation/deadline always escapes immediately.
                if attempt == 7:
                    raise
                time.sleep(.1)

    def _close_settings(self):
        owned = self.opened or self.created_settings
        if not owned:
            # Never close a user's preexisting Settings window. An interrupted
            # More menu is left untouched unless its presence can be verified.
            if self.menu:
                def close_menu():
                    self.require_foreground()
                    app = self.app or self.application()
                    def menu_items():
                        self.refresh(app)
                        return [item for popup in self.children(app)
                                if self.string('get_role_name', popup) != 'frame'
                                for item in [self.find(popup, '设置', visible=True)] if item]
                    if len(menu_items()) != 1:
                        raise ControlsUnavailable('owned menu unavailable')
                    self.press(self.menu)
                    while menu_items():
                        self.check()
                        time.sleep(.05)
                    self.menu = None
                self._cleanup_budget(close_menu, seconds=1.5)
            return

        def close_owned_settings():
            if '设置' in self._mapped_frames():
                if not getattr(self, '_settings_close_requested', False):
                    self.require_foreground(expected_title='设置')
                    settings = self.opened or self.settings(self.app)
                    if not settings:
                        raise ControlsUnavailable('owned settings unavailable')
                    self.refresh(settings)
                    button = self.find(settings, '关闭', 'push button', True)
                    if not button:
                        raise ControlsUnavailable('settings close control unavailable')
                    # A main window from the same PID can cover Settings while
                    # controls are read, so verify title again just before click.
                    self.require_foreground(expected_title='设置')
                    self._settings_close_requested = True
                    self.press(button)
                while '设置' in self._mapped_frames():
                    self.check()
                    time.sleep(.05)
            self.opened, self.menu, self.created_settings = None, None, False
            self._settings_close_requested = False
        self._cleanup_budget(close_owned_settings, seconds=1.5)

    def _account_settings(self, app):
        if not self.find(app, '通讯录', 'push button', True):
            raise ControlsUnavailable('login required')
        self.require_foreground('微信')
        more = self.find(app, '更多', 'push button', True)
        if not more:
            raise ControlsUnavailable('settings unavailable')
        self.press(more)
        self.menu = more

        def menu_item():
            self.refresh(app)
            matches = [item for popup in self.children(app)
                       if self.string('get_role_name', popup) != 'frame'
                       for item in [self.find(popup, '设置', visible=True)] if item]
            if len(matches) != 1:
                raise ControlsUnavailable('settings menu unavailable')
            return matches[0]

        item = self._observe(menu_item)
        # The native More popup is a separate same-process X11 window titled
        # "wechat" on 4.1.13.9. Its fresh Settings control identifies the menu;
        # requiring the main-window title here rejects every account lookup.
        self.require_foreground()
        self.created_settings = True
        self.press(item)
        self.menu = None

        def settings_window():
            value = self.settings(app)
            if not value:
                raise ControlsUnavailable('settings unavailable')
            return value

        settings = self._observe(settings_window)
        self.opened = settings
        self.require_foreground('设置')
        tab = self.find(settings, '账号与存储', 'push button', True)
        if not tab:
            raise ControlsUnavailable('account settings unavailable')
        self.press(tab)
        return settings

    def account(self):
        try:
            app = self.application()
            for obj in self._visible_roots(app):
                role, name = self.string('get_role_name', obj), self.string('get_name', obj)
                if not (role == 'frame' and name == '微信'):
                    raise ControlsUnavailable('existing popup unavailable')
            # Account identity is independent of the optional automatic-login
            # control. Client versions without that combo box are still usable.
            settings = self._account_settings(app)
            def read_account():
                self.refresh(settings)
                key = self.current_account(settings)
                if not re.fullmatch(r'[a-f0-9]{64}', key or ''):
                    raise ControlsUnavailable('account unavailable')
                return key
            key = self._observe(read_account)
            if read_account() != key:
                raise ControlsUnavailable('account changed')
            return key
        finally:
            self._close_settings()

    def _close_chat(self):
        owned = self._chat_cleanup
        if not owned:
            return

        def cleanup():
            controls = self.locate()
            if controls['label'] != owned['label'] or controls['app'] != owned['app']:
                raise ControlsUnavailable('chat changed during cleanup')
            # The header dismisses our profile. Some layouts leave the separate
            # information panel open; only its verified remaining target permits
            # one explicit click of the information button to close that panel.
            self.press(controls['header'])
            def observe_profile_closed():
                after = self.locate()
                if after['label'] != owned['label'] or self._visible_roots(after['app'], after['frame']):
                    raise ControlsUnavailable('popup cleanup unavailable')
                return after
            after = self._observe(observe_profile_closed)
            panel_open = any(node['role'] == 'push button' and node['name'] == owned['label'] and shown(node)
                             for node in descendants(self._located_nodes, after['frame']))
            if panel_open:
                profile_target(self._located_nodes, after, set())
                self.press(after['info'])
            def verify_closed():
                after = self.locate()
                if after['label'] != owned['label'] or self._visible_roots(after['app'], after['frame']):
                    raise ControlsUnavailable('popup cleanup unavailable')
                if any(node['role'] == 'push button' and node['name'] == owned['label'] and shown(node)
                       for node in descendants(self._located_nodes, after['frame'])):
                    raise ControlsUnavailable('information panel cleanup unavailable')
            # If the header already dismissed both, the fresh snapshot above
            # proves closure; only a subsequent info click needs another read.
            if panel_open:
                self._observe(verify_closed)
            self._chat_cleanup = None
        self._cleanup_budget(cleanup, seconds=1.5, remaining=True)

    def contact(self):
        controls = self.locate()
        label, app = controls['label'], controls['app']
        before_roots = set(self._visible_roots(app, controls['frame']))
        if before_roots:
            raise ControlsUnavailable('existing popup unavailable')
        before_nodes = descendants(self._located_nodes, controls['frame'])
        before_buttons = {node['obj'] for node in before_nodes if node['role'] == 'push button'
                          and node['name'] == label and shown(node)}
        if before_buttons:
            raise ControlsUnavailable('chat information already open')
        self._chat_cleanup = {'app': app, 'label': label}
        try:
            self.press(controls['info'])
            def observe_panel():
                fresh = self.locate()
                if fresh['label'] != label:
                    raise ControlsUnavailable('chat changed')
                panel_nodes = descendants(self._located_nodes, controls['frame'])
                return profile_target(panel_nodes, fresh, before_buttons)
            profile_button = self._observe(observe_panel)
            self.press(profile_button['obj'])
            def observe_profile():
                popup_roots = [obj for obj in self._visible_roots(app, controls['frame'])
                               if obj not in before_roots and self.string('get_role_name', obj) == 'filler']
                if len(popup_roots) != 1:
                    raise ControlsUnavailable('profile popup unavailable')
                return profile_identity(self.tree(popup_roots[0]), label)
            result = self._observe(observe_profile)
            # Verify the chat remained the same before returning a profile key.
            if self.locate()['label'] != label:
                raise ControlsUnavailable('chat changed')
            return result
        finally:
            self._close_chat()

    def navigate_background(self, label, verify_session, expected_contact=None, account=None, group=False):
        """Open a candidate conversation without opening its details for identity."""
        if first_line(label) != label or not callable(verify_session):
            raise ControlsUnavailable('invalid conversation candidate')
        shell = self.main()
        if self._visible_roots(shell['app'], shell['frame']):
            raise ControlsUnavailable('existing popup unavailable')
        container = self.conversation_list()
        matches = [row for row in self.list_rows(container) if row['label'] == label]
        if not matches:
            # The conversation list is virtualized: only rows inside the current
            # viewport exist, so a target outside it has to be reached by
            # scrolling. Return to the top in large jumps first - no row is read
            # while repositioning - then walk downwards one viewport at a time
            # so every row is seen. Falling straight back to the contacts
            # directory enumerates every contact page, which cannot finish
            # inside one operation budget.
            signature = None
            for _ in range(20):
                if self.deadline - time.monotonic() < 10:
                    break
                current = [row['label'] for row in self.list_rows(container)]
                if current == signature:
                    break
                signature = current
                self.scroll_directory('up', {**shell, 'contact_list': container}, bursts=12)
                container = self.conversation_list()
            signature = None
            for _ in range(40):
                if self.deadline - time.monotonic() < 8:
                    break
                rows = self.list_rows(container)
                matches = [row for row in rows if row['label'] == label]
                if matches:
                    break
                current = [row['label'] for row in rows]
                if current == signature:
                    break
                signature = current
                self.scroll_directory('down', {**shell, 'contact_list': container})
                container = self.conversation_list()
        if not matches:
            if group:
                raise ControlsUnavailable('open this group in WeChat first')
            # WeChat's contact card is the entry point for a first conversation.
            # Once opened, identity comes from the session reader, with no chat
            # details popup and no account-settings navigation.
            self.directory_contact(label, open_chat=True, expected_contact=expected_contact,
                                   account=account, verify_session=verify_session)
            return
        if len(matches) != 1:
            raise ControlsUnavailable('ambiguous conversation candidate')
        previous = None
        for _ in range(12):
            container = self.conversation_list()
            # Virtual rows can retain SHOWING outside the viewport; do not
            # click their old coordinates or rely on unsupported Qt scroll_to.
            matches = [row for row in self.list_rows(container) if row['label'] == label]
            if len(matches) != 1:
                raise ControlsUnavailable('conversation candidate changed')
            row = matches[0]
            if self.row_in_view(row, container):
                self.press_row(row, container)
                break
            bounds, viewport = self.bounds(row['obj']), self.bounds(container)
            if not bounds or not viewport or (bounds, viewport) == previous:
                raise ControlsUnavailable('conversation outside viewport')
            previous = (bounds, viewport)
            self.scroll_directory('up' if bounds[1] < viewport[1] else 'down',
                                  {**shell, 'contact_list': container})
        else:
            raise ControlsUnavailable('conversation outside viewport')
        def observe_header():
            current = self.locate()['label']
            if current != label and not (group and re.fullmatch(re.escape(label) + r'\s*[（(]\d+[）)]', current)):
                raise ControlsUnavailable('conversation changed')
        self._observe(observe_header)
        verify_session()

    def navigate(self, label, expected_id=None):
        if first_line(label) != label:
            raise ControlsUnavailable('invalid conversation label')
        if expected_id is not None and not re.fullmatch(r'[a-f0-9]{64}', expected_id):
            raise ControlsUnavailable('invalid contact key')
        current = self.locate()
        if current['label'] != label:
            matches = [row for row in self.scan() if row['label'] == label]
            if len(matches) != 1:
                raise ControlsUnavailable('ambiguous conversation candidate')
            self.press(matches[0]['obj'])
            def observe_header():
                if self.locate()['label'] != label:
                    raise ControlsUnavailable('conversation changed')
            self._observe(observe_header)
        # Even an unchanged/same-name header must receive fresh profile evidence.
        result = self.contact()
        if result['label'] != label or (expected_id is not None and result['id'] != expected_id):
            raise ControlsUnavailable('contact identity changed')
        return result

    def close(self):
        if self._closed:
            return
        try:
            self._close_chat()
        finally:
            try:
                self._close_settings()
            finally:
                if self.pointer:
                    self.xtest.XTestFakeMotionEvent(self.display, -1, *self.pointer, 0)
                    self.xlib.XFlush(self.display)
                self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
