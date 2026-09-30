"""Manual file paste result checks; simulated controls, no messages or UI writes."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('manual_file_controls', pathlib.Path(__file__).resolve().parents[1] / 'server/manual-files.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)


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
