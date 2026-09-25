"""Synthetic native-boundary tests; no WeChat, X11 or D-Bus interaction."""
import importlib.util
import ctypes as c
import pathlib
import time
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    'qibox_native_controls_test', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native-controls.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

VISIBLE = {8, 24, 25, 30}


def node(obj, parent, role, name='', bounds=(0, 0, 20, 20), states=None, depth=1, interfaces=None):
    return {'obj': obj, 'parent': parent, 'role': role, 'name': name, 'bounds': bounds,
            'states': VISIBLE.copy() if states is None else states, 'depth': depth,
            'interfaces': interfaces or {}}


def chat_nodes():
    return [node(1, None, 'application', 'wechat', (0, 0, 1280, 800), depth=0),
            node(2, 1, 'frame', '微信', (0, 0, 1280, 800)),
            node(3, 2, 'list', '会话', (61, 81, 240, 718), depth=2),
            node(4, 2, 'list', '消息', (301, 81, 978, 578), depth=2),
            node(5, 2, 'filler', '', (301, 25, 978, 56), depth=2),
            node(6, 5, 'push button', '聊天信息', (1220, 35, 30, 30), depth=3),
            node(7, 5, 'label', '测试对象', (330, 36, 120, 25), states=VISIBLE | {11}, depth=3),
            node(8, 7, 'label', '测试对象', (330, 36, 120, 25), states=VISIBLE | {11}, depth=4),
            node(9, 2, 'text', '', (325, 680, 900, 75), states=VISIBLE | {17}, depth=2,
                 interfaces={'editable_text': 9, 'text': 9}),
            node(10, 2, 'push button', '发送', (1180, 765, 70, 25), states={24, 25, 30}, depth=2)]


def profile_nodes(value='wxid_contact_123'):
    return [node(20, None, 'filler', bounds=(450, 250, 380, 300), depth=0),
            node(21, 20, 'label', '测试对象', (480, 270, 150, 25)),
            node(22, 20, 'filler', bounds=(480, 315, 300, 25)),
            node(23, 22, 'label', '微信号：', (480, 315, 70, 25), depth=2),
            node(24, 22, 'label', value, (550, 315, 170, 25), depth=2),
            node(25, 20, 'push button', '发消息', (540, 470, 120, 35))]


def directory_nodes():
    return [node(1, None, 'application', 'wechat', (0, 0, 1280, 800), depth=0),
            node(2, 1, 'frame', '微信', (0, 0, 1280, 800)),
            node(11, 2, 'push button', '通讯录', (10, 110, 30, 30)),
            node(12, 2, 'list', '联系人', (61, 81, 240, 718))]


class FakeFunction:
    def __init__(self, function): self.function = function
    def __call__(self, *args): return self.function(*args)


