"""Manual file paste result checks; simulated controls, no messages or UI writes."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('manual_file_controls', pathlib.Path(__file__).resolve().parents[1] / 'server/manual-files.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)


class FocusedChat(unittest.TestCase):
    def nodes(self, title='Bot', focused=True, start=10):
        shown = {manual.controls.base.VISIBLE, manual.controls.base.SHOWING}
        def node(obj, parent, role, name, bounds, states=()):
            return {'obj': start + obj, 'parent': 1 if parent == -1 else start + parent,
                    'role': role, 'name': name, 'bounds': bounds, 'states': shown | set(states),
                    'interfaces': {'editable_text': True} if role == 'text' else {}}
        return [node(0, -1, 'frame', title, (0, 0, 800, 600)),
                node(1, 0, 'filler', '', (0, 0, 800, 50)),
                node(2, 1, 'label', 'Bot', (10, 10, 80, 25), {11}),
                node(3, 1, 'push button', '聊天信息', (700, 10, 30, 25)),
                node(4, 0, 'list', '消息', (0, 50, 800, 330)),
                node(5, 0, 'text', '', (0, 400, 800, 100), {17, 12} if focused else {17}),
                node(6, 0, 'push button', '发送文件', (30, 530, 30, 25)),
                node(7, 0, 'push button', '发送', (720, 530, 50, 25))]

    def test_main_and_detached_chat_use_only_the_focused_editor(self):
        nodes = self.nodes('微信', False) + self.nodes('Bot', True, 100)
        layout, frames = manual.chat_nodes(nodes, 1)
        self.assertEqual(layout['frame'], 100)
        self.assertEqual(layout['title'], 'Bot')
        self.assertEqual(frames, {10, 100})
        with self.assertRaisesRegex(ValueError, 'focused chat'):
            manual.chat_nodes(self.nodes(focused=False), 1)

    def test_ambiguous_focus_and_search_fields_are_rejected(self):
        with self.assertRaises(ValueError):
            manual.chat_nodes(self.nodes() + self.nodes(start=100), 1)
        nodes = self.nodes()
        nodes[5]['states'].discard(17)
        with self.assertRaises(ValueError):
            manual.chat_nodes(nodes, 1)
        nodes = self.nodes()
        nodes[0]['parent'] = 2
        with self.assertRaises(ValueError):
            manual.chat_nodes(nodes, 1)

    def test_preview_stays_in_the_original_frame_after_focus_changes(self):
        nodes = self.nodes(focused=False) + self.nodes(start=100)
        layout, _ = manual.chat_nodes(nodes, 1, expected_frame=10)
        self.assertEqual(layout['frame'], 10)
        with self.assertRaises(ValueError):
            manual.chat_nodes(nodes, 1, expected_frame=999)

    def test_only_verified_chat_frames_are_ignored_as_background_windows(self):
        ins = manual.ManualControls.__new__(manual.ManualControls)
        ins._manual_frames = {10, 100}
        with patch.object(manual.controls.NativeControls, '_visible_roots', return_value=[10, 100, 900]):
            self.assertEqual(ins._visible_roots(1, 100), [900])


class FilePreview(unittest.TestCase):
    def fixture(self):
        layout = {'app': 1, 'frame': 2, 'header': 3, 'editor': 4, 'label': 'fixture'}
        ins = Mock()
        ins.locate.return_value = layout
        ins._visible_roots.return_value = []
        return ins, layout

    def test_ignored_file_or_partial_batch_never_reports_ready(self):
        for text in ['', '\ufffc']:
            ins, layout = self.fixture()
            with patch.object(manual, 'editor_text', return_value=text), patch.object(manual.time, 'sleep'):
                with self.assertRaisesRegex(ValueError, 'preview unavailable'):
                    manual.wait_for_files(ins, layout, '', ['资料.txt', 'another.txt'])
            ins.press.assert_not_called()

    def test_complete_inline_batch_retains_existing_text_and_attachment(self):
        ins, layout = self.fixture()
        with patch.object(manual, 'editor_text', return_value='用户草稿\ufffc\ufffc\ufffc'), patch.object(manual.time, 'sleep'):
            self.assertTrue(manual.wait_for_files(ins, layout, '用户草稿\ufffc', ['资料.txt', 'another.txt']))
        self.assertEqual(ins.locate.call_count, 2)
        ins.press.assert_not_called()

    def test_a_changed_draft_or_chat_does_not_acknowledge_the_files(self):
        ins, layout = self.fixture()
        with patch.object(manual, 'editor_text', return_value='另一份草稿\ufffc'), patch.object(manual.time, 'sleep'):
            with self.assertRaises(ValueError):
                manual.wait_for_files(ins, layout, '用户草稿', ['资料.txt'])
        ins.locate.return_value = {**layout, 'label': 'changed'}
        with patch.object(manual.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'chat changed'):
                manual.wait_for_files(ins, layout, '', ['资料.txt'])
        ins.press.assert_not_called()

    def test_the_preview_popup_requires_all_requested_names(self):
        ins, layout = self.fixture()
        ins._visible_roots.return_value = [9]
        ins.tree.return_value = [{'name': 'another.txt'}]
        with patch.object(manual.time, 'sleep'):
            with self.assertRaises(ValueError):
                manual.wait_for_files(ins, layout, '', ['资料.txt'])
        ins.tree.return_value = [{'name': '资料.txt'}, {'name': 'another.txt'}]
        with patch.object(manual.time, 'sleep'):
            self.assertTrue(manual.wait_for_files(ins, layout, '', ['资料.txt', 'another.txt']))
        ins.press.assert_not_called()


if __name__ == '__main__':
    unittest.main()
