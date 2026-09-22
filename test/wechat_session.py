import hashlib
import importlib.util
import io
import os
import pathlib
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('qibox_wechat_session', pathlib.Path(__file__).resolve().parents[1] / 'server/wechat-session.py')
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)


def short(value):
    raw = value.encode('ascii')
    assert 0 < len(raw) <= 22
    return bytes([len(raw) * 2]) + raw + bytes(23 - len(raw))


class LiveMemory(unittest.TestCase):
    def setUp(self):
        self.memory = bytearray(0x10000)
        self.reader = session.SessionIdentity.__new__(session.SessionIdentity)
        r = self.reader
        r.pid, r.fd, r.check, r.proc = 99, 3, Mock(), pathlib.Path('/proc')
        r.profile = dict(next(iter(session.PROFILES.values())))
        r.build_id = next(iter(session.PROFILES))
        r.base, r.manager = 0x10000000, None
        r.maps = [(0x10000, 0x20000, 'rw-p', 0, '[heap]')]
        r.bound = ('123', '/wechat', (1, 2, 3, 4, 5), '/own/xwechat_files/wxid_owner_abcd/db_storage')
        r._context, r._stamp = Mock(), Mock(return_value=r.bound)
        self.manager, self.controller, self.inner = 0x10100, 0x11000, 0x12000
        self.node, self.vector, self.current = 0x13000, 0x14000, 0x15000
        p = r.profile
        self.pointer(self.manager, r.base + p['manager_vtable'])
        self.write(self.manager + p['manager_key'], short('normal_key'))
        self.pointer(self.manager + p['controller'], self.controller)
        self.pointer(self.controller + p['inner'], self.inner)
        self.pointer(self.inner + p['current'], self.current)
        self.pointer(self.inner + p['map'] + p['map_first'], self.node)
        self.pointer(self.inner + p['map'] + p['map_size'], 1)
        self.pointer(self.node, 0)
        self.write(self.node + p['node_key'], short('normal_key'))
        self.pointer(self.node + p['vector_begin'], self.vector)
        self.pointer(self.node + p['vector_end'], self.vector + 16)
        self.pointer(self.vector, self.current)
        self.write(self.current + p['username'], short('wxid_target'))
        self.pread = patch.object(session.os, 'pread', self.read, create=True)
        self.pread.start()
        self.addCleanup(self.pread.stop)

    def read(self, fd, length, address):
        self.assertEqual(fd, 3)
        return bytes(self.memory[address - 0x10000:address - 0x10000 + length])

    def write(self, address, value):
        self.memory[address - 0x10000:address - 0x10000 + len(value)] = value

    def pointer(self, address, value):
        self.write(address, struct.pack('<Q', value))

    def identities(self, username='wxid_target'):
        account = session.digest('wechat-data-account\0wxid_owner')
        contact = session.digest('wechat-data-contact\0' + account + '\0' + username)
        return account, contact

    def test_exact_live_member_maps_to_account_scoped_contact_without_ui(self):
        account, contact = self.identities()
        self.assertEqual(self.reader.verify(account, contact), {'account': account, 'contact': contact})
        self.assertEqual(self.reader.current()['username'], 'wxid_target')
        self.assertIsInstance(self.reader.last_read_ms, float)

    def test_same_display_name_never_substitutes_another_contact(self):
        account, wrong = self.identities('wxid_other')
        self.assertFalse(self.reader.matches(account, wrong))
        with self.assertRaisesRegex(ValueError, 'contact changed'):
            self.reader.verify(account, wrong)

    def test_different_account_and_malformed_identifiers_fail(self):
        account, contact = self.identities()
        with self.assertRaisesRegex(ValueError, 'account-changed'):
            self.reader.matches('a' * 64, contact)
        for wrong in ('', 'A' * 64, None, 'x' * 64):
            with self.assertRaises(ValueError):
                self.reader.matches(wrong, contact)

    def test_unrelated_heap_strings_do_not_establish_a_manager(self):
        self.pointer(self.manager, self.reader.base + 8)
        with self.assertRaisesRegex(ValueError, 'manager ambiguous or unavailable'):
            self.reader.current()

    def test_two_live_normal_managers_fail_closed(self):
        second = 0x16000
        self.pointer(second, self.reader.base + self.reader.profile['manager_vtable'])
        self.write(second + self.reader.profile['manager_key'], short('normal_key'))
        with self.assertRaisesRegex(ValueError, 'manager ambiguous'):
            self.reader.current()

    def test_current_pointer_must_be_unique_member_of_live_normal_vector(self):
        p = self.reader.profile
        self.pointer(self.vector, 0x17000)
        with self.assertRaisesRegex(ValueError, 'unique live member'):
            self.reader.current()
        self.pointer(self.vector, self.current)
        self.pointer(self.vector + 16, self.current)
        self.pointer(self.node + p['vector_end'], self.vector + 32)
        with self.assertRaisesRegex(ValueError, 'unique live member'):
            self.reader.current()

    def test_cycle_empty_oversized_and_misaligned_vectors_fail(self):
        p = self.reader.profile
        for end in (self.vector, self.vector + 17, self.vector + 16 * (session.MAX_VECTOR + 1)):
            self.pointer(self.node + p['vector_end'], end)
            with self.assertRaises(ValueError):
                self.reader.current()
        self.pointer(self.node + p['vector_end'], self.vector + 16)
        self.pointer(self.node, self.node)
        with self.assertRaisesRegex(ValueError, 'vector unavailable'):
            self.reader.current()

    def test_each_guard_rereads_cached_manager_and_selected_username(self):
        self.reader.current()
        self.write(self.current + self.reader.profile['username'], short('wxid_other'))
        self.assertFalse(self.reader.matches(*self.identities()))
        self.pointer(self.manager, self.reader.base + 8)
        with self.assertRaisesRegex(ValueError, 'manager changed'):
            self.reader.current()

    def test_selection_change_between_snapshots_invalidates_binding(self):
        original = self.reader._selection
        calls = 0
        def changing(manager):
            nonlocal calls
            result = original(manager)
            calls += 1
            if calls == 1:
                self.write(self.current + self.reader.profile['username'], short('wxid_other'))
            return result
        self.reader._selection = changing
        with self.assertRaisesRegex(ValueError, 'selected session changed'):
            self.reader.current()
        self.assertIsNone(self.reader.manager)

    def test_empty_current_is_navigable_only_after_stable_account_and_vector_checks(self):
        self.pointer(self.inner + self.reader.profile['current'], 0)
        self.assertIsNone(self.reader.current()['username'])
        self.assertFalse(self.reader.matches(*self.identities()))
        with self.assertRaisesRegex(ValueError, 'contact changed'):
            self.reader.verify(*self.identities())
        self.pointer(self.vector, 0)
        with self.assertRaisesRegex(ValueError, 'unique live member'):
            self.reader.current()

    def test_empty_normal_vector_allows_no_selection_and_rejects_selected_pointer(self):
        p = self.reader.profile
        self.pointer(self.inner + p['current'], 0)
        for pointer in (0, self.vector):
            self.pointer(self.node + p['vector_begin'], pointer)
            self.pointer(self.node + p['vector_end'], pointer)
            self.assertFalse(self.reader.matches(*self.identities()))
            self.pointer(self.inner + p['current'], self.current)
            with self.assertRaisesRegex(ValueError, 'empty session vector'):
                self.reader.current()
            self.pointer(self.inner + p['current'], 0)
        self.pointer(self.node + p['vector_begin'], 0x10001)
        self.pointer(self.node + p['vector_end'], 0x10001)
        with self.assertRaisesRegex(ValueError, 'empty session vector'):
            self.reader.current()

    def test_empty_map_requires_verified_zero_count_and_no_current_selection(self):
        p = self.reader.profile
        self.pointer(self.inner + p['current'], 0)
        self.pointer(self.inner + p['map'] + p['map_first'], 0)
        self.pointer(self.inner + p['map'] + p['map_size'], 0)
        self.assertFalse(self.reader.matches(*self.identities()))
        self.pointer(self.inner + p['map'] + p['map_size'], 1)
        with self.assertRaisesRegex(ValueError, 'vector unavailable'):
            self.reader.current()
        self.pointer(self.inner + p['map'] + p['map_size'], 0)
        self.pointer(self.inner + p['current'], self.current)
        with self.assertRaisesRegex(ValueError, 'vector unavailable'):
            self.reader.current()

    def test_process_or_account_change_at_final_read_invalidates_binding(self):
        self.reader._stamp.return_value = ('new', *self.reader.bound[1:])
        with self.assertRaisesRegex(ValueError, 'selected session changed'):
            self.reader.current()
        self.assertIsNone(self.reader.manager)

    def test_pointer_bounds_unreadable_mapping_and_short_reads_fail(self):
        for address, length in ((0, 8), (session.MAX_ADDRESS - 1, 8), (0x10000, 0), (0x1fff8, 16)):
            with self.assertRaises(ValueError):
                self.reader._read(address, length)
        self.reader.maps = [(0x10000, 0x20000, '---p', 0, '')]
        with self.assertRaises(ValueError):
            self.reader._read(0x10100, 8)
        self.reader.maps = [(0x10000, 0x20000, 'rw-p', 0, '')]
        with patch.object(session.os, 'pread', return_value=b''):
            with self.assertRaises(ValueError):
                self.reader._read(0x10100, 8)

    def test_libcpp_long_string_bounds_termination_and_header_stability(self):
        address, pointer = 0x18000, 0x19000
        value = 'wxid_' + 'a' * 40
        self.write(address, struct.pack('<QQQ', 65, len(value), pointer))
        self.write(pointer, value.encode() + b'\0')
        self.assertEqual(self.reader._string(address)[0], value)
        self.write(pointer + len(value), b'x')
        with self.assertRaises(ValueError):
            self.reader._string(address)
        self.write(address, struct.pack('<QQQ', 65, 129, pointer))
        with self.assertRaises(ValueError):
            self.reader._string(address)
        self.write(address, bytes([46]) + b'x' * 23)
        with self.assertRaises(ValueError):
            self.reader._string(address)

    def test_scan_budget_is_enforced_before_reading_huge_mapping(self):
        self.reader.maps = [(0x10000, 0x10000 + session.MAX_SCAN + 1, 'rw-p', 0, '[heap]')]
        with self.assertRaisesRegex(ValueError, 'scan limit'):
            self.reader._managers()

    def test_warm_hint_skips_scan_but_still_rechecks_live_contact(self):
        hint = self.reader.hint()
        self.assertNotIn('wxid_', str(hint))
        self.reader.manager = None
        self.reader._apply_hint(hint)
        self.reader._managers = Mock(side_effect=AssertionError('warm hint must not rescan'))
        self.assertTrue(self.reader.matches(*self.identities()))
        self.write(self.current + self.reader.profile['username'], short('wxid_other'))
        self.assertFalse(self.reader.matches(*self.identities()))

    def test_hint_with_other_process_build_root_or_executable_fails_closed(self):
        hint = self.reader.hint()
        for key in ('version', 'pid', 'processStart', 'buildId', 'rootKey', 'executableKey'):
            wrong = {**hint, key: 'wrong'}
            with self.assertRaisesRegex(ValueError, 'hint scope changed'):
                self.reader._apply_hint(wrong)

    def test_expired_future_or_malformed_hint_cannot_trigger_fallback_scan(self):
        hint = self.reader.hint()
        for issued in (hint['issuedAt'] - session.HINT_AGE_MS - 1, hint['issuedAt'] + 60000, True, '1'):
            with self.assertRaisesRegex(ValueError, 'hint expired'):
                self.reader._apply_hint({**hint, 'issuedAt': issued})
        for address in ('0x0', '0x10001', '0xffffffffffffffff', '1', 123):
            with self.assertRaisesRegex(ValueError, 'hint unavailable'):
                self.reader._apply_hint({**hint, 'manager': address})
        for malformed in (None, [], {}, {**hint, 'extra': 'value'}):
            with self.assertRaisesRegex(ValueError, 'hint unavailable'):
                self.reader._apply_hint(malformed)

    def test_in_scope_hint_still_cannot_authorize_invalid_object_or_vector(self):
        hint = self.reader.hint()
        self.reader._apply_hint({**hint, 'manager': '0x16000'})
        with self.assertRaises(ValueError):
            self.reader.current()
        self.reader._apply_hint(hint)
        self.pointer(self.vector, 0x17000)
        with self.assertRaisesRegex(ValueError, 'unique live member'):
            self.reader.current()


