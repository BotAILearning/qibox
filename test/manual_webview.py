"""Moments/article clicks remain available without releasing the chat guard."""
import ctypes as c
import io
import importlib.util
import pathlib
import types
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch

root = pathlib.Path(__file__).resolve().parents[1]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, root / 'server' / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
webview = load('manual_webview_test', 'manual-webview.py')
windows = load('manual_windows_test', 'native-windows.py')
native = load('manual_adapter_test', 'ai-native.py')

class Fn:
    def __init__(self, fn): self.fn = fn
    def __call__(self, *args): return self.fn(*args)

class FakeX:
    def __init__(self):
        self.owner, self.active, self.hit = 43, 10, 20
        self.map_state, self.inside, self.errors = 2, True, []
        self.XDefaultRootWindow = lambda display: 1
        self.XInternAtom = lambda display, name, existing: {b'_NET_ACTIVE_WINDOW':100,b'_NET_WM_PID':101,b'WINDOW':33,b'CARDINAL':6,b'WM_CLASS':102,b'STRING':31}[name]
        self.XGetWindowAttributes = self.attrs
        self.XTranslateCoordinates = Fn(self.translate)
        self.XQueryTree = Fn(self.tree)
        self.XFree = Mock()
    def attrs(self, display, window, out):
        value=c.cast(out,c.POINTER(windows.XWindowAttributes)).contents
        value.map_state=self.map_state; value.width=1280; value.height=800; return 1
    def translate(self, display, source, target, px, py, lx, ly, hit):
        c.cast(lx,c.POINTER(c.c_int))[0]=px if self.inside else 1300
        c.cast(ly,c.POINTER(c.c_int))[0]=py
        c.cast(hit,c.POINTER(c.c_ulong))[0]=self.hit
        return 1
    def tree(self, display, frame, rr, parent, children, count):
        c.cast(parent,c.POINTER(c.c_ulong))[0]=20 if frame==10 else 1; return 1
    def prop(self, x, display, window, atom, expected):
        if atom==100:return self.active
        if window==10:return self.owner
        return 99

