import importlib.util
import pathlib
import sys
import unittest

server = pathlib.Path(__file__).resolve().parents[1] / 'server'
sys.path.insert(0, str(server))
spec = importlib.util.spec_from_file_location('close_controls', server / 'auto-login.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def node(role, name='', rect=(0, 0, 1280, 800), children=(), pid=100, visible=True):
    return dict(role=role, name=name, rect=rect, children=list(children), pid=pid, visible=visible)

class Probe:
    pid = 100
    def __init__(self, close=None):
        self.button = close or node('push button', '关闭', (1235, 1, 44, 32))
        self.toolbar = node('tool bar', rect=(1095, 1, 184, 32), children=[self.button])
        self.frame = node('frame', '微信', children=[node('filler',children=[node('layered pane',children=[node('push button','关闭', (900,600,44,32))]),self.toolbar])])
        self.app = node('application','wechat',children=[self.frame])
        self.desktop = node('desktop',children=[self.app])
    def _mapped_frames(self): return {'微信': 11}
    def active_main_window(self): return True
    def children(self, obj): return obj['children']
    def call(self, method, result, obj): return obj['pid']
    def string(self, method, obj): return obj['role' if method == 'get_role_name' else 'name']
    def visible(self, obj): return obj['visible']
    def bounds(self, obj): return obj['rect']

class WindowControls(unittest.TestCase):
    def test_only_owned_main_header_button_is_returned_without_chat_traversal(self):
        p=Probe()
        self.assertEqual(module.Inspector.window_controls(p), {'close': (1235,1,44,32)})
        p.app['pid']=200
        self.assertIsNone(module.Inspector.window_controls(p))
    def test_detached_hidden_or_ambiguous_controls_are_rejected(self):
        for modify in [lambda p:p.frame.update(name='聊天'),lambda p:p.button.update(visible=False),lambda p:p.toolbar['children'].append(p.button.copy()),lambda p:p.button.update(rect=(1235,600,44,32))]:
            p=Probe();modify(p)
            self.assertIsNone(module.Inspector.window_controls(p))
    def test_native_modal_or_another_foreground_window_is_not_intercepted(self):
        p=Probe();p.active_main_window=lambda:False
        self.assertIsNone(module.Inspector.window_controls(p))
