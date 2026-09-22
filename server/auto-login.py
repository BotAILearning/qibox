"""Read official WeChat's accessibility controls, never its encrypted credentials.

Navigation only opens/closes Settings, and is allowed only without a desktop
viewer. It never changes the login choice or performs a login/logout action.
Only the requested WeChat PID on the instance's private bus is inspected.
The separate --scheduled-login action may click a unique visible login button
after an idle schedule starts the client; it never changes device permission.
"""
import ctypes as c
import hashlib
import importlib.util
import json
import pathlib
import re
import signal
import sys
import time

spec = importlib.util.spec_from_file_location(
    'qibox_native_windows', pathlib.Path(__file__).with_name('native-windows.py'))
windows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows)

CHECKED, ENABLED, SENSITIVE, SHOWING, VISIBLE = 4, 8, 24, 25, 30
BAD_STATES = (0, 6, 27, 32)
SKIP = {'list', 'table', 'tree', 'text', 'document web', 'document frame'}

LOGIN_LABELS = {'扫码登录', '扫描二维码登录微信', '使用手机微信扫码登录', '请使用手机微信扫码登录',
                '请在手机上确认登录', '在手机上确认登录', '登录微信', '二维码已失效', '二维码已过期'}
EXPIRED_LABELS = {'登录已失效', '登录已过期', '你已退出微信', '已退出登录', '微信已退出登录',
                  '你的微信已在其他设备上登录', '当前登录已失效，请重新登录'}


def classify_session(controls):
    # Only native non-content controls from this process are passed here.
    active = {(role, name) for role, name, states in controls
              if ENABLED in states and VISIBLE in states and not any(s in states for s in BAD_STATES)}
    shown = {(role, name) for role, name, states in controls
             if SHOWING in states and (role, name) in active}
    labels = {name for role, name in shown if role in {'label', 'push button'}}
    if ('push button', '重新登录') in shown or labels & EXPIRED_LABELS:
        return 'relogin-required'
    if labels & LOGIN_LABELS or any(('push button', name) in shown for name in ('登录', '进入微信')):
        return 'logged-out'
    # Hidden/minimized navigation still identifies the current main window.
    # File/config existence and a running process never establish login.
    if {('push button', '通讯录'), ('push button', '更多')} <= active:
        return 'logged-in'
    return 'unknown'


def account_key(labels):
    # The account row contains nickname followed by the WeChat ID. Never use
    # the nickname, a chat label, or a historic account directory as identity.
    if len(labels) != 2:
        return None
    username = re.sub(r'^微信号[：:]\s*', '', labels[1]).strip()
    if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]{5,63}', username):
        return None
    return hashlib.sha256(('wechat-account\0' + username).encode()).hexdigest()


def classify_control(states, labels, role='combo box'):
    if any(state in states for state in BAD_STATES):
        return 'unknown'
    if not all(state in states for state in (ENABLED, SENSITIVE, SHOWING, VISIBLE)):
        return 'unavailable'
    # Exact current selection, not a dropdown option, hidden label or substring.
    values = [value for value in labels if value]
    if role == 'check box':
        return 'ready' if values == ['自动登录该设备'] and CHECKED in states else 'unavailable'
    return 'ready' if len(values) == 1 and values[0] in {'自动登录', '自动登录该设备'} else 'unavailable'