class ContactsBoundaries(unittest.TestCase):
    def test_virtual_pages_are_joined_from_top_with_duplicate_names_preserved(self):
        inspector = object.__new__(native.NativeControls)
        labels = ['公众号、服务号1', '服务账号', '企业微信联系人0', '联系人5', '甲', '同名', '乙', '同名', '联系人100']
        offset = [4]
        inspector.open_contacts = lambda: {'contact_list': 12}
        inspector.list_rows = lambda obj: [{'obj': i, 'label': labels[i]} for i in range(offset[0], min(len(labels), offset[0] + 5))]
        inspector.scroll_directory = lambda direction, layout: offset.__setitem__(0, max(0, min(len(labels) - 5, offset[0] + (-2 if direction == 'up' else 2))))
        rows = inspector.contacts()
        self.assertEqual([r['label'] for r in rows], labels[4:])
        self.assertEqual(sum(r['label'] == '同名' for r in rows), 2)

    def test_missing_overlap_or_incomplete_contact_count_is_rejected(self):
        with self.assertRaises(native.ControlsUnavailable):
            native.merge_directory_rows([{'label': '甲'}], [{'label': '乙'}])
        inspector = object.__new__(native.NativeControls)
        rows = [{'label': value} for value in ['公众号、服务号0', '联系人3', '甲', '乙']]
        inspector.directory_pages = lambda: iter([(rows, rows, {'contact_list': 12})])
        with self.assertRaisesRegex(native.ControlsUnavailable, 'incomplete'):
            inspector.contacts()

    def test_collapsed_personal_section_is_expanded_once(self):
        inspector = object.__new__(native.NativeControls)
        clicked = []
        header = [{'obj': 90, 'label': '公众号、服务号0'}, {'obj': 91, 'label': '联系人1'}]
        def pages():
            rows = header + ([{'obj': 92, 'label': '甲'}] if clicked else [])
            yield rows, rows, {'contact_list': 12}
        inspector.directory_pages = pages
        inspector.row_in_view = lambda *args: True
        inspector.press_row = lambda row, container: clicked.append(row['obj'])
        self.assertEqual([r['label'] for r in inspector.contacts()], ['甲'])
        self.assertEqual(clicked, [91])

    def test_batch_skips_duplicate_names_and_waits_for_a_full_visible_row(self):
        inspector = object.__new__(native.NativeControls)
        rows = [{'obj': i, 'label': label} for i, label in enumerate(['甲', '乙', '同名', '同名', '丙'])]
        inspector.contacts = lambda: rows
        inspector.directory_pages = lambda: iter([([], [], {'contact_list': 12})])
        pages, offset = [rows[:4], rows[1:]], [0]
        inspector.list_rows = lambda obj: pages[offset[0]]
        inspector.scroll_directory = lambda *args: offset.__setitem__(0, offset[0] + 1)
        visibility = iter([True, False, True, True])
        inspector.row_in_view = lambda *args: next(visibility)
        calls = []
        def profile(row, layout):
            calls.append(row['label'])
            return {'id': row['label'], 'label': row['label'], 'kind': 'person'}
        inspector.directory_profile = profile
        result = inspector.resolve_contacts(['甲', '同名', '乙', '丙'])
        self.assertEqual(calls, ['甲', '乙', '丙'])
        self.assertIsNone(result[1])

    def test_batch_keeps_header_like_nicknames_and_excludes_service_rows(self):
        inspector = object.__new__(native.NativeControls)
        rows = [{'obj': i + 10, 'label': label} for i, label in enumerate(['服务同名', '联系人3', '末尾'])]
        headers = [{'obj': i, 'label': label} for i, label in enumerate(['公众号、服务号1', '服务同名', '企业微信联系人0', '联系人3'])]
        inspector.contacts = lambda: rows
        inspector._directory_labels = [r['label'] for r in headers + rows]
        inspector.directory_pages = lambda: iter([([], [], {'contact_list': 12})])
        pages, offset = [headers + rows[:2], rows[1:]], [0]
        inspector.list_rows = lambda obj: pages[offset[0]]
        inspector.scroll_directory = lambda *args: offset.__setitem__(0, offset[0] + 1)
        inspector.row_in_view = lambda *args: True
        clicked = []
        def profile(row, layout):
            clicked.append(row['obj'])
            return {'id': str(row['obj']), 'label': row['label'], 'kind': 'person'}
        inspector.directory_profile = profile
        self.assertEqual(len(inspector.resolve_contacts([r['label'] for r in rows])), 3)
        self.assertEqual(clicked, [10, 11, 12])

    def test_batch_rejects_changed_pages_before_clicking(self):
        inspector = object.__new__(native.NativeControls)
        inspector.contacts = lambda: [{'obj': 1, 'label': '甲'}]
        inspector.directory_pages = lambda: iter([([], [], {'contact_list': 12})])
        inspector.list_rows = lambda obj: [{'obj': 1, 'label': '乙'}]
        inspector.directory_profile = lambda *args: self.fail('changed row clicked')
        with self.assertRaisesRegex(native.ControlsUnavailable, 'pages changed'):
            inspector.resolve_contacts(['甲'])

    def test_batch_reacquires_rows_recreated_after_selecting_a_profile(self):
        inspector = object.__new__(native.NativeControls)
        generation, clicked = [0], []
        def current_rows(*args):
            return [{'obj': generation[0] * 10 + i, 'label': label} for i, label in enumerate(['甲', '乙'], 1)]
        inspector.contacts = current_rows
        inspector.directory_pages = lambda: iter([([], [], {'contact_list': 12})])
        inspector.list_rows = current_rows
        inspector.row_in_view = lambda *args: True
        def profile(row, layout):
            self.assertIn(row, current_rows())
            clicked.append(row['obj'])
            generation[0] += 1
            return {'id': row['label'], 'label': row['label'], 'kind': 'person'}
        inspector.directory_profile = profile
        inspector.resolve_contacts(['甲', '乙'])
        self.assertEqual(clicked, [1, 12])

    def test_batch_realigns_when_selecting_a_profile_moves_the_viewport(self):
        inspector = object.__new__(native.NativeControls)
        rows = [{'obj': i, 'label': label} for i, label in enumerate(['甲', '乙', '丙', '丁'])]
        clicked = []
        inspector.contacts = lambda: rows
        inspector.directory_pages = lambda: iter([([], [], {'contact_list': 12})])
        inspector.list_rows = lambda obj: rows[1:] if clicked else rows[:3]
        inspector.row_in_view = lambda *args: True
        def profile(row, layout):
            clicked.append(row['label'])
            return {'id': row['label'], 'label': row['label'], 'kind': 'person'}
        inspector.directory_profile = profile
        inspector.resolve_contacts(['甲', '丙', '丁'])
        self.assertEqual(clicked, ['甲', '丙', '丁'])

    def test_account_settings_accepts_the_verified_same_process_more_popup(self):
        inspector = object.__new__(native.NativeControls)
        clicks = []
        lookup = {(1, '通讯录'): 10, (1, '更多'): 11, (3, '设置'): 12, (20, '账号与存储'): 21}
        inspector.find = lambda root, label, *args, **kwargs: lookup.get((root, label))
        inspector.press = clicks.append
        inspector.refresh = lambda obj: None
        inspector.children = lambda obj: [2, 3]
        inspector.string = lambda method, obj: 'frame' if obj == 2 else 'filler'
        inspector._observe = lambda operation: operation()
        inspector.settings = lambda app: 20
        def foreground(expected_title=None):
            current = '设置' if 12 in clicks else 'wechat' if 11 in clicks else '微信'
            if expected_title and expected_title != current:
                raise native.ControlsUnavailable('foreground title changed')
        inspector.require_foreground = foreground
        self.assertEqual(inspector._account_settings(1), 20)
        self.assertEqual(clicks, [11, 12, 21])

    def test_contacts_shell_does_not_need_selected_chat_messages_editor_or_send(self):
        nodes = directory_nodes()
        self.assertEqual(native.main_nodes(nodes, 1)['contacts_button'], 11)
        self.assertEqual(native.directory_nodes(nodes, 1)['contact_list'], 12)
        with self.assertRaises(native.ControlsUnavailable):
            native.locate_nodes(nodes, 1)

    def test_unknown_or_ambiguous_lists_are_not_treated_as_a_contacts_directory(self):
        nodes = directory_nodes()
        nodes[-1]['name'] = ''
        self.assertEqual(native.directory_nodes(nodes, 1)['contact_list'], 12)
        nodes.append(node(13, 2, 'list', '消息', (301, 81, 900, 600)))
        with self.assertRaises(native.ControlsUnavailable):
            native.directory_nodes(nodes, 1)
        nodes[-1]['name'] = '其他列表'
        with self.assertRaises(native.ControlsUnavailable):
            native.directory_nodes(nodes, 1)

    def test_exposed_offscreen_contacts_are_not_silently_cut_to_fifty(self):
        inspector = object.__new__(native.NativeControls)
        inspector.open_contacts = lambda: {'contact_list': 12}
        inspector.directory = inspector.open_contacts
        inspector.scroll_directory = lambda *args: None
        inspector.children = lambda obj: list(range(100, 175))
        inspector.refresh = lambda obj: None
        inspector.string = lambda method, obj: 'list item' if method == 'get_role_name' else '测试好友' + str(obj)
        # The listing must never demand each row's current visibility/bounds.
        contacts = inspector.contacts()
        self.assertEqual(len(contacts), 75)
        self.assertEqual(contacts[-1]['label'], '测试好友174')

    def inspector(self, duplicated=False):
        inspector = object.__new__(native.NativeControls)
        nodes = directory_nodes() + profile_nodes()
        nodes[4]['parent'] = 2
        layout = native.directory_nodes(nodes, 1)
        inspector.open_contacts = lambda: layout
        inspector.list_rows = lambda obj: [{'obj': 90, 'label': '测试对象'}] * (2 if duplicated else 1)
        inspector._located_nodes = nodes
        inspector.directory = lambda: layout
        inspector.scroll_directory = lambda *args: None
        inspector._visible_roots = lambda *args: []
        inspector._observe = lambda operation: operation()
        inspector.require_foreground = lambda *args: None
        inspector.locate = lambda: {'label': '测试对象'}
        inspector.contact = lambda: native.profile_identity(profile_nodes(), '测试对象')
        actions = []
        inspector.press_row = lambda row, container: actions.append(('row', row['obj']))
        inspector.row_in_view = lambda row, container: True
        inspector.press = lambda obj: actions.append(('press', obj))
        return inspector, actions

    def test_directory_resolve_reads_real_profile_without_opening_or_sending_chat(self):
        inspector, actions = self.inspector()
        self.assertEqual(inspector.directory_contact('测试对象'), native.profile_identity(profile_nodes(), '测试对象'))
        self.assertEqual(actions, [('row', 90)])

    def test_duplicate_directory_labels_are_never_guessed(self):
        inspector, actions = self.inspector(duplicated=True)
        with self.assertRaises(native.ControlsUnavailable):
            inspector.directory_contact('测试对象')
        self.assertEqual(actions, [])

    def test_chat_opens_only_after_matching_account_scoped_identity(self):
        inspector, actions = self.inspector()
        identity = native.profile_identity(profile_nodes(), '测试对象')
        key = native.hashlib.sha256(('account\0' + identity['id']).encode()).hexdigest()
        self.assertEqual(inspector.directory_contact('测试对象', True, key, 'account'), identity)
        self.assertEqual(actions, [('row', 90), ('press', 25)])
        inspector, actions = self.inspector()
        with self.assertRaises(native.ControlsUnavailable):
            inspector.directory_contact('测试对象', True, 'b' * 64, 'account')
        self.assertEqual(actions, [('row', 90)])

    def test_opened_chat_is_reverified_against_directory_identity(self):
        inspector, actions = self.inspector()
        inspector.contact = lambda: native.profile_identity(profile_nodes('wxid_another'), '测试对象')
        with self.assertRaises(native.ControlsUnavailable):
            inspector.directory_contact('测试对象', True)
        self.assertEqual(actions, [('row', 90), ('press', 25)])

    def test_offscreen_contact_is_scrolled_and_verified_before_click(self):
        inspector = object.__new__(native.NativeControls)
        scrolled, actions = [], []
        inspector.require_foreground = lambda *args: None
        inspector.refresh = lambda obj: None
        inspector.string = lambda method, obj: '测试对象'
        inspector.visible = lambda obj: bool(scrolled)
        inspector.bounds = lambda obj: (61, 81, 240, 718) if obj == 12 else ((70, 100, 220, 45) if scrolled else (70, 1000, 220, 45))
        def bind(name, result, args):
            if name == 'atspi_accessible_get_component_iface':
                return lambda obj: 99
            self.assertEqual(name, 'atspi_component_scroll_to')
            return lambda obj, alignment, error: scrolled.append((obj, alignment)) or 1
        inspector.bind = bind
        inspector._observe = lambda operation: operation()
        inspector.press = actions.append
        inspector.press_row({'obj': 90, 'label': '测试对象'}, 12)
        self.assertEqual(scrolled, [(99, 6)])
        self.assertEqual(actions, [90])

    def test_changed_row_or_failed_scroll_never_clicks_the_contact(self):
        for changed in (True, False):
            inspector = object.__new__(native.NativeControls)
            inspector.require_foreground = lambda *args: None
            inspector.refresh = lambda obj: None
            inspector.string = lambda method, obj: '已变化' if changed else '测试对象'
            inspector.visible = lambda obj: False
            inspector.bind = lambda *args: lambda *args: 0
            actions = []
            inspector.press = actions.append
            with self.assertRaises(native.ControlsUnavailable):
                inspector.press_row({'obj': 90, 'label': '测试对象'}, 12)
            self.assertEqual(actions, [])


