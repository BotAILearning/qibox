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
    def test_only_verified_local_reference(self):
        self.assertEqual(images.image_reference('<msg><img md5="' + 'a'*32 + '"/></msg>'), 'a'*32)
        for value in ['<msg><img md5="../outside"/></msg>', '<!DOCTYPE x><img/>', '<msg>broken']:
            self.assertIsNone(images.image_reference(value))

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
