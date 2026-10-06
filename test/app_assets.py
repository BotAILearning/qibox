import hashlib
import importlib.util
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('app_assets', pathlib.Path(__file__).resolve().parents[1] / 'scripts/prepare-app-assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class AppAssetsTests(unittest.TestCase):
    def test_font_and_module_bytes_modes_and_names_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'config').mkdir()
            data = {'fonts/fixture.otf': b'FONT_BYTES\x00\xff', 'node_modules/fixture/index.mjs': b'export default 1;'}
            for name, value in data.items():
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(value)
            proof = assets.prepare(root)
            self.assertEqual(set(proof['files']), set(data))
            with tarfile.open(root / 'assets' / proof['file']) as archive:
                for name, value in data.items():
                    self.assertEqual(archive.extractfile(name).read(), value)
                    self.assertEqual(archive.getmember(name).mode, 0o644)
                    self.assertEqual(proof['files'][name]['sha256'], hashlib.sha256(value).hexdigest())
                self.assertTrue(all(m.isdir() and m.mode == 0o755 or m.isfile() and m.mode == 0o644 for m in archive))

    def test_missing_dependencies_fail_without_publishing_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'config').mkdir()
            (root / 'fonts').mkdir()
            (root / 'fonts/fixture.otf').write_bytes(b'FONT')
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                assets.prepare(root)
            self.assertFalse((root / 'config/app-assets.json').exists())