class ArticleInput(unittest.TestCase):
    def run_probe(self, fake, identity=(43,'exe',('main-start','child-start')), event=None):
        @contextmanager
        def connection():yield fake, 1000, fake.errors
        with patch.object(windows,'x11_connection',connection), patch.object(windows,'x11_property32',fake.prop), patch.object(webview,'webview_identity',return_value=identity):
            return webview.manual_webview_pointer(42,event or {'type':'pointer','x':1154,'y':20},windows,lambda:None)
    def test_article_click_is_safe_but_draft_is_not_resolved(self):
        self.assertTrue(self.run_probe(FakeX()))
        adapter=object.__new__(native.ChatAdapter);adapter.controls=Mock();adapter.controls.pid=42
        helper=types.SimpleNamespace(manual_webview_pointer=Mock(return_value=True))
        with patch.object(native,'module',return_value=helper):
            self.assertEqual(adapter.execute({'action':'input-status','event':{'type':'pointer','x':1154,'y':20}}),{'safe':True,'resolved':False})
        adapter.controls.require_foreground.assert_not_called();adapter.controls.locate.assert_not_called();adapter.controls.press.assert_not_called()
    def test_unknown_process_overlay_outside_and_unmapped_are_not_safe(self):
        self.assertFalse(self.run_probe(FakeX(),identity=None))
        for mutation in ('hit','inside','map_state','errors'):
            fake=FakeX();setattr(fake,mutation,{'hit':30,'inside':False,'map_state':0,'errors':[True]}[mutation])
            with self.subTest(mutation=mutation):self.assertFalse(self.run_probe(fake))
    def test_same_process_moments_click_requires_exact_title_and_class(self):
        fake=FakeX();fake.owner=42
        with patch.object(windows,'x11_window_title',return_value='朋友圈'),patch.object(windows,'x11_property_array',return_value=b'wechat\0wechat\0'):
            self.assertTrue(self.run_probe(fake,identity=None))
            for title in ('微信','设置','朋友圈 - other'):
                with patch.object(windows,'x11_window_title',return_value=title):
                    self.assertFalse(self.run_probe(fake))
            with patch.object(windows,'x11_property_array',return_value=b'other\0other\0'):
                self.assertFalse(self.run_probe(fake))
    def test_moments_cannot_bypass_keyboard_or_topmost_hit_checks(self):
        fake=FakeX();fake.owner=42
        with patch.object(windows,'x11_window_title',return_value='朋友圈'),patch.object(windows,'x11_property_array',return_value=b'wechat\0wechat\0'):
            self.assertFalse(self.run_probe(fake,event={'type':'key','submitKey':True}))
            fake.hit=30;self.assertFalse(self.run_probe(fake))
            fake.hit=20;fake.inside=False;self.assertFalse(self.run_probe(fake))
    def test_moments_title_change_during_check_fails_closed(self):
        fake=FakeX();fake.owner=42
        with patch.object(windows,'x11_window_title',side_effect=['朋友圈','微信']),patch.object(windows,'x11_property_array',return_value=b'wechat\0wechat\0'):
            self.assertFalse(self.run_probe(fake))
    def test_enter_and_invalid_coordinates_cannot_bypass_guard(self):
        for event in ({'type':'key','submitKey':True},{'type':'pointer','x':True,'y':20},{'type':'pointer','x':-1,'y':20}):
            self.assertFalse(self.run_probe(FakeX(),event=event))
    def test_changed_window_process_and_owner_fail_closed(self):
        fake=FakeX()
        @contextmanager
        def connection():yield fake,1000,[]
        for mutation in ('window','process','owner'):
            values=iter([10,11] if mutation=='window' else [10,10]);owners=iter([43,44] if mutation=='owner' else [43,43])
            def prop(x,display,window,atom,expected):return next(values) if atom==100 else next(owners)
            identities=[('first',),('changed',)] if mutation=='process' else [('first',),('first',)]
            with self.subTest(mutation=mutation),patch.object(windows,'x11_connection',connection),patch.object(windows,'x11_property32',prop),patch.object(webview,'webview_identity',side_effect=identities):
                self.assertFalse(webview.manual_webview_pointer(42,{'type':'pointer','x':1154,'y':20},windows,lambda:None))
    def test_process_identity_requires_direct_owned_official_child(self):
        proc=pathlib.Path('/fake-proc');main=proc/'42';child=proc/'43'
        main_exe=pathlib.Path('/private/opt/wechat/wechat');child_exe=main_exe.parent/'RadiumWMPF/runtime/WeChatAppEx'
        text={child/'status':'PPid:\t42\n',child/'comm':'WeChatAppEx\n',main/'stat':'42 (wechat) '+' '.join(['0']*19+['123']),child/'stat':'43 (WeChatAppEx) '+' '.join(['0']*19+['456'])}
        commands={main/'cmdline':str(main_exe).encode()+b'\0',child/'cmdline':str(child_exe).encode()+b'\0private-argument'}
        paths={main_exe:main_exe,child_exe:child_exe,pathlib.Path('/other/WeChatAppEx'):pathlib.Path('/other/WeChatAppEx')}
        def resolve(path,strict=False):return paths[path]
        def stat(path):return types.SimpleNamespace(st_uid=100 if path==main else child_uid)
        child_uid=100
        with patch.object(pathlib.Path,'read_text',lambda path,*a,**k:text[path]),patch.object(pathlib.Path,'open',lambda path,*a,**k:io.BytesIO(commands[path])),patch.object(pathlib.Path,'is_absolute',return_value=True),patch.object(pathlib.Path,'resolve',resolve),patch.object(pathlib.Path,'stat',stat):
            self.assertIsNotNone(webview.webview_identity(42,43,proc))
            commands[child/'cmdline']=str(child_exe).encode()+b' --lang=zh-CN --private-option\0'
            self.assertIsNotNone(webview.webview_identity(42,43,proc))
            text[child/'status']='PPid:\t99\n';self.assertIsNone(webview.webview_identity(42,43,proc))
            text[child/'status']='PPid:\t42\n';child_uid=101;self.assertIsNone(webview.webview_identity(42,43,proc))
            child_uid=100;commands[child/'cmdline']=b'/other/WeChatAppEx\0';self.assertIsNone(webview.webview_identity(42,43,proc))

if __name__=='__main__':unittest.main()
