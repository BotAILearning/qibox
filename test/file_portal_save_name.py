import importlib.util
import pathlib
import sys
import unittest

server = pathlib.Path(__file__).resolve().parents[1] / 'server'
sys.path.insert(0, str(server))
spec = importlib.util.spec_from_file_location('portal_save_name', server / 'file-portal.py')
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class SaveNameTest(unittest.TestCase):
    def test_existing_unicode_file_preserves_name_extension_without_parent_path(self):
        name = '资料 中文 😀 #.txt'
        raw = ('/private/account/received/' + name).encode() + b'\0'
        self.assertEqual(portal.save_filename('', raw, 'png'), name)

    def test_explicit_name_takes_priority_and_image_fallback_remains(self):
        self.assertEqual(portal.save_filename('new.pdf', b'/private/old.txt\0', 'png'), 'new.pdf')
        self.assertEqual(portal.save_filename('', b'', 'jpg'), '微信图片.jpg')

    def test_invalid_byte_paths_never_become_suggested_names(self):
        for raw in [b'/private/name.txt', b'/private/bad\0name.txt\0', b'/private/\xff\0', b'../name.txt\0', b'/private/..\0', b'/\0', b'/' + b'x' * 32768 + b'\0']:
            with self.subTest(raw_length=len(raw)):
                self.assertEqual(portal.save_filename('', raw, 'png'), '微信图片.png')
