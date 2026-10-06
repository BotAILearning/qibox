import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('manual_text', pathlib.Path(__file__).resolve().parents[1] / 'server/manual-text.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)


class ManualTextTests(unittest.TestCase):
    def test_caret_and_selected_text_preserve_surrounding_unicode(self):
        self.assertEqual(manual.expected_text('甲😀乙', '中文🙂', 1, 2, 3), '甲中文🙂乙')
        self.assertEqual(manual.expected_text('甲😀乙', '中文🙂', 1, 3, 4), '甲中文🙂乙')
        self.assertEqual(manual.expected_text('甲😀乙', '中', 3, 3, 4), '甲😀中乙')

    def test_invalid_offsets_and_split_surrogates_fail_without_typing(self):
        for args in [('abc', 'X', 2, 1, 3), ('abc', 'X', 0, 3, 4), ('😀', 'X', 1, 1, 2)]:
            with self.assertRaises(ValueError): manual.expected_text(*args)

    def test_paste_normalizes_native_line_endings(self):
        self.assertEqual(manual.expected_text('AB', '中文\r\n😀', 1, 1, 2), 'A中文\n😀B')
