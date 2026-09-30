"""Owned media-preview safety with simulated native controls; no desktop operations."""
import importlib.util
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
        layout = {'app': 1, 'frame': 2, 'editor': 3, 'label': '测试'}
        state = {'pasted': False, 'submitted': False}
        ins.locate.return_value = layout
        ins._visible_roots.side_effect = lambda app, frame=None: [] if frame else ([2, 20] if state['pasted'] and not state['submitted'] else [2])
        ins.find.side_effect = lambda root, name, *args: 21 if name == '发送' else 22 if name == '取消' else None
        ins.press.side_effect = lambda obj: state.update(submitted=True) if obj == 21 else None
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

    def test_unknown_post_click_result_never_repeats_send_or_cancels_the_preview(self):
        adapter, layout, media, library, state = self.fixture()
        adapter.controls._visible_roots.side_effect = lambda app, frame=None: [] if frame else ([2, 20] if state['pasted'] else [2])
        with patch.object(native.c, 'CDLL', return_value=library), patch.object(native.time, 'sleep'):
            self.assertEqual(adapter.send_media(media, layout), {'status': 'uncertain'})
        self.assertEqual(sum(call.args[0] == 21 for call in adapter.controls.press.call_args_list), 1)
        adapter.controls._cleanup_budget.side_effect = lambda callback, **kwargs: callback()
        self.assertEqual(adapter.cleanup_media(), 'blocked')
        self.assertFalse(any(call.args[0] == 22 for call in adapter.controls.press.call_args_list))

if __name__ == '__main__': unittest.main()
