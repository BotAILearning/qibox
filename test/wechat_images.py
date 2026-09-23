import base64
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('images', pathlib.Path(__file__).parents[1] / 'server/wechat-images.py')
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)

class Images(unittest.TestCase):
    # Independently generated with Node crypto AES-128-ECB, including a raw middle and XOR tail.
    v2 = base64.b64decode('BwhWMggHEAAAAAwAAAAB1a/b/Doq+cfIECkxbXLQkl8KBhPYlKlEBxtWCNuPB/wAAAABAAAAAQgGAAAAHxXEiQAAAAtJREFUeJxjYAACAAAFAAGl9kVAFRUVFVxQW1G7V3WX')
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=')

    def test_v2_current_account_cache_without_reading_or_persisting_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve(); root = home/'xwechat_files/wxid_fixture_abcd';root.mkdir(parents=True)
            cache = home/'.xwechat/net/kvcomm';cache.mkdir(parents=True)
            (cache/'key_123456789_sample.statistic').write_text('not a key; contents must not be read')
            self.assertEqual(images.decode_v2(self.v2, root, lambda:None), ('image/png', self.png))
            self.assertIsNone(images.decode_v2(self.v2, home/'xwechat_files/wxid_other_abcd', lambda:None))
            self.assertIsNone(images.decode_v2(self.v2, home/'another/wxid_fixture_abcd', lambda:None))
            self.assertEqual(len(list(cache.iterdir())), 1)

    def test_v2_rejects_truncation_invalid_lengths_padding_and_missing_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()/'xwechat_files/wxid_fixture_abcd';root.mkdir(parents=True)
            for value in [self.v2, self.v2[:30], self.v2[:6]+b'\xff'*8+self.v2[14:], self.v2[:14]+b'\x02'+self.v2[15:]]:
                self.assertIsNone(images.decode_v2(value, root, lambda:None))
            cache = root.parent.parent/'.xwechat/net/kvcomm';cache.mkdir(parents=True)
            (cache/'key_123456789_sample.statistic').touch()
            bad = bytearray(self.v2);bad[46] ^= 255
            self.assertIsNone(images.decode_v2(bytes(bad), root, lambda:None))

    def test_v2_uses_the_existing_contact_boundary_and_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()/'xwechat_files/wxid_fixture_abcd';root.mkdir(parents=True)
            cache = root.parent.parent/'.xwechat/net/kvcomm';cache.mkdir(parents=True)
            (cache/'key_123456789_sample.statistic').touch()
            folder=root/'msg/attach'/hashlib.md5(b'friend').hexdigest()/'2026-09/Img';folder.mkdir(parents=True)
            ref='b'*32;(folder/(ref+'.dat')).write_bytes(self.v2)
            self.assertEqual(base64.b64decode(images.read_image(root,'friend',ref,0,lambda:None)['data']), self.png)
            self.assertIsNone(images.read_image(root,'someone-else',ref,0,lambda:None))
            def cancel(): raise RuntimeError('cancelled')
            with self.assertRaisesRegex(RuntimeError,'cancelled'): images.read_image(root,'friend',ref,0,cancel)

    def test_only_verified_local_reference(self):
        self.assertEqual(images.image_reference('<msg><img md5="' + 'a'*32 + '"/></msg>'), 'a'*32)
        for value in ['<msg><img md5="../outside"/></msg>', '<!DOCTYPE x><img/>', '<msg>broken']:
            self.assertIsNone(images.image_reference(value))

    def test_renamed_attachment_requires_content_hash_and_message_month(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()/'xwechat_files/wxid_fixture_abcd';root.mkdir(parents=True)
            cache = root.parent.parent/'.xwechat/net/kvcomm';cache.mkdir(parents=True)
            (cache/'key_123456789_sample.statistic').touch()
            folder=root/'msg/attach'/hashlib.md5(b'friend').hexdigest()/'2026-09/Img';folder.mkdir(parents=True)
            (folder/('c'*32+'.dat')).write_bytes(self.v2)
            reference=hashlib.md5(self.png).hexdigest(); timestamp=1790102287
            result=images.read_image(root,'friend',reference,timestamp,lambda:None)
            self.assertEqual(base64.b64decode(result['data']),self.png)
            self.assertIsNone(images.read_image(root,'friend','d'*32,timestamp,lambda:None))
            self.assertIsNone(images.read_image(root,'someone-else',reference,timestamp,lambda:None))
            self.assertIsNone(images.read_image(root,'friend',reference,timestamp-90*86400,lambda:None))

    def test_unencrypted_xor_and_unsupported(self):
        png = b'\x89PNG\r\n\x1a\n' + b'fixturebytes'
        for key in [0, 61, 255]:
            self.assertEqual(images.decode_image(bytes(b^key for b in png)), ('image/png', png))
        self.assertIsNone(images.decode_image(b'unsupported-aes-image'))
        self.assertIsNone(images.decode_image(b'x'*(images.LIMIT+1)))

    def test_account_and_contact_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); ref = 'a'*32; username='friend'
            folder=root/'msg'/'attach'/hashlib.md5(username.encode()).hexdigest()/'2026-09'/'Img';folder.mkdir(parents=True)
            png=b'\x89PNG\r\n\x1a\nfixturebytes';(folder/(ref+'.dat')).write_bytes(png)
            self.assertEqual(base64.b64decode(images.read_image(root,username,ref,0,lambda:None)['data']),png)
            self.assertIsNone(images.read_image(root,'another',ref,0,lambda:None))
            self.assertIsNone(images.read_image(root/'another-account',username,ref,0,lambda:None))

if __name__ == '__main__': unittest.main()