class Inspector:
    def __init__(self, pid):
        self.api = c.CDLL('libatspi.so.0')
        self.glib = c.CDLL('libglib-2.0.so.0')
        self.glib.g_free.argtypes = [c.c_void_p]
        self.glib.g_error_free.argtypes = [c.c_void_p]
        self.pid = pid
        self.deadline = time.monotonic() + 3.5
        self.calls = 0
        self.cancelled = False
        self.opened = None
        self.menu = None
        self.created_settings = False
        self.app = None
        self.pointer = None
        self.bind('atspi_set_timeout', None, [c.c_int, c.c_int])(400, 400)
        if self.bind('atspi_init', c.c_int, [])() != 0:
            raise RuntimeError('bus unavailable')
        self.desktop = self.bind('atspi_get_desktop', c.c_void_p, [c.c_int])(0)

    def bind(self, name, result, args):
        fn = getattr(self.api, name)
        fn.restype, fn.argtypes = result, args
        return fn

    def check(self):
        self.calls += 1
        if self.cancelled or time.monotonic() > self.deadline or self.calls > 3000:
            raise RuntimeError('inspection interrupted')

    def call(self, method, result, obj, *args):
        self.check()
        error = c.c_void_p()
        fn = self.bind('atspi_accessible_' + method, result,
                       [c.c_void_p] + [c.c_int] * len(args) + [c.POINTER(c.c_void_p)])
        value = fn(obj, *args, c.byref(error))
        if error.value:
            self.glib.g_error_free(error)
            raise RuntimeError('inaccessible control')
        return value

    def string(self, method, obj):
        ptr = self.call(method, c.c_void_p, obj)
        if not ptr:
            return ''
        try:
            return c.string_at(ptr).decode('utf-8', errors='strict')
        finally:
            self.glib.g_free(ptr)

    def children(self, obj):
        count = self.call('get_child_count', c.c_int, obj)
        if not 0 <= count <= 80:
            raise RuntimeError('unexpected control tree')
        return [self.call('get_child_at_index', c.c_void_p, obj, i) for i in range(count)]

    def states(self, obj):
        self.check()
        state = self.bind('atspi_accessible_get_state_set', c.c_void_p, [c.c_void_p])(obj)
        contains = self.bind('atspi_state_set_contains', c.c_int, [c.c_void_p, c.c_int])
        return {i for i in (*BAD_STATES, CHECKED, ENABLED, SENSITIVE, SHOWING, VISIBLE) if contains(state, i)}

    def visible(self, obj):
        states = self.states(obj)
        return all(i in states for i in (ENABLED, SHOWING, VISIBLE)) and not any(i in states for i in BAD_STATES)

    def bounds(self, obj):
        self.check()
        component = self.bind('atspi_accessible_get_component_iface', c.c_void_p, [c.c_void_p])(obj)
        if not component:
            return None
        class Rect(c.Structure):
            _fields_ = [('x', c.c_int), ('y', c.c_int), ('width', c.c_int), ('height', c.c_int)]
        error = c.c_void_p()
        rect = self.bind('atspi_component_get_extents', c.POINTER(Rect),
                         [c.c_void_p, c.c_int, c.POINTER(c.c_void_p)])(component, 0, c.byref(error))
        try:
            if not rect or error.value:
                raise RuntimeError('bounds unavailable')
            value = rect.contents
            return value.x, value.y, value.width, value.height
        finally:
            if error.value:
                self.glib.g_error_free(error)
            if rect:
                self.glib.g_free(rect)

    def walk(self, obj, depth=0, session=False):
        self.check()
        role = self.string('get_role_name', obj)
        if role in SKIP or session and role in {'scroll pane', 'viewport', 'entry', 'password text', 'paragraph', 'combo box'}:
            return
        name = self.string('get_name', obj)
        if session and role == 'frame' and name == '设置':
            return  # A login-method option is not the active login page.
        yield obj, role, name
        if depth < 20:
            for child in self.children(obj):
                yield from self.walk(child, depth + 1, session=session)

    def find(self, root, name, role=None, visible=False):
        for obj, kind, label in self.walk(root):
            if label == name and (role is None or kind == role) and (not visible or self.visible(obj)):
                return obj
        return None

    def refresh(self, obj):
        self.bind('atspi_accessible_clear_cache', None, [c.c_void_p])(obj)

    def press(self, obj):
        if not obj or not self.visible(obj):
            raise RuntimeError('control unavailable')
        # WeChat's custom buttons expose bounds but no AT-SPI actions. Use only
        # the bounds of the already-verified navigation control, never fixed
        # coordinates, a text search across chats, or a login/account action.
        iface = self.bind('atspi_accessible_get_component_iface', c.c_void_p, [c.c_void_p])(obj)
        class Rect(c.Structure):
            _fields_ = [('x', c.c_int), ('y', c.c_int), ('width', c.c_int), ('height', c.c_int)]
        error = c.c_void_p()
        rect = self.bind('atspi_component_get_extents', c.POINTER(Rect), [c.c_void_p, c.c_int, c.POINTER(c.c_void_p)])(iface, 0, c.byref(error))
        if not rect or error.value:
            if error.value:
                self.glib.g_error_free(error)
            raise RuntimeError('navigation unavailable')
        r = rect.contents
        x, y, width, height = r.x, r.y, r.width, r.height
        self.glib.g_free(rect)
        if width <= 0 or height <= 0:
            raise RuntimeError('invalid bounds')
        self.move_pointer(x + width // 2, y + height // 2)
        self.xtest.XTestFakeButtonEvent(self.display, 1, 1, 0)
        self.xtest.XTestFakeButtonEvent(self.display, 1, 0, 0)
        self.xlib.XFlush(self.display)
        time.sleep(.08)

    def move_pointer(self, x, y):
        if self.pointer is None:
            self.xlib, self.xtest = c.CDLL('libX11.so.6'), c.CDLL('libXtst.so.6')
            self.xlib.XOpenDisplay.restype = c.c_void_p
            self.display = self.xlib.XOpenDisplay(None)
            if not self.display:
                raise RuntimeError('display unavailable')
            self.xlib.XDefaultRootWindow.argtypes = [c.c_void_p]
            self.xlib.XDefaultRootWindow.restype = c.c_ulong
            root = self.xlib.XDefaultRootWindow(self.display)
            root_return, child_return = c.c_ulong(), c.c_ulong()
            rx, ry, wx, wy, mask = c.c_int(), c.c_int(), c.c_int(), c.c_int(), c.c_uint()
            self.xlib.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p]
            self.xlib.XQueryPointer(self.display, root, c.byref(root_return), c.byref(child_return), c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask))
            if mask.value & 0x1f00:
                raise RuntimeError('pointer in use')
            self.pointer = (rx.value, ry.value)
            self.xtest.XTestFakeMotionEvent.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_ulong]
            self.xtest.XTestFakeButtonEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
            self.xlib.XFlush.argtypes = [c.c_void_p]
        self.check()
        self.xtest.XTestFakeMotionEvent(self.display, -1, x, y, 0)
        self.xlib.XFlush(self.display)

    def settings(self, app):
        # Qt retains Settings accessibility roots, sometimes even SHOWING,
        # after the real window closes. Only a live X11 window for this PID
        # may provide a setting or prevent us from opening it again.
        if '设置' not in self._mapped_frames():
            return None
        self.refresh(app)
        matches = []
        for obj in self.children(app):
            self.refresh(obj)
            if self.string('get_role_name', obj) == 'frame' and self.string('get_name', obj) == '设置':
                bounds = self.bounds(obj)
                if self.visible(obj) and bounds is not None and bounds[2] > 0 and bounds[3] > 0:
                    matches.append(obj)
        if len(matches) != 1:
            raise RuntimeError('settings window unavailable')
        return matches[0]

    def _mapped_frames(self):
        return windows.mapped_frames(self.pid, self.check)

    def current_account(self, settings):
        logout = self.find(settings, '退出登录', 'push button', True)
        if not logout:
            return None
        row = self.call('get_parent', c.c_void_p, logout)
        candidates = []
        for child in self.children(row):
            if self.string('get_role_name', child) != 'filler':
                continue
            labels = [self.string('get_name', label) for label in self.children(child)
                      if self.string('get_role_name', label) == 'label' and self.visible(label)]
            key = account_key(labels)
            if key:
                candidates.append(key)
        return candidates[0] if len(candidates) == 1 else None

    def inspect(self, navigate=False):
        apps = [x for x in self.children(self.desktop)
                if self.call('get_process_id', c.c_uint, x) == self.pid]
        if len(apps) != 1 or self.string('get_name', apps[0]) != 'wechat':
            return {'status': 'unknown', 'reason': 'wechat-unavailable'}
        app = apps[0]
        self.app = app
        settings = self.settings(app)
        if not settings and navigate:
            # A visible Contacts control identifies the signed-in main screen;
            # it is not itself used as evidence of automatic login.
            if not self.find(app, '通讯录', 'push button', True):
                return {'status': 'unavailable', 'reason': 'login-required'}
            more = self.find(app, '更多', 'push button', True)
            if not more:
                return {'status': 'unknown', 'reason': 'settings-unavailable'}
            self.press(more)
            self.menu = more
            self.refresh(app)
            setting_item = None
            for popup in reversed(self.children(app)):
                if self.string('get_role_name', popup) == 'frame':
                    continue
                setting_item = self.find(popup, '设置', visible=True)
                if setting_item:
                    break
            if not setting_item:
                return {'status': 'unknown', 'reason': 'settings-unavailable'}
            self.created_settings = True
            self.press(setting_item)
            self.menu = None
            settings = self.settings(app)
            self.opened = settings
        if not settings:
            if not self.find(app, '通讯录', 'push button', True):
                return {'status': 'unavailable', 'reason': 'login-required'}
            return {'status': 'unknown', 'reason': 'settings-closed'}
        if self.opened:
            self.press(self.find(settings, '账号与存储', 'push button', True))
            self.refresh(settings)
        elif not self.find(settings, '账号', 'label', True):
            return {'status': 'unknown', 'reason': 'settings-closed'}
        account = self.current_account(settings)
        if not account:
            return {'status': 'unknown', 'reason': 'account-unavailable'}
        controls = [(x, role, name) for x, role, name in self.walk(settings)
                    if ((role == 'combo box' and name == '登录方式') or
                        (role == 'check box' and name == '自动登录该设备')) and self.visible(x)]
        if len(controls) != 1:
            return {'status': 'unknown', 'reason': 'unsupported-controls'}
        control, role, name = controls[0]
        labels = [name] if role == 'check box' else [self.string('get_name', x) for x in self.children(control)
                  if self.string('get_role_name', x) == 'label' and self.visible(x)]
        status = classify_control(self.states(control), labels, role)
        if self.current_account(settings) != account:
            return {'status': 'unknown', 'reason': 'account-changing'}
        return {'status': status, 'reason': 'native-login-method', 'accountKey': account}

    def inspect_session(self, login_page=False, scheduled_login=False):
        apps = [x for x in self.children(self.desktop)
                if self.call('get_process_id', c.c_uint, x) == self.pid]
        if len(apps) != 1 or self.string('get_name', apps[0]) != 'wechat':
            return {'status': 'unknown'}
        self.refresh(apps[0])
        session_names = LOGIN_LABELS | EXPIRED_LABELS | {'通讯录', '更多', '登录', '进入微信', '重新登录'}
        controls = [(role, name, self.states(obj)) for obj, role, name in self.walk(apps[0], session=True)
                    if role in {'push button', 'label'} and name in session_names]
        status = classify_session(controls)
        has_contacts = any(role == 'push button' and name == '通讯录' and ENABLED in states and VISIBLE in states
                           for role, name, states in controls)
        if scheduled_login and status == 'logged-out' and not has_contacts:
            # A scheduled start may press only the current native login button.
            # Never toggle automatic-login permission, confirm on the phone,
            # switch accounts, scan a QR code, or interact with chat content.
            frames = self._mapped_frames()
            buttons = []
            for frame in self.children(apps[0]):
                if (self.string('get_role_name', frame) != 'frame' or
                        self.string('get_name', frame) not in frames or not self.visible(frame)):
                    continue
                buttons.extend(obj for obj, role, name in self.walk(frame)
                               if role == 'push button' and name in {'登录', '进入微信'} and self.visible(obj))
            if len(buttons) == 1:
                self.press(buttons[0])
                return {'status': status, 'clicked': True}
        if login_page and status == 'relogin-required':
            # A native displaced-session notice covers the relogin control.
            # Acknowledge only that exact notice in this process's mapped frame;
            # never dismiss arbitrary chat, security, or account dialogs.
            frames = self._mapped_frames()
            acknowledgements = []
            for frame in self.children(apps[0]):
                if self.string('get_role_name', frame) not in {'frame', 'dialog'} or self.string('get_name', frame) not in frames or not self.visible(frame):
                    continue
                nodes = list(self.walk(frame, session=True))
                notice = any(role == 'label' and re.match(r'^当前账号于.{1,100}在.{1,120}设备上登录[。.]', re.sub(r'\s+', '', name)) and self.visible(obj) for obj, role, name in nodes)
                if notice:
                    acknowledgements.extend(obj for obj, role, name in nodes if role == 'push button' and name == '我知道了' and self.visible(obj))
            if len(acknowledgements) == 1:
                self.press(acknowledgements[0])
                self.refresh(apps[0])
            # The user explicitly requested the login page. Never press logout,
            # switch account, confirm a login, or interact with a chat control.
            button = self.find(apps[0], '重新登录', 'push button', True)
            if button:
                self.press(button)
        return {'status': status}

    def close(self):
        # Never close a Settings window that was already open when we arrived.
        if self.opened or self.menu or self.created_settings:
            self.cancelled = False
            self.deadline = time.monotonic() + .7
            self.calls = 0
            if self.created_settings and not self.opened:
                self.opened = self.settings(self.app)
            if self.opened:
                self.refresh(self.opened)
                self.press(self.find(self.opened, '关闭', 'push button', True))
                self.opened = None
            elif self.menu:
                self.press(self.menu)
                self.menu = None
        if self.pointer:
            self.xtest.XTestFakeMotionEvent(self.display, -1, *self.pointer, 0)
            self.xlib.XFlush(self.display)


def main():
    inspector = None
    result = {'status': 'unknown', 'reason': 'inspection-failed'}
    try:
        inspector = Inspector(int(sys.argv[1]))
        def cancel(_signal, _frame):
            inspector.cancelled = True
        signal.signal(signal.SIGTERM, cancel)
        result = inspector.inspect_session('--login-page' in sys.argv, '--scheduled-login' in sys.argv) if '--session' in sys.argv else inspector.inspect('--navigate' in sys.argv)
    except Exception:
        pass  # Do not log widget text, account identity or credential contents.
    finally:
        if inspector:
            try:
                inspector.close()
            except Exception:
                result = {'status': 'unknown', 'reason': 'cleanup-failed'}
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
