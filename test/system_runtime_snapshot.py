import importlib.util
import pathlib
import tempfile
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'scripts/snapshot-system-runtime.py'
spec = importlib.util.spec_from_file_location('system_snapshot', source)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SystemSnapshotTests(unittest.TestCase):
    def test_image_absolute_symlinks_resolve_inside_image_and_cycles_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'usr/lib').mkdir(parents=True)
            (root / 'usr/lib/component').write_bytes(b'image bytes')
            try:
                (root / 'lib').symlink_to('/usr/lib', target_is_directory=True)
            except OSError as error:
                if getattr(error, 'winerror', None) == 1314:
                    self.skipTest('Windows symlink privilege unavailable; run on Linux')
                raise
            self.assertEqual(snapshot.resolve_image_path(root, 'lib/component').read_bytes(), b'image bytes')
            (root / 'cycle').symlink_to('cycle')
            with self.assertRaisesRegex(ValueError, 'cycle'):
                snapshot.resolve_image_path(root, 'cycle')
            (root / 'escape').symlink_to('../outside')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                snapshot.resolve_image_path(root, 'escape')

    def test_version_text_never_approves_missing_components_or_fallback_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'etc').mkdir()
            (root / 'etc/issue').write_text('fnOS v1.2.0401')
            manifest = {'arch': 'x64', 'identity': 'a' * 64, 'sources': [],
                        'files': {'usr/lib/libexample.so.1': {'sha256': 'b' * 64}}}
            result = snapshot.snapshot(root, manifest, 'isolated fixture')
            self.assertEqual(result['files']['usr/lib/libexample.so.1']['status'], 'missing')
            self.assertFalse(result['minimumSystemVerified'])
            self.assertFalse(result['fallbackRemovalApproved'])


if __name__ == '__main__':
    unittest.main()