class FakeXlib:
    """Xlib allocates format-32 arrays as host longs, not packed wire words."""
    def __init__(self):
        self.atoms = {'_NET_ACTIVE_WINDOW': 100, '_NET_WM_PID': 101, 'WINDOW': 33,
                      'CARDINAL': 6, '_NET_CLIENT_LIST': 102, '_NET_WM_NAME': 103,
                      'UTF8_STRING': 104, 'WM_NAME': 39, 'STRING': 31}
        self.properties = {(1, 100): {'values': [10], 'type': 33},
                           (1, 102): {'values': [10], 'type': 33},
                           (10, 101): {'values': [42], 'type': 6},
                           (10, 103): {'bytes': '微信'.encode(), 'type': 104, 'format': 8}}
        self.mapping = {10: 2}
        self.calls, self.buffers, self.freed, self.closed = [], [], [], []
        self.handler, self.storage = 123, c.c_ulong
        self.XOpenDisplay = FakeFunction(lambda name: 1000)
        self.XCloseDisplay = FakeFunction(lambda display: self.closed.append(display) or 0)
        self.XDefaultRootWindow = FakeFunction(lambda display: 1)
        self.XInternAtom = FakeFunction(self.intern)
        self.XGetWindowProperty = FakeFunction(self.property)
        self.XGetWindowAttributes = FakeFunction(self.attributes)
        self.XFree = FakeFunction(lambda pointer: self.freed.append(pointer.value) or 0)
        self.XSetErrorHandler = FakeFunction(self.error_handler)

    def intern(self, display, name, only_existing):
        assert only_existing == 1
        return self.atoms.get(name.decode(), 0)

    def error_handler(self, callback):
        previous, self.handler = self.handler, callback
        return previous

    def attributes(self, display, window, output):
        if window not in self.mapping:
            return 0
        result = c.cast(output, c.POINTER(native.XWindowAttributes)).contents
        result.map_state = self.mapping[window]
        result.width, result.height = 1280, 800
        return 1

    def property(self, display, window, atom, offset, length, delete, expected,
                 actual_type, actual_format, count, remaining, pointer):
        self.calls.append((window, atom, offset, length, delete, expected))
        assert offset == 0 and delete == 0
        prop = self.properties.get((window, atom), {})
        if callable(prop):
            prop = prop()
        wire_format = prop.get('format', 32 if prop else 0)
        values = prop.get('values', [])
        payload = prop.get('bytes', b'')
        nitems = prop.get('count', len(payload) if wire_format == 8 else len(values))
        c.cast(actual_type, c.POINTER(c.c_ulong))[0] = prop.get('type', 0)
        c.cast(actual_format, c.POINTER(c.c_int))[0] = wire_format
        c.cast(count, c.POINTER(c.c_ulong))[0] = nitems
        c.cast(remaining, c.POINTER(c.c_ulong))[0] = prop.get('remaining', 0)
        if prop and not prop.get('null'):
            buffer = c.create_string_buffer(payload) if wire_format == 8 else (self.storage * max(1, len(values)))(*values)
            self.buffers.append(buffer)
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = c.cast(buffer, c.c_void_p).value
        return prop.get('status', 0)