class ExecutableAndContext(unittest.TestCase):
    def elf(self, identity=b'test-build', machine=62):
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, machine)
        struct.pack_into('<Q', header, 32, 64)
        struct.pack_into('<HH', header, 54, 56, 1)
        note = struct.pack('<III', 4, len(identity), 3) + b'GNU\0' + identity
        note += bytes((-len(identity)) % 4)
        ph = struct.pack('<IIQQQQQQ', 4, 4, 120, 120, 120, len(note), len(note), 4)
        return bytes(header) + ph + note

    def test_unknown_full_build_never_uses_a_prefix_or_version(self):
        # 非 ELF 内容直接拒绝。
        for content in (b'', b'4.1.13.9'):
            with self.assertRaises(ValueError):
                session.elf_identity(io.BytesIO(content))
        # 结构有效但 build_id 未知：不再抛错，返回 (build_id, None) 交给发现流程；
        # 未知 build 绝不能误配到已知 profile 的偏移或版本信息上。
        for content in (self.elf(bytes.fromhex(next(iter(session.PROFILES))) + b'changed'), self.elf()):
            build_id, profile = session.elf_identity(io.BytesIO(content))
            self.assertIsNone(profile)
            self.assertNotIn(build_id, session.PROFILES)

    def test_supported_full_build_still_requires_exact_hash_and_architecture(self):
        identity = b'test-build'
        content = self.elf(identity)
        profile = {'machine': 62, 'sha256': hashlib.sha256(content).hexdigest()}
        with patch.dict(session.PROFILES, {identity.hex(): profile}):
            self.assertEqual(session.elf_identity(io.BytesIO(content)), (identity.hex(), profile))
            for modified in (content + b'patch', self.elf(identity, machine=183)):
                with self.assertRaises(ValueError):
                    session.elf_identity(io.BytesIO(modified))

    def test_inherited_descriptor_must_be_read_only_and_for_exact_pid(self):
        reader = session.SessionIdentity.__new__(session.SessionIdentity)
        reader.pid, reader.fd, reader.proc = 99, 3, pathlib.Path('/proc')
        fcntl = types.SimpleNamespace(F_GETFL=3, fcntl=Mock(return_value=os.O_RDONLY))
        with patch.dict(sys.modules, {'fcntl': fcntl}), patch.object(session.os, 'readlink', return_value='/proc/99/mem'):
            reader._validate_descriptor()
            fcntl.fcntl.return_value = os.O_RDWR
            with self.assertRaisesRegex(ValueError, 'read-only'):
                reader._validate_descriptor()
            fcntl.fcntl.return_value = os.O_RDONLY
            with patch.object(session.os, 'readlink', return_value='/proc/98/mem'):
                with self.assertRaisesRegex(ValueError, 'process changed'):
                    reader._validate_descriptor()

    def test_cached_process_account_or_executable_stamp_cannot_be_rebound(self):
        reader = session.SessionIdentity.__new__(session.SessionIdentity)
        reader.check = Mock()
        reader.bound = ('start', '/wechat', (1, 2, 3, 4, 5), '/account-one')
        for index in range(4):
            changed = list(reader.bound)
            changed[index] = 'changed'
            reader.manager = 0x10000
            reader._stamp = Mock(return_value=tuple(changed))
            with self.assertRaisesRegex(ValueError, 'process or account changed'):
                reader._context()
            self.assertIsNone(reader.manager)

    def test_cancel_check_interrupts_before_executable_or_memory_access(self):
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            content = self.elf()
            session.elf_identity(io.BytesIO(content), Mock(side_effect=RuntimeError('cancelled')))

    def test_active_account_requires_exact_open_database_below_owned_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            home, proc = root / 'home', root / 'proc'
            descriptors = proc / '99' / 'fd'
            descriptors.mkdir(parents=True)
            one = home / 'wechat' / 'xwechat_files' / 'wxid_one_abcd' / 'db_storage' / 'contact' / 'contact.db'
            two = home / 'wechat' / 'xwechat_files' / 'wxid_two_abcd' / 'db_storage' / 'contact' / 'contact.db'
            outside = root / 'other-home' / 'xwechat_files' / 'wxid_one_abcd' / 'db_storage' / 'contact' / 'contact.db'
            for path in (one, two, outside):
                path.parent.mkdir(parents=True)
                path.write_bytes(b'')
            (descriptors / '1').write_bytes(b'')
            with patch.object(session.os, 'readlink', return_value=str(one)):
                self.assertEqual(session.active_root(99, home.resolve(), proc), one.parent.parent.resolve())
            with patch.object(session.os, 'readlink', return_value=str(outside)):
                with self.assertRaisesRegex(ValueError, 'active account unavailable'):
                    session.active_root(99, home.resolve(), proc)
            (descriptors / '2').write_bytes(b'')
            with patch.object(session.os, 'readlink', side_effect=lambda path: str(one if path.name == '1' else two)):
                with self.assertRaisesRegex(ValueError, 'active account unavailable'):
                    session.active_root(99, home.resolve(), proc)

    def test_context_requires_unique_current_executable_base_and_skips_kernel_vsyscall(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = session.SessionIdentity.__new__(session.SessionIdentity)
            reader.pid, reader.proc, reader.check = 99, pathlib.Path(directory), Mock()
            reader.bound = ('start', '/opt/wechat/wechat', (1, 2, 3, 4, 5), '/account')
            reader._stamp, reader._validate_descriptor = Mock(return_value=reader.bound), Mock()
            process = reader.proc / '99'
            process.mkdir()
            base = '10000000-10001000 r--p 00000000 08:01 3 /opt/wechat/wechat\n'
            kernel = 'ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]\n'
            (process / 'maps').write_text(base + kernel)
            reader._context()
            self.assertEqual(reader.base, 0x10000000)
            (process / 'maps').write_text(base + '20000000-20001000 r--p 00000000 08:01 3 /opt/wechat/wechat\n')
            with self.assertRaisesRegex(ValueError, 'executable mapping unavailable'):
                reader._context()


if __name__ == '__main__':
    unittest.main()
