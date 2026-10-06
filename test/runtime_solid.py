import hashlib
import importlib.util
import io
import lzma
import pathlib
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

scripts = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location('runtime_solid', scripts / 'prepare-runtime-solid.py')
solid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(solid)
sys.path.pop(0)


class SolidRuntimeTests(unittest.TestCase):
    def test_arm_context_profile_preserves_bytes_and_changes_cache_fingerprint(self):
        data = bytes(range(256)) * 32
        options = solid.compression_options('arm64', 9 | lzma.PRESET_EXTREME)
        self.assertEqual(len(options['filters']), 1)
        self.assertEqual(options['filters'][0]['id'], lzma.FILTER_LZMA2)
        encoded = lzma.compress(data, check=lzma.CHECK_SHA256, **options)
        self.assertEqual(lzma.decompress(encoded), data)
        self.assertEqual(solid.compression_name('arm64', 9 | lzma.PRESET_EXTREME), 'lzma2-9e-lc2-lp2-pb2')
        with patch.object(solid, 'compression_name', return_value='old'):
            old = solid.runtime_fingerprint({}, {}, 9 | lzma.PRESET_EXTREME)
        self.assertNotEqual(old, solid.runtime_fingerprint({}, {}, 9 | lzma.PRESET_EXTREME))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.previous = solid.ROOT, solid.OUT
        solid.ROOT, solid.OUT = self.root, self.root / 'output'
        (solid.OUT / 'shared').mkdir(parents=True)
        self.spool = self.root / 'spool'
        self.spool.mkdir()
        (self.root / '.cache/runtime').mkdir(parents=True)

    def tearDown(self):
        solid.ROOT, solid.OUT = self.previous
        self.temp.cleanup()

    def package(self, name, entries):
        target = self.root / '.cache/runtime' / (name + '.tar.xz')
        with tarfile.open(target, 'w:xz') as archive:
            for path, data, kind, link in entries:
                member = tarfile.TarInfo(path)
                member.mode = 0o751
                member.type = kind
                member.linkname = link
                member.size = len(data) if kind == tarfile.REGTYPE else 0
                archive.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        return {'name': name, 'file': target.name, 'sha256': solid.digest(target)}

    def test_all_runtime_bytes_modes_links_and_licenses_survive(self):
        package = self.package('fixture', [
            ('./usr/bin/tool', b'RUNTIME_BYTES', tarfile.REGTYPE, ''),
            ('./usr/bin/link', b'', tarfile.LNKTYPE, './usr/bin/tool'),
            ('./usr/bin/symbol', b'', tarfile.SYMTYPE, 'tool'),
            ('./usr/share/doc/fixture/copyright', b'LICENSE', tarfile.REGTYPE, ''),
            ('./usr/share/doc/fixture/README', b'USAGE', tarfile.REGTYPE, ''),
            ('./usr/share/doc/fixture/NEWS.gz', b'OLD_NEWS', tarfile.REGTYPE, ''),
            ('./usr/share/man/fixture.1', b'MANUAL', tarfile.REGTYPE, ''),
        ])
        tree = solid.inventory('x64', {'packages': [package]}, self.spool)
        self.assertNotIn('usr/share/man/fixture.1', tree)
        self.assertNotIn('usr/share/doc/fixture/NEWS.gz', tree)
        proof = solid.archive_tree('test', tree, self.spool, 1)
        with tarfile.open(solid.OUT / 'shared' / proof['file']) as archive:
            self.assertEqual(archive.extractfile('usr/bin/tool').read(), b'RUNTIME_BYTES')
            self.assertEqual(archive.extractfile('usr/bin/link').read(), b'RUNTIME_BYTES')
            self.assertEqual(archive.getmember('usr/bin/tool').mode, 0o751)
            self.assertEqual(archive.getmember('usr/bin/symbol').linkname, 'tool')
            self.assertEqual(archive.extractfile('usr/share/doc/fixture/copyright').read(), b'LICENSE')

    def test_overlay_that_would_change_a_hard_link_is_rejected(self):
        first = self.package('first', [('usr/lib/target', b'OLD', tarfile.REGTYPE, ''),
                                       ('usr/lib/link', b'', tarfile.LNKTYPE, 'usr/lib/target')])
        second = self.package('second', [('usr/lib/target', b'NEW', tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(ValueError, 'Hard-link content would change'):
            solid.inventory('x64', {'packages': [first, second]}, self.spool)

    def test_changed_source_and_unsafe_member_fail_before_archiving(self):
        package = self.package('unsafe', [('../escape', b'BAD', tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(ValueError, 'Unsafe runtime path'):
            solid.inventory('x64', {'packages': [package]}, self.spool)
        package['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            solid.inventory('x64', {'packages': [package]}, self.spool)

    def test_policy_rejects_changed_sources_and_retained_links(self):
        package = self.package('optional', [('usr/lib/optional', b'GUI', tarfile.REGTYPE, ''),
                                             ('usr/lib/link', b'', tarfile.SYMTYPE, 'optional')])
        tree = solid.inventory('x64', {'packages': [package]}, self.spool)
        policy = {'x64': {'excluded': {'usr/lib/optional': solid.signature(*tree['usr/lib/optional'])}}}
        with self.assertRaisesRegex(ValueError, 'Retained runtime link'):
            solid.apply_policy('x64', tree, self.spool, policy)
        policy['x64']['excluded']['usr/lib/optional'][-1] = 'changed'
        with self.assertRaisesRegex(ValueError, 'policy source changed'):
            solid.apply_policy('x64', tree, self.spool, policy)

    def test_policy_refuses_libraries_with_retained_consumers(self):
        package = self.package('optional', [('usr/lib/optional', b'LIBRARY', tarfile.REGTYPE, ''),
                                             ('usr/bin/application', b'APPLICATION', tarfile.REGTYPE, '')])
        tree = solid.inventory('x64', {'packages': [package]}, self.spool)
        policy = {'x64': {'excluded': {'usr/lib/optional': solid.signature(*tree['usr/lib/optional'])}}}
        with patch.object(solid.elf, 'elf_dynamic', side_effect=lambda data: {'soname': 'optional.so', 'needed': []} if data == b'LIBRARY' else {'soname': None, 'needed': ['optional.so']}):
            with self.assertRaisesRegex(ValueError, 'Retained ELF needs'):
                solid.apply_policy('x64', tree, self.spool, policy)


if __name__ == '__main__':
    unittest.main()
