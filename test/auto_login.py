import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('auto_login', pathlib.Path(__file__).parents[1] / 'server' / 'auto-login.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SettingsInspector(module.Inspector):
    """Qt keeps the old Settings tree SHOWING after its X11 window closes."""
    def __init__(self):
        self.pid, self.desktop, self.app = 42, 'desktop', None
        self.opened, self.menu, self.created_settings, self.pointer = None, None, False, None
        self.mapped, self.popup, self.selected, self.pressed = False, False, '扫码登录', []
        self.nodes = {
            'app': ('application', 'wechat', ['main', 'settings']),
            'main': ('frame', '微信', ['contacts', 'more']),
            'contacts': ('push button', '通讯录', []),
            'more': ('push button', '更多', []),
            'settings': ('frame', '设置', ['tab', 'account', 'login', 'close']),
            'tab': ('push button', '账号与存储', []),
            'account': ('label', '账号', []),
            'login': ('combo box', '登录方式', ['selection']),
            'selection': ('label', '扫码登录', []),
            'close': ('push button', '关闭', []),
            'popup': ('filler', '', ['settings-item']),
            'settings-item': ('menu item', '设置', []),
        }

    def check(self): pass
    def refresh(self, obj): pass
    def call(self, method, result, obj, *args): return self.pid
    def children(self, obj):
        if obj == 'desktop': return ['app']
        return self.nodes[obj][2] + (['popup'] if obj == 'app' and self.popup else [])
    def string(self, method, obj):
        if method == 'get_role_name': return self.nodes[obj][0]
        return self.selected if obj == 'selection' else self.nodes[obj][1]
    def states(self, obj): return {8, 24, 25, 30}
    def bounds(self, obj): return (100, 100, 640, 560)
    def _mapped_frames(self): return {'微信', '设置'} if self.mapped else {'微信'}
    def current_account(self, settings): return module.account_key(['昵称', 'wechat_123'])
    def press(self, obj):
        self.pressed.append(obj)
        if obj == 'more': self.popup = not self.popup
        if obj == 'settings-item': self.mapped, self.popup, self.selected = True, False, '自动登录'
        if obj == 'close': self.mapped = False


class NativeControlTest(unittest.TestCase):
    def test_expired_notice_dismissal_requires_explicit_login_request_and_exact_native_notice(self):
        for variant in ('valid', 'read-only', 'other-notice', 'unmapped'):
            inspector = SettingsInspector()
            inspector.nodes['main'] = ('frame', '微信', ['relogin', 'notice', 'ack'])
            inspector.nodes['relogin'] = ('push button', '重新登录', [])
            inspector.nodes['notice'] = ('label', '当前账号于00:52在BOTPC设备上登录。若不是本人操作，请修改密码。' if variant != 'other-notice' else '是否删除聊天记录？', [])
            inspector.nodes['ack'] = ('push button', '我知道了', [])
            if variant == 'unmapped': inspector._mapped_frames = lambda: set()
            inspector.inspect_session(login_page=variant != 'read-only')
            self.assertEqual('ack' in inspector.pressed, variant == 'valid')

    def test_session_ignores_login_method_settings_and_large_chat_content(self):
        inspector = SettingsInspector()
        inspector.nodes['selection'] = ('label', '扫码登录', [])
        inspector.nodes['main'][2].append('scroll')
        inspector.nodes['scroll'] = ('scroll pane', '', ['chat-login-text'])
        inspector.nodes['chat-login-text'] = ('label', '扫描二维码登录微信', [])
        inspector.mapped = True
        self.assertEqual(inspector.inspect_session()['status'], 'logged-in')
        self.assertEqual(inspector.pressed, [])

    def test_scheduled_start_clicks_only_one_live_login_button(self):
        def login_page():
            inspector = SettingsInspector()
            inspector.nodes['main'] = ('frame', '微信', ['login-button'])
            inspector.nodes['login-button'] = ('push button', '登录', [])
            return inspector
        inspector = login_page()
        self.assertEqual(inspector.inspect_session()['status'], 'logged-out')
        self.assertEqual(inspector.pressed, [])
        self.assertTrue(inspector.inspect_session(scheduled_login=True)['clicked'])
        self.assertEqual(inspector.pressed, ['login-button'])
        inspector = login_page()
        inspector.nodes['login-button'] = ('push button', '进入微信', [])
        self.assertEqual(inspector.inspect_session()['status'], 'logged-out')
        self.assertEqual(inspector.pressed, [])
        self.assertTrue(inspector.inspect_session(scheduled_login=True)['clicked'])
        self.assertEqual(inspector.pressed, ['login-button'])
        for variant in ('qr', 'phone', 'expired', 'hidden', 'closed', 'duplicate', 'logged-in'):
            inspector = login_page()
            if variant in ('qr', 'phone', 'expired'):
                inspector.nodes['login-button'] = ('push button', {'qr': '扫码登录', 'phone': '确认登录', 'expired': '重新登录'}[variant], [])
            if variant == 'hidden': inspector.states = lambda obj: {8, 24}
            if variant == 'closed': inspector._mapped_frames = lambda: set()
            if variant == 'duplicate': inspector.nodes['main'][2].append('login-button')
            if variant == 'logged-in': inspector.nodes['main'][2].extend(['contacts', 'more'])
            inspector.inspect_session(scheduled_login=True)
            self.assertEqual(inspector.pressed, [], variant)

    def test_closed_settings_ghost_does_not_hide_new_automatic_login_selection(self):
        inspector = SettingsInspector()
        result = inspector.inspect(navigate=True)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['reason'], 'native-login-method')
        self.assertEqual(inspector.pressed, ['more', 'settings-item', 'tab'])
        inspector.close()
        self.assertEqual(inspector.pressed[-1], 'close')
        self.assertFalse(inspector.mapped)

    def test_passive_inspection_never_uses_ready_value_from_closed_settings(self):
        inspector = SettingsInspector()
        inspector.selected = '自动登录'
        self.assertEqual(inspector.inspect(), {'status': 'unknown', 'reason': 'settings-closed'})
        self.assertEqual(inspector.pressed, [])

    def test_existing_real_settings_are_read_without_navigation_or_closing(self):
        inspector = SettingsInspector()
        inspector.mapped, inspector.selected = True, '自动登录'
        self.assertEqual(inspector.inspect()['status'], 'ready')
        inspector.close()
        self.assertTrue(inspector.mapped)
        self.assertEqual(inspector.pressed, [])

    def test_mapping_is_required_but_cannot_replace_unique_visible_native_settings(self):
        for variant in ('hidden', 'zero', 'duplicate', 'wrong-role'):
            inspector = SettingsInspector()
            inspector.mapped = True
            if variant == 'hidden': inspector.states = lambda obj: {8, 24}
            if variant == 'zero': inspector.bounds = lambda obj: (0, 0, 0, 0)
            if variant == 'duplicate':
                inspector.nodes['duplicate'] = inspector.nodes['settings']
                inspector.nodes['app'][2].append('duplicate')
            if variant == 'wrong-role': inspector.nodes['settings'] = ('label', '设置', [])
            with self.subTest(variant=variant), self.assertRaises(RuntimeError):
                inspector.settings('app')

    def test_current_login_controls_and_expired_overlay(self):
        visible = {8, 24, 25, 30}
        navigation = [('push button', name, visible) for name in ['通讯录', '更多']]
        self.assertEqual(module.classify_session(navigation), 'logged-in')
        self.assertEqual(module.classify_session([(r,n,s-{25}) for r,n,s in navigation]), 'logged-in')
        self.assertEqual(module.classify_session(navigation + [('push button','重新登录',visible)]), 'relogin-required')
        self.assertEqual(module.classify_session(navigation + [('label','扫描二维码登录微信',visible)]), 'logged-out')
        self.assertEqual(module.classify_session([('push button','登录',visible)]), 'logged-out')
        self.assertEqual(module.classify_session([('push button','进入微信',visible)]), 'logged-out')
        self.assertEqual(module.classify_session([('label','进入微信',visible)]), 'unknown')
        self.assertEqual(module.classify_session([('label','通讯录',visible),('label','更多',visible)]), 'unknown')
        self.assertEqual(module.classify_session([]), 'unknown')

    def test_login_navigation_requires_expired_native_control_and_explicit_action(self):
        class FakeInspector(module.Inspector):
            def __init__(self, names):
                self.pid, self.desktop = 42, 'desktop'
                self.nodes, self.pressed = names, []
            def children(self, obj): return ['app']
            def call(self, *args): return 42
            def string(self, *args): return 'wechat'
            def refresh(self, obj): pass
            def _mapped_frames(self): return set()
            def walk(self, obj, depth=0, session=False):
                for name in self.nodes: yield name, 'push button', name
            def states(self, obj): return {8, 24, 25, 30}
            def press(self, obj): self.pressed.append(obj)
        expired = FakeInspector(['重新登录'])
        self.assertEqual(expired.inspect_session()['status'], 'relogin-required')
        self.assertEqual(expired.pressed, [])
        expired.inspect_session(login_page=True)
        self.assertEqual(expired.pressed, ['重新登录'])
        for names in [['通讯录', '更多', '退出登录'], ['登录'], ['切换账号']]:
            inspector = FakeInspector(names)
            inspector.inspect_session(login_page=True)
            self.assertEqual(inspector.pressed, [])

    def test_account_row_uses_current_wechat_id_not_nickname(self):
        first = module.account_key(['昵称', 'wechat_123'])
        self.assertEqual(first, module.account_key(['新的昵称', 'wechat_123']))
        self.assertEqual(first, module.account_key(['昵称', '微信号：wechat_123']))
        self.assertNotEqual(first, module.account_key(['昵称', 'wechat_456']))
        for labels in ([], ['wechat_123'], ['昵称', ''], ['昵称', 'wechat_123', 'wechat_456'], ['昵称', '中文昵称']):
            self.assertIsNone(module.account_key(labels))

    def test_real_nas_unavailable_observation(self):
        self.assertEqual(module.classify_control({8, 24}, ['']), 'unavailable')

    def test_device_auto_login_requires_selected_value_or_checked_setting(self):
        states = {8, 24, 25, 30}
        self.assertEqual(module.classify_control(states, ['自动登录该设备']), 'ready')
        self.assertEqual(module.classify_control(states, ['自动登录该设备'], 'check box'), 'unavailable')
        self.assertEqual(module.classify_control(states | {4}, ['自动登录该设备'], 'check box'), 'ready')
        for removed in states:
            self.assertNotEqual(module.classify_control((states | {4}) - {removed}, ['自动登录该设备'], 'check box'), 'ready')
        for bad in (0, 6, 27, 32):
            self.assertEqual(module.classify_control(states | {4, bad}, ['自动登录该设备'], 'check box'), 'unknown')
        self.assertNotEqual(module.classify_control(states, ['自动登录该设备', '扫码登录']), 'ready')

    def test_device_setting_is_read_only_and_scoped_to_current_account_settings(self):
        for checked in (False, True):
            inspector = SettingsInspector()
            inspector.mapped = True
            inspector.nodes['login'] = ('check box', '自动登录该设备', [])
            inspector.states = lambda obj: {8, 24, 25, 30} | ({4} if checked else set())
            self.assertEqual(inspector.inspect()['status'], 'ready' if checked else 'unavailable')
            self.assertEqual(inspector.pressed, [])
        inspector.current_account = lambda settings: None
        self.assertEqual(inspector.inspect()['reason'], 'account-unavailable')

    def test_only_exact_current_visible_enabled_selection(self):
        states = {8, 24, 25, 30}
        self.assertEqual(module.classify_control(states, ['自动登录']), 'ready')
        for labels in ([], [''], ['自动登录', '扫码登录'], ['开启自动登录'], ['不自动登录']):
            self.assertNotEqual(module.classify_control(states, labels), 'ready')
        for removed in states:
            self.assertNotEqual(module.classify_control(states - {removed}, ['自动登录']), 'ready')
        for bad in (0, 6, 27, 32):
            self.assertEqual(module.classify_control(states | {bad}, ['自动登录']), 'unknown')


if __name__ == '__main__':
    unittest.main()
