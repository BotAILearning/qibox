"""Owned media-preview safety with simulated native controls; no desktop operations."""
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('native_media', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

class MediaPreview(unittest.TestCase):
    def fixture(self):
        adapter = object.__new__(native.ChatAdapter)
        adapter.controls = ins = Mock()
        adapter.verify_session = Mock()
        adapter.send_pressed = False; adapter.send_confirmed = False; adapter.possibly_written = False
        adapter.editor_text = Mock(return_value='')
        layout = {'app': 1, 'frame': 2, 'header': 4, 'editor': 3, 'send': 21, 'label': '测试'}
        state = {'pasted': False, 'submitted': False}
        ins.locate.return_value = layout
        ins._visible_roots.side_effect = lambda app, frame=None: [] if frame else ([2, 20] if state['pasted'] and not state['submitted'] else [2])
        ins.find.side_effect = lambda root, name, *args: 21 if name == '发送' else 22 if name == '取消' else 23 if name == '发送文件' else None
        ins.press.side_effect = lambda obj: state.update(submitted=True) if obj == 21 else state.update(pasted=True) if obj == 23 else None
        ins.xtest.XTestFakeKeyEvent.side_effect = lambda *args: state.update(pasted=True)
        library = Mock(); library.XKeysymToKeycode.return_value = 44
        media = {'name': 'AI合成-00000000-0000-0000-0000-000000000000.png', 'type': 'image/png'}
        return adapter, layout, media, library, state

    def test_image_submits_only_the_preview_created_by_this_paste_once(self):
        adapter, layout, media, library, state = self.fixture()
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status': 'submitted'})
        self.assertTrue(state['submitted']); self.assertTrue(adapter.send_pressed)
        self.assertEqual(sum(call.args[0] == 21 for call in adapter.controls.press.call_args_list), 1)

    def test_existing_popup_blocks_paste_and_is_never_closed(self):
        adapter, layout, media, library, _ = self.fixture()
        adapter.controls._visible_roots.side_effect = None; adapter.controls._visible_roots.return_value = [99]
        with patch.object(native.c, 'CDLL', return_value=library):
            self.assertEqual(adapter.send_media(media, layout), {'status': 'stale'})
        adapter.controls.press.assert_not_called(); adapter.controls.xtest.XTestFakeKeyEvent.assert_not_called()

    def test_audio_preview_must_show_the_exact_generated_filename_before_send(self):
        adapter, layout, _, library, _ = self.fixture()
        media = {'name': 'AI合成-00000000-0000-0000-0000-000000000000.mp3', 'type': 'audio/mpeg'}
        adapter.controls.tree.return_value = [{'name': 'another.mp3'}]
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'media preview unavailable'): adapter.send_media(media, layout)
        self.assertFalse(adapter.send_pressed)
        self.assertFalse(any(call.args[0] == 21 for call in adapter.controls.press.call_args_list))

    def test_audio_uses_the_official_file_button_without_clipboard_and_checks_filename(self):
        adapter, layout, _, library, state = self.fixture()
        media = {'name':'AI合成-00000000-0000-0000-0000-000000000000.mp3','type':'audio/mpeg'}
        adapter.controls.tree.return_value = [{'name':media['name']}]
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status':'submitted'})
        adapter.controls.xtest.XTestFakeKeyEvent.assert_not_called()
        self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [23,21])

    def test_unknown_post_click_result_never_repeats_send_or_cancels_the_preview(self):
        adapter, layout, media, library, state = self.fixture()
        adapter.controls._visible_roots.side_effect = lambda app, frame=None: [] if frame else ([2, 20] if state['pasted'] else [2])
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status': 'uncertain'})
        self.assertEqual(sum(call.args[0] == 21 for call in adapter.controls.press.call_args_list), 1)
        adapter.controls._cleanup_budget.side_effect = lambda callback, **kwargs: callback()
        self.assertEqual(adapter.cleanup_media(), 'blocked')
        self.assertFalse(any(call.args[0] == 22 for call in adapter.controls.press.call_args_list))

    def inline_fixture(self):
        adapter, layout, media, library, state = self.fixture()
        adapter.controls._visible_roots.side_effect = lambda app, frame=None: [] if frame else [2]
        adapter.editor_text.side_effect = lambda obj: '\ufffc' if state['pasted'] and not state['submitted'] else ''
        adapter.send_pane_clear = Mock(return_value=True)
        return adapter, layout, media, library, state

    def test_inline_image_submits_one_owned_object_once_without_a_popup(self):
        adapter, layout, media, library, state = self.inline_fixture()
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status':'submitted'})
        self.assertTrue(state['submitted'])
        self.assertEqual(sum(call.args[0] == 21 for call in adapter.controls.press.call_args_list), 1)

    def test_inline_audio_submits_one_owned_file_without_clipboard_or_a_popup(self):
        adapter, layout, _, library, state = self.inline_fixture()
        media = {'name':'AI-generated-00000000-0000-0000-0000-000000000000.mp3','type':'audio/mpeg'}
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status':'submitted'})
        self.assertTrue(state['submitted']); self.assertTrue(adapter.send_confirmed)
        adapter.controls.xtest.XTestFakeKeyEvent.assert_not_called()
        self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [23,21])

    def test_inline_audio_never_submits_when_owned_editor_changes(self):
        for change in ['target', 'sidebar', 'manual-text']:
            adapter, layout, _, library, state = self.inline_fixture()
            media = {'name':'AI-generated-00000000-0000-0000-0000-000000000000.mp3','type':'audio/mpeg'}
            if change == 'target': adapter.controls.locate.return_value = {**layout,'label':'另一对象'}
            elif change == 'sidebar': adapter.send_pane_clear.return_value = False
            else: adapter.editor_text.side_effect = lambda obj: '用户自己的草稿' if state['pasted'] else ''
            with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
                if change == 'manual-text':
                    with self.assertRaisesRegex(ValueError,'media preview unavailable'): adapter.send_media(media,layout)
                else: self.assertEqual(adapter.send_media(media,layout),{'status':'uncertain'})
            self.assertFalse(adapter.send_pressed)

    def test_inline_image_does_not_send_after_target_change_or_sidebar_obstruction(self):
        for change in ['target', 'sidebar']:
            adapter, layout, media, library, _ = self.inline_fixture()
            if change == 'target': adapter.controls.locate.return_value = {**layout, 'label':'另一对象'}
            else: adapter.send_pane_clear.return_value = False
            with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
                self.assertEqual(adapter.send_media(media, layout), {'status':'uncertain'})
            self.assertFalse(adapter.send_pressed)

    def test_inline_cleanup_never_changes_another_draft_or_repeats_unknown_send(self):
        for current, pressed, expected in [('\ufffc',False,'cleared'), ('新的用户草稿',False,'blocked'), ('\ufffc',True,'blocked'), ('',True,'not-needed')]:
            adapter, layout, media, _, _ = self.inline_fixture()
            adapter.owned_media = {'app':1,'frame':2,'label':'测试','media':media,'inline':{key:layout[key] for key in ['app','frame','header','editor','label']}}
            adapter.send_pressed = pressed; draft = [current]
            adapter.editor_text.side_effect = lambda obj: draft[0]
            adapter.write_text = Mock(side_effect=lambda obj,text: draft.__setitem__(0,text))
            adapter.controls.string.return_value = '测试'
            adapter.controls._cleanup_budget.side_effect = lambda callback, **kwargs: callback()
            self.assertEqual(adapter.cleanup_media(),expected)
            self.assertEqual(adapter.write_text.call_count, int(expected=='cleared'))

    def test_cleanup_uses_the_controls_supported_emergency_budget(self):
        adapter, layout, media, _, _ = self.fixture()
        adapter.owned_media = {'app':1,'frame':2,'label':'测试','media':media}
        def budget(callback, *, seconds):
            self.assertLessEqual(seconds, 1.5)
            callback()
        adapter.controls._cleanup_budget.side_effect = budget
        self.assertEqual(adapter.cleanup_media(), 'blocked')

    def test_cleanup_failure_keeps_the_original_fixed_media_diagnostic(self):
        adapter = Mock(possibly_written=True, send_pressed=False, phase='native-prepare')
        adapter.controls.cancelled = False
        adapter.execute.side_effect = ValueError('media preview unavailable')
        adapter.close.side_effect = ValueError('invalid cleanup limit')
        request = Mock(buffer=io.BytesIO(b'{"action":"send"}'))
        with patch.object(native, 'ChatAdapter', return_value=adapter), patch.object(native.sys, 'argv', ['native', '123']), patch.object(native.sys, 'stdin', request), patch.object(native.signal, 'signal'), patch('builtins.print') as output:
            native.main()
        result = json.loads(output.call_args.args[0])
        self.assertEqual(result['status'], 'uncertain')
        self.assertFalse(result['sendPressed'])
        self.assertEqual(result['draftCleanup'], 'blocked')
        self.assertEqual(result['diagnostic'], {'phase':'native-prepare','code':'controls-unavailable','reason':'media-preview-unavailable'})

if __name__ == '__main__': unittest.main()
