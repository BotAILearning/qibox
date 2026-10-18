import importlib.util
import pathlib
import struct
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'verify-runtime-architecture.py'
SPEC = importlib.util.spec_from_file_location('runtime_architecture', SCRIPT)
runtime_architecture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_architecture)


class RuntimeArchitectureTests(unittest.TestCase):
    def test_machine_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'ELF machine EM_AARCH64'):
            runtime_architecture.assert_machine(183, 62, 'usr/bin/python3.11')

    def test_resource_selection_cannot_cross_architecture(self):
        with self.assertRaisesRegex(ValueError, 'requires linux-arm64, lock is linux-x64'):
            runtime_architecture.select_architecture('arm64', 'linux-x64')
        self.assertEqual(runtime_architecture.select_architecture('arm64')['platform'], 'linux-arm64')

    def test_glibcxx_minimum_must_exist_in_private_provider_versions(self):
        good = runtime_architecture.check_version_requirements(
            {'GLIBCXX_3.4.29', 'GLIBCXX_3.4.30'},
            {'GLIBCXX_3.4.26', 'GLIBCXX_3.4.29', 'GLIBCXX_3.4.30'}, 'GLIBCXX')
        self.assertTrue(good['pass'])
        bad = runtime_architecture.check_version_requirements(
            {'GLIBCXX_3.4.31'}, {'GLIBCXX_3.4.30'}, 'GLIBCXX')
        self.assertFalse(bad['pass'])
        self.assertEqual(bad['missingExactDefinitions'], ['GLIBCXX_3.4.31'])

    def test_symlink_alias_resolves_relative_to_its_directory(self):
        self.assertEqual(runtime_architecture.symlink_alias_path(
            'usr/lib/aarch64-linux-gnu/libsndio.so.7.0', 'libsndio.so.7.2'),
            'usr/lib/aarch64-linux-gnu/libsndio.so.7.2')

    def test_parser_reads_elf64_machine_without_executing_file(self):
        raw = bytearray(64)
        raw[:16] = b'\x7fELF\x02\x01\x01' + b'\0' * 9
        struct.pack_into('<HHIQQQIHHHHHH', raw, 16,
                         3, 183, 1, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0)
        parsed = runtime_architecture.parse_elf(bytes(raw))
        self.assertEqual(parsed['machine'], 183)
        self.assertEqual(parsed['needed'], [])


if __name__ == '__main__':
    unittest.main()
