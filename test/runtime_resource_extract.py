import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'server/extract-runtime-resources.py'
spec = importlib.util.spec_from_file_location('resource_extract', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ResourceExtraction(unittest.TestCase):
    def test_partial_repair_preserves_verified_existing_file_and_extracts_only_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root = base / 'root'
            root.mkdir()
            (root / 'kept').write_bytes(b'correct existing bytes')
            before = (root / 'kept').stat().st_ino
            rows = {'kept': b'correct existing bytes', 'missing': b'missing helper'}
            inventory = {name: ['0', 0o644, 0, 0, '', len(raw), hashlib.sha256(raw).hexdigest()] for name, raw in rows.items()}
            manifest = {'inventory': inventory, 'files': {name: {'sha256': row[6]} for name, row in inventory.items()}}
            archive = base / 'partial.tar.xz'
            with tarfile.open(archive, 'w:xz') as tar:
                for name, raw in rows.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(raw)
                    tar.addfile(member, io.BytesIO(raw))
            resource = {'path': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
            result = module.extract(root, manifest, [resource], existing_files=['kept'])
            self.assertEqual(result['extractedMembers'], 1)
            self.assertEqual((root / 'kept').stat().st_ino, before)
            self.assertEqual((root / 'missing').read_bytes(), rows['missing'])
            (root / 'kept').write_bytes(b'changed existing bytes')
            with self.assertRaisesRegex(ValueError, 'Existing resource hash differs'):
                module.extract(root, manifest, [resource], existing_files=['kept'])

    def test_batch_preserves_private_hardlinks_and_rejects_corrupt_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            archive = base / 'payload.tar.xz'
            raw = b'known private contents'
            file = tarfile.TarInfo('lib/original')
            file.size, file.mode = len(raw), 0o755
            link = tarfile.TarInfo('lib/alias')
            link.type, link.linkname = tarfile.LNKTYPE, 'lib/original'
            inventory = {'lib/original': ['0', 0o755, 0, 0, '', len(raw), hashlib.sha256(raw).hexdigest()],
                         'lib/alias': ['1', 0o644, 0, 0, 'lib/original', 0, None]}
            with tarfile.open(archive, 'w:xz') as tar:
                tar.addfile(file, io.BytesIO(raw))
                tar.addfile(link)
            root = base / 'root'
            root.mkdir()
            resource = {'path': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
            module.extract(root, {'inventory': inventory}, [resource])
            self.assertEqual((root / 'lib/original').read_bytes(), raw)
            self.assertEqual((root / 'lib/original').stat().st_ino, (root / 'lib/alias').stat().st_ino)
            with self.assertRaisesRegex(ValueError, 'hash changed'):
                module.extract(root, {'inventory': inventory}, [{**resource, 'sha256': '0' * 64}])

    def test_archive_cannot_write_through_an_existing_symlink_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root = base / 'root'
            root.mkdir()
            outside = base / 'outside'
            outside.mkdir()
            try:
                (root / 'dir').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('Host requires symlink privilege; Linux acceptance runs this test')
            archive = base / 'payload.tar.xz'
            member = tarfile.TarInfo('dir/file')
            member.size = 4
            with tarfile.open(archive, 'w:xz') as tar:
                tar.addfile(member, io.BytesIO(b'data'))
            resource = {'path': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
            inventory = {'dir/file': ['0', 0o644, 0, 0, '', 4, hashlib.sha256(b'data').hexdigest()]}
            with self.assertRaisesRegex(ValueError, 'Symlink parent'):
                module.extract(root, {'inventory': inventory}, [resource])
            self.assertFalse((outside / 'file').exists())


if __name__ == '__main__':
    unittest.main()