def foreground_inspector():
    inspector = object.__new__(native.NativeControls)
    inspector.pid, inspector.deadline, inspector.calls, inspector.cancelled = 42, time.monotonic() + 5, 0, False
    return inspector


def owned_settings_inspector():
    inspector = foreground_inspector()
    inspector.opened, inspector.menu, inspector.created_settings, inspector.app = 20, None, True, 1
    inspector._settings_close_requested = False
    inspector.refresh = lambda obj: None
    inspector.find = lambda *args: 21
    return inspector


class Boundaries(unittest.TestCase):
    def test_native_call_budget_is_bounded(self):
        standard = object.__new__(native.NativeControls)
        standard.calls = native.MAX_CALLS; standard.cancelled = False; standard.deadline = time.monotonic() + 5
        with self.assertRaises(native.ControlsUnavailable):
            standard.check()

    def test_foreground_requires_stable_current_pid_and_frees_property_storage(self):
        fake = FakeXlib()
        with patch.object(native.c, 'CDLL', return_value=fake):
            self.assertIsNone(foreground_inspector().require_foreground())
        self.assertEqual(len(fake.freed), 3)
        self.assertEqual(fake.closed, [1000])
        self.assertEqual(fake.handler, 123)
        self.assertTrue(all(call[4] == 0 for call in fake.calls))

    def test_foreground_expected_title_rejects_covering_window_from_same_pid(self):
        fake = FakeXlib()
        with patch.object(native.c, 'CDLL', return_value=fake):
            self.assertIsNone(foreground_inspector().require_foreground(expected_title='微信'))
            with self.assertRaises(native.ControlsUnavailable):
                foreground_inspector().require_foreground(expected_title='设置')

    def test_foreground_unknown_wrong_pid_and_changing_window_fail_closed(self):
        for mutation in ('missing', 'pid', 'zero', 'changed'):
            fake = FakeXlib()
            if mutation == 'missing':
                del fake.properties[(10, 101)]
            elif mutation == 'pid':
                fake.properties[(10, 101)]['values'] = [43]
            elif mutation == 'zero':
                fake.properties[(1, 100)]['values'] = [0]
            else:
                values = iter([10, 11])
                fake.properties[(1, 100)] = lambda: {'values': [next(values)], 'type': 33}
            with self.subTest(mutation=mutation), patch.object(native.c, 'CDLL', return_value=fake):
                with self.assertRaises(native.ControlsUnavailable):
                    foreground_inspector().require_foreground()
            self.assertEqual(fake.closed, [1000])

    def test_property32_rejects_wrong_type_format_count_trailing_data_and_error(self):
        for field, value in (('type', 6), ('format', 8), ('count', 0), ('count', 2),
                             ('remaining', 4), ('null', True), ('status', 1)):
            fake = FakeXlib()
            fake.properties[(1, 100)][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(native.ControlsUnavailable):
                native.x11_property32(fake, 1000, 1, 100, 33)

    def test_xlib_32bit_properties_use_64bit_long_stride_on_lp64(self):
        fake = FakeXlib()
        fake.storage = c.c_uint64
        fake.properties[(1, 102)]['values'] = [0xaaaaaaaa12345678, 0xbbbbbbbb009abcde]
        # Windows test hosts use LLP64; explicitly simulate the Linux LP64 ABI.
        with patch.object(native.c, 'c_ulong', c.c_uint64):
            values = native.x11_property_array(fake, 1000, 1, 102, 33, 32)
        self.assertEqual(values, [0x12345678, 0x009abcde])
        self.assertEqual(len(fake.freed), 1)

    def test_mapped_frame_includes_live_settings_and_excludes_unmapped_ghost(self):
        for mapping in (0, 1, 2):
            fake = FakeXlib()
            fake.properties[(1, 102)]['values'].append(11)
            fake.properties[(11, 101)] = {'values': [42], 'type': 6}
            fake.properties[(11, 103)] = {'bytes': '设置'.encode(), 'type': 104, 'format': 8}
            fake.mapping[11] = mapping
            with patch.object(native.c, 'CDLL', return_value=fake):
                frames = foreground_inspector()._mapped_frames()
            self.assertEqual(frames, {'微信', '设置'} if mapping == 2 else {'微信'})

    def test_mapped_frame_name_can_use_wm_name_but_unknown_metadata_is_rejected(self):
        fake = FakeXlib()
        del fake.properties[(10, 103)]
        fake.properties[(10, 39)] = {'bytes': '微信'.encode(), 'type': 31, 'format': 8}
        with patch.object(native.c, 'CDLL', return_value=fake):
            self.assertEqual(foreground_inspector()._mapped_frames(), {'微信'})
        del fake.properties[(10, 39)]
        with patch.object(native.c, 'CDLL', return_value=fake), self.assertRaises(native.ControlsUnavailable):
            foreground_inspector()._mapped_frames()

    def test_ghost_settings_are_not_read_or_reported_but_filler_popup_remains(self):
        inspector = foreground_inspector()
        inspector.refresh = lambda obj: None
        inspector.children = lambda obj: [2, 20, 30]
        inspector.states = lambda obj: VISIBLE
        inspector.bounds = lambda obj: (319, 119, 640, 560)
        inspector.string = lambda method, obj: ({2: 'frame', 20: 'frame', 30: 'filler'}[obj]
            if method == 'get_role_name' else {2: '微信', 20: '设置', 30: ''}[obj])
        inspector._mapped_frames = lambda: {'微信'}
        self.assertIsNone(inspector.settings(1))
        self.assertEqual(inspector._visible_roots(1, 2), [30])
        inspector._mapped_frames = lambda: {'微信', '设置'}
        self.assertEqual(inspector.settings(1), 20)
        self.assertEqual(inspector._visible_roots(1, 2), [20, 30])

    def test_unmapped_wechat_frame_cannot_supply_controls(self):
        nodes = chat_nodes()
        nodes[1]['frame_viewable'] = False
        with self.assertRaises(native.ControlsUnavailable):
            native.locate_nodes(nodes, 1)

    def test_locator_deduplicates_nested_header_and_accepts_disabled_send(self):
        result = native.locate_nodes(chat_nodes(), 1)
        self.assertEqual(result['header'], 8)
        self.assertEqual(result['editor'], 9)
        self.assertEqual(result['send'], 10)
        self.assertEqual(result['label'], '测试对象')

    def test_editor_name_is_never_an_identifier(self):
        nodes = chat_nodes()
        nodes[-2]['name'] = 'draft with arbitrary changing text'
        self.assertEqual(native.locate_nodes(nodes, 1)['editor'], 9)
        nodes[-2]['interfaces'] = {'text': 9}
        with self.assertRaises(native.ControlsUnavailable):
            native.locate_nodes(nodes, 1)

    def test_same_bounds_unrelated_headers_remain_ambiguous(self):
        nodes = chat_nodes()
        nodes.append(node(11, 5, 'label', '测试对象', (330, 36, 120, 25),
                          states=VISIBLE | {11}, depth=3))
        with self.assertRaises(native.ControlsUnavailable):
            native.locate_nodes(nodes, 1)

    def test_hidden_list_does_not_compete_with_visible_message_list(self):
        nodes = chat_nodes() + [node(11, 2, 'list', '消息', (0, 0, 0, 0), states=set())]
        self.assertEqual(native.locate_nodes(nodes, 1)['message_list'], 4)

    def test_profile_button_is_new_in_separate_right_overlay_not_outside_list(self):
        nodes = chat_nodes()
        controls = native.locate_nodes(nodes, 1)
        nodes.extend([node(40, 2, 'filler', bounds=(990, 81, 289, 578), depth=2),
                      node(41, 40, 'push button', '测试对象', (1047, 95, 45, 59), depth=3)])
        self.assertEqual(native.profile_target(nodes, controls, set())['obj'], 41)
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_target(nodes, controls, {41})
        nodes[-1]['parent'] = 5
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_target(nodes, controls, set())

    def test_profile_buttons_with_duplicate_or_wrong_side_evidence_fail(self):
        nodes = chat_nodes()
        controls = native.locate_nodes(nodes, 1)
        nodes.append(node(41, 2, 'push button', '测试对象', (350, 95, 45, 59), depth=2))
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_target(nodes, controls, set())
        nodes[-1]['bounds'] = (1047, 95, 45, 59)
        nodes.append(node(42, 2, 'push button', '测试对象', (1140, 95, 45, 59), depth=2))
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_target(nodes, controls, set())

    def test_profile_identity_comes_only_from_contextual_two_label_row(self):
        profile = native.profile_identity(profile_nodes(), '测试对象')
        self.assertEqual(profile['kind'], 'person')
        self.assertEqual(len(profile['id']), 64)
        self.assertNotIn('wxid_contact_123', str(profile))
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_identity(profile_nodes(), '另一个对象')
        for invalid in ('', '小明', 'wxid_good\nsecond', ' 微信号：wxid_contact_123', 'wxid'):
            with self.subTest(invalid=invalid), self.assertRaises(native.ControlsUnavailable):
                native.profile_identity(profile_nodes(invalid), '测试对象')

    def test_name_or_preview_cannot_supply_wxid(self):
        nodes = profile_nodes()
        nodes[3]['name'] = '其他字段'
        nodes.append(node(30, 20, 'label', '微信号：wxid_victim'))
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_identity(nodes, '测试对象')

    def test_ambiguous_or_non_person_profile_is_rejected(self):
        nodes = profile_nodes()
        nodes.insert(5, node(26, 22, 'label', 'wxid_other', depth=2))
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_identity(nodes, '测试对象')
        with self.assertRaises(native.ControlsUnavailable):
            native.profile_identity(profile_nodes()[:-1], '测试对象')

    def test_first_line_preserves_exact_label_and_ignores_preview(self):
        self.assertEqual(native.first_line('测试对象\n消息预览\n12:34\n'), '测试对象')
        self.assertEqual(native.first_line(' 名称空格 \npreview'), ' 名称空格 ')
        for invalid in ('\npreview', '', 'x' * 121, 'bad\tname\npreview'):
            with self.assertRaises(native.ControlsUnavailable):
                native.first_line(invalid)

    def test_zero_hidden_prune_keeps_unknown_containers(self):
        self.assertTrue(native.hidden_zero({'states': set(), 'bounds': (0, 0, 0, 0)}))
        self.assertFalse(native.hidden_zero({'states': set(), 'bounds': None}))
        self.assertFalse(native.hidden_zero({'states': None, 'bounds': (0, 0, 0, 0)}))
        self.assertFalse(native.hidden_zero({'states': {25}, 'bounds': (0, 0, 0, 0)}))

    def test_existing_popup_is_never_opened_or_closed(self):
        inspector = object.__new__(native.NativeControls)
        inspector.locate = lambda: {'label': '测试对象', 'app': 1, 'frame': 2}
        inspector._visible_roots = lambda *args: [88]
        actions = []
        inspector.press = actions.append
        inspector._chat_cleanup = None
        with self.assertRaises(native.ControlsUnavailable):
            inspector.contact()
        self.assertEqual(actions, [])
        self.assertIsNone(inspector._chat_cleanup)

    def test_owned_settings_close_verifies_title_then_observes_unmapped(self):
        inspector = owned_settings_inspector()
        clicks, titles = [], []
        inspector.press = clicks.append
        inspector.require_foreground = lambda expected_title=None: titles.append(expected_title)
        inspector._mapped_frames = lambda: {'微信'} if clicks else {'微信', '设置'}
        inspector._close_settings()
        self.assertEqual(clicks, [21])
        self.assertEqual(titles, ['设置', '设置'])
        self.assertIsNone(inspector.opened)
        self.assertFalse(inspector.created_settings)
        self.assertFalse(inspector._settings_close_requested)

    def test_owned_settings_under_main_window_are_never_clicked(self):
        inspector = owned_settings_inspector()
        clicks = []
        inspector.press = clicks.append
        inspector._mapped_frames = lambda: {'微信', '设置'}
        inspector.require_foreground = lambda **args: (_ for _ in ()).throw(native.ControlsUnavailable('covered'))
        with self.assertRaises(native.ControlsUnavailable):
            inspector._close_settings()
        self.assertEqual(clicks, [])
        self.assertEqual(inspector.opened, 20)
        self.assertTrue(inspector.created_settings)

    def test_owned_settings_remaining_mapped_fail_without_clearing_ownership(self):
        inspector = owned_settings_inspector()
        clicks = []
        inspector.press = clicks.append
        inspector.require_foreground = lambda **args: None
        inspector._mapped_frames = lambda: {'微信', '设置'}
        with patch.object(native.time, 'monotonic', side_effect=[0.0, 0.1, 1.6]), patch.object(native.time, 'sleep'):
            with self.assertRaises(native.ControlsUnavailable):
                inspector._close_settings()
        self.assertEqual(clicks, [21])
        self.assertEqual(inspector.opened, 20)
        self.assertTrue(inspector.created_settings)
        self.assertTrue(inspector._settings_close_requested)
        frames = iter([{'微信', '设置'}, {'微信'}])
        inspector._mapped_frames = lambda: next(frames)
        inspector._close_settings()
        self.assertEqual(clicks, [21])
        self.assertIsNone(inspector.opened)

    def test_account_rejects_preexisting_settings_without_closing_it(self):
        inspector = owned_settings_inspector()
        inspector.opened, inspector.created_settings = None, False
        inspector.application = lambda: 1
        inspector._visible_roots = lambda *args: [20]
        inspector.string = lambda method, obj: 'frame' if method == 'get_role_name' else '设置'
        clicks = []
        inspector.press = clicks.append
        with patch.object(native.base.Inspector, 'inspect') as inspect:
            with self.assertRaises(native.ControlsUnavailable):
                inspector.account()
            inspect.assert_not_called()
        self.assertEqual(clicks, [])

    def test_cleanup_closes_remaining_owned_panel_via_info_once(self):
        inspector = object.__new__(native.NativeControls)
        baseline = chat_nodes()
        controls = native.locate_nodes(baseline, 1)
        with_panel = baseline + [node(40, 2, 'filler', bounds=(990, 81, 289, 578), depth=2),
                                 node(41, 40, 'push button', '测试对象', (1047, 95, 45, 59), depth=3)]
        inspector._chat_cleanup = {'app': 1, 'label': '测试对象'}
        budgets = []
        def budget(operation, **kwargs):
            budgets.append(kwargs.get('seconds'))
            return operation()
        inspector._cleanup_budget = budget
        inspector._observe = lambda operation: operation()
        inspector._visible_roots = lambda *args: []
        pressed = []
        def locate():
            inspector._located_nodes = baseline if 6 in pressed else with_panel
            return controls
        inspector.locate, inspector.press = locate, pressed.append
        inspector._close_chat()
        self.assertEqual(pressed, [8, 6])
        self.assertIsNone(inspector._chat_cleanup)
        self.assertEqual(budgets, [1.5])

    def test_cleanup_does_not_click_info_when_owned_panel_is_already_closed(self):
        inspector = object.__new__(native.NativeControls)
        inspector._located_nodes = chat_nodes()
        controls = native.locate_nodes(inspector._located_nodes, 1)
        reads = []
        def locate():
            reads.append(True)
            return controls
        inspector.locate = locate
        inspector._chat_cleanup = {'app': 1, 'label': '测试对象'}
        inspector._cleanup_budget = lambda operation, **kwargs: operation()
        inspector._observe = lambda operation: operation()
        inspector._visible_roots = lambda *args: []
        pressed = []
        inspector.press = pressed.append
        inspector._close_chat()
        self.assertEqual(pressed, [8])
        self.assertEqual(len(reads), 2)

    def test_same_header_still_verifies_expected_contact(self):
        inspector = object.__new__(native.NativeControls)
        inspector.locate = lambda: {'label': '测试对象'}
        inspected = []
        def contact():
            inspected.append(True)
            return {'id': 'a' * 64, 'label': '测试对象', 'kind': 'person'}
        inspector.contact = contact
        self.assertEqual(inspector.navigate('测试对象', 'a' * 64)['id'], 'a' * 64)
        with self.assertRaises(native.ControlsUnavailable):
            inspector.navigate('测试对象', 'b' * 64)
        self.assertEqual(len(inspected), 2)

    def test_duplicate_candidates_never_trigger_a_click(self):
        inspector = object.__new__(native.NativeControls)
        inspector.locate = lambda: {'label': '当前对象'}
        inspector.scan = lambda: [{'obj': 1, 'label': '测试对象'}, {'obj': 2, 'label': '测试对象'}]
        actions = []
        inspector.press = actions.append
        with self.assertRaises(native.ControlsUnavailable):
            inspector.navigate('测试对象')
        self.assertEqual(actions, [])

    def test_account_does_not_require_automatic_login_and_always_cleans_up(self):
        inspector = object.__new__(native.NativeControls)
        cleanup = []
        inspector.application = lambda: 1
        inspector._visible_roots = lambda *args: []
        inspector._close_settings = lambda: cleanup.append(True)
        inspector._account_settings = lambda app: 20
        inspector.refresh = lambda obj: None
        inspector._observe = lambda operation: operation()
        inspector.current_account = lambda obj: 'a' * 64
        with patch.object(native.base.Inspector, 'inspect') as inspect:
            self.assertEqual(inspector.account(), 'a' * 64)
            inspect.assert_not_called()
        with patch.object(inspector, 'current_account', side_effect=RuntimeError('interrupted')):
            with self.assertRaises(RuntimeError):
                inspector.account()
        self.assertEqual(len(cleanup), 2)

    def test_account_changing_between_reads_is_rejected_and_cleaned(self):
        inspector = object.__new__(native.NativeControls)
        inspector.application = lambda: 1
        inspector._visible_roots = lambda *args: []
        inspector._account_settings = lambda app: 20
        inspector.refresh = lambda obj: None
        inspector._observe = lambda operation: operation()
        account = iter(['a' * 64, 'b' * 64])
        inspector.current_account = lambda obj: next(account)
        cleanup = []
        inspector._close_settings = lambda: cleanup.append(True)
        with self.assertRaises(native.ControlsUnavailable):
            inspector.account()
        self.assertEqual(cleanup, [True])

    def test_account_does_not_dismiss_existing_personal_popup(self):
        inspector = object.__new__(native.NativeControls)
        inspector.application = lambda: 1
        inspector._visible_roots = lambda *args: [88]
        inspector.string = lambda method, obj: 'filler' if method == 'get_role_name' else ''
        inspector._close_settings = lambda: None
        with patch.object(native.base.Inspector, 'inspect') as inspect:
            with self.assertRaises(native.ControlsUnavailable):
                inspector.account()
            inspect.assert_not_called()

    def test_cleanup_preserves_cancelled_flag_and_original_call_budget(self):
        inspector = object.__new__(native.NativeControls)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() - 2, 100, True
        original = inspector.deadline
        def cleanup():
            self.assertFalse(inspector.cancelled)
            inspector.check()
        inspector._cleanup_budget(cleanup)
        self.assertTrue(inspector.cancelled)
        self.assertEqual(inspector.deadline, original)
        self.assertEqual(inspector.calls, 101)

    def test_cancellation_arriving_during_cleanup_is_preserved(self):
        inspector = object.__new__(native.NativeControls)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() + 3, 0, False
        inspector._cleanup_budget(lambda: setattr(inspector, 'cancelled', True))
        self.assertTrue(inspector.cancelled)

    def test_normal_profile_cleanup_uses_remaining_operation_budget_without_resetting_calls(self):
        inspector = object.__new__(native.NativeControls)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() + 20, 100, False
        deadline = inspector.deadline
        def cleanup():
            self.assertEqual(inspector.deadline, deadline)
            self.assertEqual(inspector.calls, 100)
            inspector.check()
        inspector._cleanup_budget(cleanup, seconds=1.5, remaining=True)
        self.assertEqual(inspector.calls, 101)

    def test_native_call_cap_is_enforced(self):
        inspector = object.__new__(native.NativeControls)
        self.assertEqual(native.MAX_CALLS, 80000)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() + 3, 79999, False
        inspector.check()
        self.assertEqual(inspector.calls, 80000)
        with self.assertRaises(native.ControlsUnavailable):
            inspector.check()

    def test_wall_time_still_interrupts_below_call_cap(self):
        inspector = object.__new__(native.NativeControls)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() - 1, 10, False
        with self.assertRaises(native.ControlsUnavailable):
            inspector.check()

    def test_observation_retry_does_not_swallow_cancellation(self):
        inspector = object.__new__(native.NativeControls)
        inspector.deadline, inspector.calls, inspector.cancelled = time.monotonic() + 3, 0, False
        observed = []
        def observe():
            observed.append(True)
            inspector.cancelled = True
            raise native.ControlsUnavailable('transition')
        with self.assertRaises(native.ControlsUnavailable):
            inspector._observe(observe)
        self.assertEqual(len(observed), 1)

    def test_tree_depth_node_caps_and_conservative_pruning(self):
        class Tree(native.NativeControls):
            def __init__(self, children, bounds=None, states=None):
                self.deadline, self.calls, self.cancelled = time.monotonic() + 5, 0, False
                self.branch, self.rect, self.flags = children, bounds, states
            def refresh(self, obj): pass
            def string(self, method, obj): return 'filler' if method == 'get_role_name' else ''
            def children(self, obj): return self.branch.get(obj, [])
            def states(self, obj): return self.flags if self.flags is not None else VISIBLE
            def bounds(self, obj): return self.rect
            def interfaces(self, obj): return {}
        with self.assertRaises(native.ControlsUnavailable):
            Tree({i: [i + 1] for i in range(33)}).tree(0)
        with self.assertRaises(native.ControlsUnavailable):
            Tree({0: list(range(1, 1001))}).tree(0)
        self.assertEqual(len(Tree({0: [1]}, bounds=None, states=set()).tree(0)), 2)
        self.assertEqual(len(Tree({0: [1]}, bounds=(0, 0, 0, 0), states=set()).tree(0)), 1)

    def test_large_navigation_tree_queries_editability_only_for_text_candidates(self):
        class Tree(native.NativeControls):
            def __init__(self):
                self.deadline, self.calls, self.cancelled = time.monotonic() + 5, 0, False
                self.queried = []
            def refresh(self, obj): pass
            def string(self, method, obj):
                return ('text' if obj == 99 else 'filler') if method == 'get_role_name' else ''
            def children(self, obj): return list(range(1, 100)) if obj == 0 else []
            def states(self, obj): return VISIBLE
            def bounds(self, obj): return (0, 0, 20, 20)
            def interfaces(self, obj): self.queried.append(obj); return {'editable_text': obj}
        inspector = Tree(); nodes = inspector.tree(0)
        self.assertEqual(len(nodes), 100)
        self.assertEqual(inspector.queried, [99])
        self.assertEqual(nodes[-1]['interfaces'], {'editable_text': 99})


class BackgroundNavigation(unittest.TestCase):
    def test_contacts_tab_returns_to_conversations_before_target_navigation(self):
        ins = object.__new__(native.NativeControls)
        ins._located_nodes = [node(2, 1, 'frame', '微信'),
            node(3, 2, 'push button', '通讯录', (1,145,60,36)),
            node(4, 2, 'push button', '微信', (1,97,60,36)),
            node(5, 2, 'list', '通讯录', (61,81,240,718))]
        ins.main = Mock(return_value={'app':1,'frame':2,'contacts_button':3})
        ins._visible_roots = Mock(return_value=[])
        ins.require_foreground = Mock(); ins.press = Mock()
        ins.conversation_list = Mock(return_value=6)
        ins._observe = lambda fn: fn()
        ins.ensure_conversations()
        ins.require_foreground.assert_called_once();ins.press.assert_called_once_with(4)
        ins.conversation_list.assert_called_once()
        ins.press.reset_mock();ins._visible_roots.return_value=[9]
        with self.assertRaises(native.ControlsUnavailable):ins.ensure_conversations()
        ins.press.assert_not_called()

    def test_existing_conversation_list_needs_no_sidebar_click(self):
        ins = object.__new__(native.NativeControls)
        ins._located_nodes = chat_nodes()
        ins.main=Mock(return_value={'app':1,'frame':2,'contacts_button':99})
        ins._visible_roots=Mock(return_value=[]);ins.press=Mock();ins.conversation_list=Mock(return_value=3)
        ins.ensure_conversations();ins.press.assert_not_called();ins.conversation_list.assert_called_once()

    def inspector(self, rows):
        ins = object.__new__(native.NativeControls)
        ins.main = Mock(return_value={'app': 1, 'frame': 2})
        ins._visible_roots = Mock(return_value=[])
        ins.scan = Mock(return_value=rows)
        ins.conversation_list = Mock(return_value=9)
        ins.list_rows = Mock(return_value=rows)
        ins.row_in_view = Mock(return_value=True)
        ins.locate = Mock(return_value={'label': '目标', 'conversation_list': 9})
        ins.press_row = Mock()
        ins._observe = lambda operation: operation()
        ins.directory_contact = Mock()
        ins.contact = Mock(side_effect=AssertionError('must not open details'))
        return ins

    def test_recent_navigation_only_clicks_row_then_uses_background_identity(self):
        ins = self.inspector([{'label': '目标', 'obj': 3}]); verify = Mock()
        ins.navigate_background('目标', verify)
        ins.press_row.assert_called_once_with({'label': '目标', 'obj': 3}, 9)
        verify.assert_called_once(); ins.contact.assert_not_called(); ins.directory_contact.assert_not_called()

    def test_duplicate_candidates_or_existing_popup_never_pick_one(self):
        for popup in (False, True):
            ins = self.inspector([{'label': '目标', 'obj': 3}, {'label': '目标', 'obj': 4}])
            if popup: ins._visible_roots.return_value = [12]
            verify = Mock()
            with self.assertRaises(native.ControlsUnavailable): ins.navigate_background('目标', verify)
            ins.press_row.assert_not_called(); verify.assert_not_called()

    def test_background_mismatch_is_not_replaced_by_label_success(self):
        ins = self.inspector([{'label': '目标', 'obj': 3}])
        with self.assertRaises(ValueError): ins.navigate_background('目标', Mock(side_effect=ValueError('wrong session')))
        ins.contact.assert_not_called()

    def test_offscreen_virtual_row_is_scrolled_then_reobserved_before_click(self):
        ins = self.inspector([{'label': '目标', 'obj': 3}])
        ins.row_in_view.side_effect = [False, True]
        ins.bounds = Mock(side_effect=[(61, 16, 240, 65), (61, 81, 240, 700)])
        ins.scroll_directory = Mock()
        ins.navigate_background('目标', Mock())
        ins.scroll_directory.assert_called_once_with('up', {'app': 1, 'frame': 2, 'contact_list': 9})
        # One initial read of the virtual conversation viewport, then one
        # re-read after the scroll moves the row into view.
        self.assertEqual(ins.list_rows.call_count, 3)
        ins.press_row.assert_called_once()

    def test_viewport_miss_searches_virtualized_list_top_down(self):
        # Target outside the exposed viewport: return to the top in large
        # bursts (no rows read while repositioning), then walk down one
        # viewport at a time until the row is seen.
        ins = self.inspector([])
        ins.deadline = 1 << 62  # far future: no budget break
        ins.scroll_directory = Mock()
        ins.list_rows.side_effect = [
            [],                       # entry read: viewport empty -> search
            [],                       # return-to-top burst read 1
            [],                       # return-to-top burst read 2 (stable -> stop)
            [],                       # walking down read 1: still empty
            [{'label': '目标', 'obj': 3}],  # walking down read 2: target found
            [{'label': '目标', 'obj': 3}],  # post-search viewport re-read -> click
        ]
        verify = Mock()
        ins.navigate_background('目标', verify)
        calls = ins.scroll_directory.call_args_list
        self.assertEqual([c.args[0] for c in calls], ['up', 'down'])
        self.assertEqual(calls[0].kwargs.get('bursts'), 12)
        self.assertNotIn('bursts', calls[1].kwargs)  # default 1: single gesture
        ins.press_row.assert_called_once_with({'label': '目标', 'obj': 3}, 9)
        verify.assert_called_once(); ins.directory_contact.assert_not_called()


class StateSnapshots(unittest.TestCase):
    def inspector(self, flags, count=None):
        import ctypes as c
        inspector = object.__new__(native.NativeControls)
        inspector.check = Mock()
        inspector.glib, inspector.gobject = Mock(), Mock()
        data = (c.c_int * len(flags))(*flags)
        array = native.StateArray(data, len(flags) if count is None else count)
        inspector.bind = Mock(side_effect=lambda name, *_: {
            'atspi_accessible_get_state_set': lambda _: 123,
            'atspi_state_set_get_states': lambda _: c.pointer(array),
        }[name])
        return inspector

    def test_current_state_snapshot_retains_error_and_visibility_flags(self):
        for flags in ([], [8, 11, 17, 24, 25, 30], [6, 8, 24, 25], [0, 3, 6]):
            with self.subTest(flags=flags):
                inspector = self.inspector(flags)
                self.assertEqual(inspector.states(99), set(flags))
                inspector.glib.g_array_free.assert_called_once()
                self.assertTrue(inspector.glib.g_array_free.call_args.args[1])
                inspector.gobject.g_object_unref.assert_called_once_with(123)

    def test_invalid_state_array_still_releases_native_ownership(self):
        inspector = self.inspector([8], count=65)
        with self.assertRaises(native.ControlsUnavailable): inspector.states(99)
        inspector.glib.g_array_free.assert_called_once()
        inspector.gobject.g_object_unref.assert_called_once_with(123)


class HistoryImportHint(unittest.TestCase):
    def hint(self):
        return [node(1, None, 'filler', bounds=(0, 0, 212, 39), depth=0),
                node(2, 1, 'label', '点此从手机导入更多聊天记录', (16, 10, 156, 19)),
                node(3, 1, 'push button', bounds=(180, 11, 16, 16)),
                node(4, 3, 'push button', bounds=(180, 11, 16, 16), depth=2)]

    def test_exact_nonmodal_hint_is_recognized(self):
        self.assertTrue(native.is_history_import_hint(self.hint()))

    def test_unknown_popup_or_editable_widget_still_blocks(self):
        for extra in [node(5, 1, 'text', bounds=(1, 1, 10, 10), interfaces={'editable_text': 5}),
                      node(5, 1, 'push button', '确认', (1, 1, 10, 10)),
                      node(5, 1, 'label', '其他提示', (1, 1, 10, 10)),
                      node(5, 1, 'push button', bounds=(180, 11, 16, 16))]:
            self.assertFalse(native.is_history_import_hint(self.hint() + [extra]))
        nodes = self.hint()
        nodes[0]['role'] = 'dialog'
        self.assertFalse(native.is_history_import_hint(nodes))
        nodes = self.hint()
        nodes[2]['bounds'] = (180, 11, 100, 100)
        self.assertFalse(native.is_history_import_hint(nodes))


if __name__ == '__main__':
    unittest.main()
