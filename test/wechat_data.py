import ctypes as c
import hashlib
import hmac
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import struct
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

spec = importlib.util.spec_from_file_location('wechat_data', pathlib.Path(__file__).parents[1] / 'server/wechat-data.py')
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)
sql = data.sql
KEY, SALT = bytes(range(32)), bytes(range(16))


def encrypt_page(page, number):
    iv = bytes([number % 256]) * 16
    start = 16 if number == 1 else 0
    enc = Cipher(algorithms.AES(KEY), modes.CBC(iv)).encryptor()
    ciphertext = enc.update(page[start:4016]) + enc.finalize()
    mac_key = hashlib.pbkdf2_hmac('sha512', KEY, bytes(b ^ 0x3a for b in SALT), 2, 32)
    mac = hmac.new(mac_key, ciphertext + iv + struct.pack('<I', number), 'sha512').digest()
    return (SALT if number == 1 else b'') + ciphertext + iv + mac


def make_database(file, statement):
    # Ask SQLite itself to reserve SQLCipher's 80 bytes before creating tables.
    api = sql.library('libsqlite3.so.0', 'sqlite3.dll')
    api.sqlite3_open.argtypes = [c.c_char_p, c.POINTER(c.c_void_p)]
    api.sqlite3_exec.argtypes = [c.c_void_p, c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p]
    api.sqlite3_file_control.argtypes = [c.c_void_p, c.c_char_p, c.c_int, c.c_void_p]
    api.sqlite3_close.argtypes = [c.c_void_p]
    ptr, reserve = c.c_void_p(), c.c_int(80)
    assert api.sqlite3_open(str(file).encode(), c.byref(ptr)) == 0
    try:
        assert api.sqlite3_file_control(ptr, b'main', 38, c.byref(reserve)) == 0
        assert api.sqlite3_exec(ptr, statement.encode(), None, None, None) == 0
    finally:
        api.sqlite3_close(ptr)
    plain = file.read_bytes()
    assert plain[20] == 80
    file.write_bytes(b''.join(encrypt_page(plain[i:i+4096], i // 4096 + 1) for i in range(0, len(plain), 4096)))
    return plain


def make_database_with(file, statement, key, salt):
    """make_database with an explicit key/salt pair, to model WeChat message
    shards that use distinct encryption keys (shards load on demand; unopened
    shards have no key cached in process memory)."""
    api = sql.library('libsqlite3.so.0', 'sqlite3.dll')
    api.sqlite3_open.argtypes = [c.c_char_p, c.POINTER(c.c_void_p)]
    api.sqlite3_exec.argtypes = [c.c_void_p, c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p]
    api.sqlite3_file_control.argtypes = [c.c_void_p, c.c_char_p, c.c_int, c.c_void_p]
    api.sqlite3_close.argtypes = [c.c_void_p]
    ptr, reserve = c.c_void_p(), c.c_int(80)
    assert api.sqlite3_open(str(file).encode(), c.byref(ptr)) == 0
    try:
        assert api.sqlite3_file_control(ptr, b'main', 38, c.byref(reserve)) == 0
        assert api.sqlite3_exec(ptr, statement.encode(), None, None, None) == 0
    finally:
        api.sqlite3_close(ptr)
    plain = file.read_bytes()
    assert plain[20] == 80
    def encrypt(page, number):
        iv = bytes([number % 256]) * 16
        start = 16 if number == 1 else 0
        enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        ciphertext = enc.update(page[start:4016]) + enc.finalize()
        mac_key = hashlib.pbkdf2_hmac('sha512', key, bytes(b ^ 0x3a for b in salt), 2, 32)
        mac = hmac.new(mac_key, ciphertext + iv + struct.pack('<I', number), 'sha512').digest()
        return (salt if number == 1 else b'') + ciphertext + iv + mac
    file.write_bytes(b''.join(encrypt(plain[i:i+4096], i // 4096 + 1) for i in range(0, len(plain), 4096)))
    return plain


def wal_bytes(pages, commit=True):
    header = struct.pack('>6I', 0x377f0682, 3007000, 4096, 0, 11, 22)
    rolling = sql.checksum(header, '<')
    result = header + struct.pack('>2I', *rolling)
    for index, (number, page) in enumerate(pages):
        head = struct.pack('>4I', number, max(n for n, _ in pages) if commit and index == len(pages)-1 else 0, 11, 22)
        rolling = sql.checksum(head[:8] + page, '<', rolling)
        result += head + struct.pack('>2I', *rolling) + page
    return result


class DataTest(unittest.TestCase):
    def test_contact_scan_does_not_require_message_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True)
            (root / 'message').mkdir()
            make_database(root / 'contact/contact.db',
                          "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            # This shard is intentionally not a valid SQLCipher database. A
            # contacts refresh must still succeed because chat shards are not
            # needed to enumerate the address book.
            (root / 'message/message_0.db').write_bytes(b'not-ready')
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', return_value={SALT: KEY}):
                result = data.execute({'action': 'contacts'}, 42, directory, lambda: None)
            self.assertTrue(result['available'])
            self.assertEqual([p['label'] for p in result['contacts']], ['A'])

    def test_date_inventory_and_image_pipe_bind_to_authenticated_contact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root/'contact').mkdir(parents=True); (root/'message').mkdir()
            make_database(root/'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER); INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest(); reference = 'a'*32
            make_database(root/'message/message_0.db', f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a'); CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT); INSERT INTO {table} VALUES(1,3,100,2,'<msg><img md5=\"{reference}\"/></msg>'),(2,1,100000,1,'text');")
            folder=root.parent/'msg'/'attach'/hashlib.md5(b'wxid_a').hexdigest()/'2026-09'/'Img'; folder.mkdir(parents=True)
            (folder/(reference+'.dat')).write_bytes(b'\x89PNG\r\n\x1a\nfixturebytes')
            with patch.object(data,'active_root',return_value=root), patch.object(data,'discover_keys',side_effect=lambda *args:{SALT:KEY}):
                scan=data.execute({'action':'contacts'},42,directory,lambda:None)
                base={'account':scan['account'],'contact':scan['contacts'][0]['id']}
                dates=data.execute({'action':'read-dates',**base},42,directory,lambda:None)
                self.assertEqual(dates['days'],[0,1])
                recent=data.execute({'action':'read',**base},42,directory,lambda:None)
                self.assertEqual(recent['messages'][0]['type'],'image')
                self.assertNotIn('_image',recent['messages'][0])
                image=data.execute({'action':'read-image',**base,'messageId':recent['messages'][0]['id']},42,directory,lambda:None)
                self.assertEqual(image['image']['mime'],'image/png')
                missing=data.execute({'action':'read-image',**base,'messageId':'f'*64},42,directory,lambda:None)
                self.assertIsNone(missing['image'])
                self.assertEqual(data.execute({'action':'read-image',**base,'account':'wrong'},42,directory,lambda:None),{'error':'account-changed'})

    def test_global_recent_selection_ignores_old_invalid_bodies_and_range_reads_are_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root/'contact').mkdir(parents=True); (root/'message').mkdir()
            make_database(root/'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER); INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            schema = f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a'); CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
            make_database(root/'message/message_0.db', schema + f"INSERT INTO {table} VALUES(1,49,1,2,'invalid-old-xml');")
            text = '😀' * 100
            make_database(root/'message/message_1.db', schema + ''.join(f"INSERT INTO {table} VALUES({i+1},1,{1000+i},1,'{text}');" for i in range(300)))
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', side_effect=lambda *args: {SALT: KEY}):
                scan = data.execute({'action':'contacts'},42,directory,lambda:None)
                base = {'account':scan['account'],'contact':scan['contacts'][0]['id']}
                recent = data.execute({'action':'read',**base},42,directory,lambda:None)['messages']
                self.assertEqual(recent[-1]['timestamp'],1299)
                self.assertLessEqual(data.utf16_length(json.dumps(recent,ensure_ascii=False,separators=(',',':'))),80000)
                page=data.execute({'action':'read-range',**base,'from':1000,'to':1300},42,directory,lambda:None)
                found=page['messages']
                self.assertEqual([m['timestamp'] for m in found],list(range(1000,1300)))
                self.assertEqual(len({m['id'] for m in found}),300)
                self.assertNotIn('nextCursor', page)
                self.assertFalse(page['truncated'])
                make_database(root/'message/message_2.db', schema + f"INSERT INTO {table} VALUES(1,49,1300,2,'invalid-next-page');")
                first = data.execute({'action':'read-range',**base,'from':1000,'to':1301},42,directory,lambda:None)
                self.assertTrue(first['messages'])
                self.assertNotIn('nextCursor', first)
                self.assertEqual(len(first['messages']), 301)
                self.assertTrue(all(m['timestamp'] < 1301 for m in first['messages']))

    def test_range_reads_skip_unknown_message_kinds_but_keep_order_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root/'contact').mkdir(parents=True); (root/'message').mkdir()
            make_database(root/'contact/contact.db',
                          "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            schema = f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a'); CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
            make_database(root/'message/message_0.db', schema +
                          f"INSERT INTO {table} VALUES(1,1,1000,2,'before');" +
                          f"INSERT INTO {table} VALUES(2,999,1001,2,'opaque');" +
                          f"INSERT INTO {table} VALUES(3,1,1002,2,'after');")
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', side_effect=lambda *args: {SALT: KEY}):
                scan = data.execute({'action':'contacts'},42,directory,lambda:None)
                base = {'account':scan['account'],'contact':scan['contacts'][0]['id']}
                page = data.execute({'action':'read-range',**base,'from':1000,'to':1003},42,directory,lambda:None)
                self.assertEqual([m['timestamp'] for m in page['messages']], [1000, 1001, 1002])
                self.assertEqual([m['text'] for m in page['messages']], ['before', '', 'after'])
                self.assertEqual(len({m['id'] for m in page['messages']}), 3)

    def test_recent_read_ignores_old_unreadable_bodies_but_refuses_unreadable_latest_incoming(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root/'contact').mkdir(parents=True); (root/'message').mkdir()
            make_database(root/'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER); INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            schema = f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a'); CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
            # An old undecodable row inside the recent window must not disable
            # the contact: it becomes a placeholder and the newest message wins.
            make_database(root/'message/message_0.db', schema + f"INSERT INTO {table} VALUES(1,999,100,2,'opaque-old'),(2,1,101,2,'latest');")
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', side_effect=lambda *args: {SALT: KEY}):
                scan = data.execute({'action':'contacts'},42,directory,lambda:None)
                base = {'account':scan['account'],'contact':scan['contacts'][0]['id']}
                recent = data.execute({'action':'read',**base},42,directory,lambda:None)['messages']
                self.assertEqual([m['text'] for m in recent], ['', 'latest'])
                # When the newest incoming message itself is unreadable, a reply
                # must still not be based on incomplete data.
                (root/'message/message_0.db').unlink()
                make_database(root/'message/message_0.db', schema + f"INSERT INTO {table} VALUES(1,1,100,2,'older'),(2,999,101,2,'opaque-latest');")
                with self.assertRaisesRegex(ValueError, 'unsupported latest incoming message'):
                    data.execute({'action':'read',**base},42,directory,lambda:None)
                page = data.execute({'action':'read-range',**base,'from':99,'to':102},42,directory,lambda:None)
                self.assertEqual([m['text'] for m in page['messages']], ['older', ''])

    def test_voice_type_and_contact_activity_metadata_without_body_queries(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'message_0.db'); table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            make_database(file, f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                          f"CREATE TABLE {table}(local_id INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT);"
                          f"INSERT INTO {table} VALUES(1,34,100,2,'<msg/>');")
            people = [{'username':'wxid_a'}, {'username':'wxid_missing'}]
            data.contact_activity(lambda f: sql.Database(sql.Pages(f, KEY)), [file], people)
            self.assertEqual([p['lastChatAt'] for p in people], [100, None])
            self.assertEqual([p['contactOrder'] for p in people], [0, 1])
            db = sql.Database(sql.Pages(file, KEY))
            try:
                message = data.messages(db, file.name, 'a', 'b', 'wxid_self', 'wxid_a')[0]
                self.assertEqual((message['type'], message['direction'], message['text']), ('voice','other','[语音]'))
            finally: db.close()

    def test_snapshot_recovery_keeps_only_authenticated_material_and_never_old_results(self):
        for error in (sql.SnapshotChanged('database changing'), ValueError('database changing'),
                      ValueError('account changed'), ValueError('database path changed'),
                      ValueError('page authentication failed'), OSError(), TimeoutError(), RuntimeError()):
            with self.subTest(error=type(error).__name__ + ':' + str(error)):
                cache = data.SessionCache(); cache.bind(42, pathlib.Path('/profile/a'))
                reader = object()
                cache.keys[SALT], cache.session_reader = KEY, reader
                cache.remember('old', [], {'messages': ['old']})
                cache.invalidate(error)
                self.assertEqual(cache.snapshots, {})
                if isinstance(error, sql.SnapshotChanged):
                    self.assertEqual(cache.keys, {SALT: KEY})
                    self.assertIs(cache.session_reader, reader)
                    self.assertEqual(cache.scope, (42, str(pathlib.Path('/profile/a'))))
                else:
                    self.assertEqual(cache.keys, {})
                    self.assertIsNone(cache.session_reader)
                    self.assertIsNone(cache.scope)

    def test_absent_shard_keys_are_not_rescanned_on_every_read(self):
        # WeChat only caches keys for the shards it has opened, and each shard
        # has its own key, so a read asking for every shard would otherwise walk
        # the whole address space again on every poll.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'wxid_test'
            (root / 'contact').mkdir(parents=True)
            (root / 'message').mkdir()
            make_database(root / 'contact/contact.db', 'CREATE TABLE t(x);')
            other_key, other_salt = bytes(range(32, 64)), bytes(range(16, 32))
            make_database_with(root / 'message/message_1.db', 'CREATE TABLE t(x);', other_key, other_salt)
            cache = data.SessionCache()
            cache.bind(42, root)
            cache.keys[SALT] = KEY
            calls = []

            def discover(pid, memory, files, check, known=None):
                calls.append([file.name for file in files])
                return dict(known or {})

            files = [root / 'contact/contact.db', root / 'message/message_1.db']
            with patch.object(data, 'discover_keys', side_effect=discover):
                first = cache.authenticated_keys(42, files, lambda: None)
                second = cache.authenticated_keys(42, files, lambda: None)
            self.assertEqual(calls, [['message_1.db']])
            self.assertEqual(list(first), [SALT])
            self.assertEqual(list(second), [SALT])
            # A different WeChat process may hold that shard's key, so the note
            # is dropped when the pid changes.
            cache.bind(43, root)
            with patch.object(data, 'discover_keys', side_effect=discover):
                cache.authenticated_keys(43, files, lambda: None)
            self.assertEqual(len(calls), 2)

    def test_key_scan_budget_keeps_the_keys_already_authenticated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            other_salt = bytes(range(16, 32))
            make_database_with(root / 'message_1.db', 'CREATE TABLE t(x);', bytes(range(32, 64)), other_salt)
            cache = data.SessionCache()
            cache.bind(42, root)

            def walk_then_check(pid, memory, files, check, known=None):
                check()  # a real walk checks its deadline as it advances
                raise AssertionError('discovery must not produce a result past its budget')

            with patch.object(data, 'KEY_SCAN_BUDGET', -1), patch.object(data, 'discover_keys', side_effect=walk_then_check):
                found = cache._discover(42, [root / 'message_1.db'], lambda: None, {SALT: KEY})
            self.assertEqual(found, {SALT: KEY})
            self.assertIn(other_salt, cache.missing)
            # An interrupted walk may still have a key in its unvisited tail,
            # so it rests for far less than a completed search would.
            self.assertLess(cache.missing[other_salt], time.monotonic() + data.MISSING_KEY_TTL)

    def test_keys_action_warms_every_shard_without_reading_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True)
            (root / 'message').mkdir()
            make_database(root / 'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER); INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            make_database(root / 'message/message_0.db', 'CREATE TABLE t(x);')
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', side_effect=lambda *args, **kwargs: {SALT: KEY}):
                warmed = data.execute({'action': 'keys'}, 42, directory, lambda: None)
            self.assertTrue(warmed['available'])
            self.assertEqual([p['label'] for p in warmed['contacts']], ['A'])

    def test_database_set_recovery_requires_the_same_database_and_wal_files(self):
        before = [(1, 10, 8192, 100, 100), (1, 11, 4096, 100, 100), bytes(96)]
        for kind in ('database-content', 'wal-content', 'commit', 'database-replaced', 'wal-replaced', 'wal-appeared', 'database-missing'):
            with self.subTest(kind=kind):
                old, after = list(before), list(before)
                if kind == 'database-content': after[0] = (1, 10, 8192, 101, 101)
                elif kind == 'wal-content': after[1] = (1, 11, 8193, 101, 101)
                elif kind == 'commit': after[2] = bytes([1]) * 96
                elif kind == 'database-replaced': after[0] = (1, 12, 8192, 101, 101)
                elif kind == 'wal-replaced': after[1] = (1, 13, 4096, 101, 101)
                elif kind == 'wal-appeared': old[1] = None
                else: after[0] = None
                with patch.object(data, 'file_versions', return_value=after), self.assertRaises(ValueError) as raised:
                    data.check_versions([pathlib.Path('/database')], old)
                self.assertEqual(isinstance(raised.exception, sql.SnapshotChanged), kind in ('database-content', 'wal-content', 'commit'))

    def test_retained_key_is_reauthenticated_against_current_ciphertext_before_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'contact.db')
            make_database(file, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);')
            cache = data.SessionCache(); cache.bind(42, pathlib.Path(directory))
            cache.keys[SALT], cache.session_reader = KEY, object()
            cache.invalidate(sql.SnapshotChanged())
            damaged = bytearray(file.read_bytes()); damaged[24] ^= 1
            file.write_bytes(damaged)
            with patch.object(data, 'discover_keys', side_effect=ValueError('database key unavailable')) as discover:
                with self.assertRaises(ValueError) as rejected:
                    cache.authenticated_keys(42, [file], lambda: None)
            discover.assert_called_once()
            self.assertNotIsInstance(rejected.exception, sql.SnapshotChanged)
            cache.invalidate(rejected.exception)
            self.assertEqual(cache.keys, {})
            self.assertIsNone(cache.session_reader)

    def test_partial_keys_do_not_fail_requests_for_unopened_shards(self):
        # WeChat loads message shards on demand: an unopened shard simply has no
        # key in process memory. A worker that already authenticated some shards
        # must keep serving the ones it can read instead of failing everything.
        with tempfile.TemporaryDirectory() as directory:
            contact = pathlib.Path(directory, 'contact.db')
            make_database(contact, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);')
            other_salt, other_key = bytes(reversed(range(16))), bytes(reversed(range(32)))
            shard = pathlib.Path(directory, 'message_0.db')
            make_database_with(shard, 'CREATE TABLE t(x);', other_key, other_salt)
            cache = data.SessionCache(); cache.bind(42, pathlib.Path(directory))
            cache.keys[SALT] = KEY  # contact key known; shard key not in memory
            with patch.object(data, 'discover_keys', return_value={}) as discover:
                result = cache.authenticated_keys(42, [contact, shard], lambda: None)
            self.assertEqual(result, {SALT: KEY})
            self.assertEqual(discover.call_count, 1)
            self.assertEqual(discover.call_args.args[4], {SALT: KEY})
            self.assertEqual(cache.keys, {SALT: KEY})

    def test_read_reports_unloaded_shards_instead_of_fake_empty_history(self):
        # Real history exists in an unopened shard: returning an empty message
        # list would make the UI report "没有可学习的文字" although records exist.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            make_database(root / 'contact/contact.db',
                          "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            other_salt, other_key = bytes(reversed(range(16))), bytes(reversed(range(32)))
            make_database_with(root / 'message/message_0.db',
                               f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                               f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                               f"INSERT INTO {table} VALUES(1,1,100,2,'你好');", other_key, other_salt)
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', side_effect=lambda *a, **k: {SALT: KEY}):
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None)
                base = {'account': scan['account'], 'contact': scan['contacts'][0]['id']}
                with self.assertRaisesRegex(ValueError, 'chat messages not loaded'):
                    data.execute({'action': 'read', **base}, 42, directory, lambda: None)

    def test_read_keeps_loaded_shard_messages_even_when_other_shards_are_unopened(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            make_database(root / 'contact/contact.db',
                          "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            schema = f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');" \
                     f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
            make_database(root / 'message/message_0.db', schema + f"INSERT INTO {table} VALUES(1,1,100,2,'已加载');")
            other_salt, other_key = bytes(reversed(range(16))), bytes(reversed(range(32)))
            make_database_with(root / 'message/message_1.db', schema + f"INSERT INTO {table} VALUES(1,1,200,2,'未加载');",
                               other_key, other_salt)
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', side_effect=lambda *a, **k: {SALT: KEY}):
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None)
                base = {'account': scan['account'], 'contact': scan['contacts'][0]['id']}
                result = data.execute({'action': 'read', **base}, 42, directory, lambda: None)
                self.assertEqual([m['text'] for m in result['messages']], ['已加载'])

    def test_worker_cache_never_trusts_an_empty_message_result(self):
        # A stale cached "no messages" result (recorded while shards were
        # unopened) must not shadow real history once keys are available.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            contact_file = root / 'contact/contact.db'
            make_database(contact_file,
                          "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            message_file = root / 'message/message_0.db'
            make_database(message_file, f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                          f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                          f"INSERT INTO {table} VALUES(1,1,100,2,'真实历史');")
            cache = data.SessionCache()
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', return_value={SALT: KEY}) as discover, \
                    patch.object(data, 'messages', wraps=data.messages) as messages:
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None, cache)
                account, contact = scan['account'], scan['contacts'][0]['id']
                request = {'action': 'read', 'account': account, 'contact': contact}
                files = tuple(str(f) for f in (contact_file, message_file))
                versions = data.file_versions([contact_file, message_file])
                cache.remember((request['action'], account, contact, None, False, None, (), files),
                               versions, {'account': account, 'contact': contact, 'messages': [], 'label': 'A',
                                          'native': data.native_route('wxid_self', 'wxid_a'), 'revision': '0' * 64})
                result = data.execute(request, 42, directory, lambda: None, cache)
                self.assertEqual([m['text'] for m in result['messages']], ['真实历史'])
                self.assertGreater(messages.call_count, 0)

    def test_cold_worker_retries_real_changes_across_requests_without_rescanning_keys_or_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True)
            file = root / 'contact/contact.db'
            make_database(file, "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1);")
            cache, reader = data.SessionCache(), Mock()
            original_contacts, counts = data.contacts, [0]
            def changed_once(rows, username):
                counts[0] += 1
                result = original_contacts(rows, username)
                if counts[0] <= 3:
                    state = file.stat()
                    os.utime(file, ns=(state.st_atime_ns, state.st_mtime_ns + 1000000))
                return result
            output = io.StringIO()
            with patch.object(data, 'SessionCache', return_value=cache), \
                    patch.object(data, 'new_session_reader', return_value=reader) as factory, \
                    patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'discover_keys', side_effect=lambda *_: {SALT: KEY}) as discover, \
                    patch.object(data, 'contacts', side_effect=changed_once), \
                    patch.object(cache, 'authenticated_keys', wraps=cache.authenticated_keys) as authenticate, \
                    patch.object(cache, 'invalidate', wraps=cache.invalidate) as invalidate, \
                    patch.object(data.signal, 'signal'), patch.dict(data.os.environ, {'HOME': directory}), \
                    patch.object(data.sys, 'argv', ['wechat-data.py', '42', '--worker']), \
                    patch.object(data.sys, 'stdin', io.StringIO('{"action":"contacts"}\n' * 2)), \
                    patch.object(data.sys, 'stdout', output):
                data.main()
            failed, recovered = [json.loads(line) for line in output.getvalue().splitlines()]
            # SnapshotChanged retries are exhausted: the transient stage tells
            # the node side this was a write-in-progress, not a verdict.
            self.assertEqual(failed, {'error': 'data-unavailable', 'stage': 'database-changed'})
            self.assertTrue(recovered['available'])
            self.assertEqual(counts[0], 4)
            self.assertEqual(authenticate.call_count, 4)
            self.assertEqual(discover.call_count, 1)
            self.assertEqual(factory.call_count, 0)  # Contact reads do not inspect native UI sessions.
            self.assertIsInstance(invalidate.call_args.args[0], sql.SnapshotChanged)
            self.assertEqual(cache.keys, {})  # Worker exit still drops everything.

    def test_retry_after_account_switch_discards_warmed_keys_and_original_contact_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = [pathlib.Path(directory, name + '_abcd/db_storage') for name in ('wxid_self', 'wxid_other')]
            for name, root in zip(('wxid_self', 'wxid_other'), roots):
                (root / 'contact').mkdir(parents=True)
                make_database(root / 'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                              f"INSERT INTO contact VALUES('{name}','我','','',1),('wxid_a','A','','',1);")
            cache, active, count = data.SessionCache(), [roots[0]], [0]
            original_contacts = data.contacts
            def switch_after_first_query(rows, username):
                result = original_contacts(rows, username)
                count[0] += 1
                if count[0] == 1:
                    active[0] = roots[1]
                    raise sql.SnapshotChanged('database changing')
                return result
            account = data.digest('wechat-data-account\0wxid_self')
            output = io.StringIO()
            with patch.object(data, 'SessionCache', return_value=cache), \
                    patch.object(data, 'new_session_reader', side_effect=lambda *_: Mock()) as factory, \
                    patch.object(data, 'active_root', side_effect=lambda *_: active[0]), \
                    patch.object(data, 'discover_keys', side_effect=lambda *_: {SALT: KEY}) as discover, \
                    patch.object(data, 'contacts', side_effect=switch_after_first_query), \
                    patch.object(data.signal, 'signal'), patch.dict(data.os.environ, {'HOME': directory}), \
                    patch.object(data.sys, 'argv', ['wechat-data.py', '42', '--worker']), \
                    patch.object(data.sys, 'stdin', io.StringIO(json.dumps({'action': 'contacts', 'account': account}) + '\n')), \
                    patch.object(data.sys, 'stdout', output):
                data.main()
            self.assertEqual(json.loads(output.getvalue()), {'error': 'account-changed'})
            self.assertEqual(discover.call_count, 2)
            self.assertEqual(factory.call_count, 0)
            self.assertEqual(cache.snapshots, {})
            self.assertEqual(cache.keys, {})

    def test_contacts_do_not_warm_native_session_or_expand_database_version_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True)
            file = root / 'contact/contact.db'
            make_database(file, "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1);")
            versions, events = data.file_versions, []
            reader = Mock()
            def warm():
                events.append('warm')
                state = file.stat()
                os.utime(file, ns=(state.st_atime_ns, state.st_mtime_ns + 1000000))
                return {}
            def observed(files):
                events.append('versions')
                return versions(files)
            reader.hint.side_effect = warm
            with patch.object(data, 'active_root', return_value=root), \
                    patch.object(data, 'new_session_reader', return_value=reader), \
                    patch.object(data, 'file_versions', side_effect=observed), \
                    patch.object(data, 'discover_keys', side_effect=lambda *_: {SALT: KEY}):
                result = data.execute({'action': 'contacts'}, 42, directory, lambda: None, data.SessionCache())
            self.assertTrue(result['available'])
            self.assertEqual(events, ['versions', 'versions'])

    def test_session_hint_reuses_only_the_bound_worker_reader_and_current_check(self):
        cache = data.SessionCache(); cache.bind(42, pathlib.Path('/profile/a'))
        checks, hints = [], []
        reader = SimpleNamespace(check=None)
        def hint():
            reader.check()
            value = {'issuedAt': len(hints)}
            hints.append(value)
            return value
        reader.hint = hint
        with patch.object(data, 'new_session_reader', return_value=reader) as factory:
            first = cache.session_hint(42, '/profile', lambda: checks.append('first'))
            checks.clear()
            second = cache.session_hint(42, '/profile', lambda: checks.append('second'))
            self.assertNotEqual(first, second); self.assertEqual(factory.call_count, 1)
            self.assertEqual(set(checks), {'second'})
            cache.bind(43, pathlib.Path('/profile/a'))
            self.assertIsNone(cache.session_reader)
            cache.session_hint(43, '/profile', lambda: None)
            self.assertEqual(factory.call_count, 2)
            cache.bind(43, pathlib.Path('/profile/b'))
            self.assertIsNone(cache.session_reader)
            cache.session_hint(43, '/profile', lambda: None)
            self.assertEqual(factory.call_count, 3)
            cache.clear(); self.assertIsNone(cache.session_reader)

    def test_optional_session_hint_failure_does_not_suppress_cancellation(self):
        cache = data.SessionCache(); cache.bind(42, pathlib.Path('/profile/a'))
        with patch.object(data, 'new_session_reader', side_effect=ValueError('unsupported session build')):
            self.assertIsNone(cache.session_hint(42, '/profile', lambda: None))
        with patch.object(data, 'new_session_reader', side_effect=TimeoutError('cancelled')):
            with self.assertRaises(TimeoutError): cache.session_hint(42, '/profile', lambda: None)
        checks = iter([None, TimeoutError('cancelled')])
        def check():
            result = next(checks)
            if result: raise result
        with patch.object(data, 'new_session_reader', side_effect=OSError('unavailable')):
            with self.assertRaises(TimeoutError): cache.session_hint(42, '/profile', check)
        self.assertIsNone(cache.session_reader)

    def test_read_refreshes_routing_metadata_after_contact_changes_without_new_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            contact_file = root / 'contact/contact.db'
            def write_contacts(remark, own_alias, alias):
                if contact_file.exists(): contact_file.unlink()
                make_database(contact_file, "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                              f"INSERT INTO contact VALUES('wxid_self','我','','{own_alias}',1),('wxid_a','A','{remark}','{alias}',1);")
            write_contacts('原备注', 'alias_self', 'alias_a')
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            make_database(root / 'message/message_0.db', "CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                          f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                          f"INSERT INTO {table} VALUES(1,1,100,2,'来信。');")
            cache = data.SessionCache()
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', return_value={SALT: KEY}):
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None, cache)
                request = {'action': 'read', 'account': scan['account'], 'contact': scan['contacts'][0]['id']}
                first = data.execute(request, 42, directory, lambda: None, cache)
                self.assertEqual(first['label'], '原备注')
                self.assertEqual(first['native'], data.native_route('alias_self', 'alias_a'))
                write_contacts('更新后的备注', 'changed_self_alias', 'changed_friend_alias')
                second = data.execute(request, 42, directory, lambda: None, cache)
                self.assertEqual(second['label'], '更新后的备注')
                self.assertEqual(second['native'], data.native_route('changed_self_alias', 'changed_friend_alias'))
                self.assertEqual(second['account'], first['account'])
                self.assertEqual(second['contact'], first['contact'])
                self.assertEqual(second['revision'], first['revision'])
                self.assertNotIn('username', second)
                self.assertEqual(data.execute(request, 42, directory, lambda: None, cache), second)

    def test_worker_cache_reuses_unchanged_snapshots_but_rechecks_commits_and_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            make_database(root / 'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','',1),('wxid_a','A','','',1),('wxid_b','B','','',1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            message_file = root / 'message/message_0.db'
            def write_message(text):
                if message_file.exists(): message_file.unlink()
                make_database(message_file, f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                              f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                              f"INSERT INTO {table} VALUES(1,1,100,2,'{text}');")
            write_message('第一条')
            cache = data.SessionCache()
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', return_value={SALT: KEY}) as discover, patch.object(data, 'messages', wraps=data.messages) as messages:
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None, cache)
                request = {'action': 'read', 'account': scan['account'], 'contact': scan['contacts'][0]['id']}
                first = data.execute(request, 42, directory, lambda: None, cache)
                for _ in range(5): self.assertEqual(data.execute(request, 42, directory, lambda: None, cache), first)
                self.assertEqual(messages.call_count, 2)
                self.assertEqual(discover.call_count, 1)
                range_request = {**request, 'action': 'read-range', 'from': 0, 'to': 200}
                data.execute(range_request, 42, directory, lambda: None, cache)
                self.assertTrue(all(key[0] != 'read-range' for key in cache.snapshots))
                calls_after_range = messages.call_count
                data.execute(range_request, 42, directory, lambda: None, cache)
                self.assertGreater(messages.call_count, calls_after_range)
                # The two range reads above each perform metadata and body
                # queries; the following plain read still reuses its snapshot.
                calls_before_cached_read = messages.call_count
                self.assertEqual(data.execute(request, 42, directory, lambda: None, cache), first)
                self.assertEqual(messages.call_count, calls_before_cached_read)
                write_message('第二条')
                second = data.execute(request, 42, directory, lambda: None, cache)
                self.assertEqual(second['messages'][0]['text'], '第二条')
                self.assertNotEqual(first['revision'], second['revision'])
                self.assertEqual(messages.call_count, calls_before_cached_read + 2)
                self.assertEqual(discover.call_count, 1)
                # A different contact can never reuse another contact's text.
                other = data.execute({**request, 'contact': scan['contacts'][1]['id']}, 42, directory, lambda: None, cache)
                self.assertEqual(other['messages'], [])
                versions = data.file_versions([root / 'contact/contact.db', message_file])
                with patch.object(data, 'file_versions', side_effect=[versions, []]), self.assertRaisesRegex(ValueError, 'database set changing'):
                    data.execute(request, 42, directory, lambda: None, cache)
                # Account changes are checked even when all cached DB files are unchanged.
                with patch.object(data, 'active_root', side_effect=[root, pathlib.Path(directory, 'different-account')]):
                    self.assertEqual(data.execute(request, 42, directory, lambda: None, cache), {'error': 'account-changed'})
                self.assertEqual(cache.keys, {})
                self.assertEqual(cache.snapshots, {})

    def test_worker_cache_is_bounded_and_process_scoped(self):
        cache = data.SessionCache(); cache.bind(42, pathlib.Path('/profile/a'))
        cache.keys[SALT] = KEY
        for i in range(40): cache.remember(i, [], {'messages': [str(i)]})
        self.assertEqual(len(cache.snapshots), 16)
        cache.bind(43, pathlib.Path('/profile/a'))
        self.assertEqual(cache.keys, {}); self.assertEqual(cache.snapshots, {})
        cache.keys[SALT] = KEY; cache.bind(43, pathlib.Path('/profile/b'))
        self.assertEqual(cache.keys, {})

    def test_sort_sequence_and_late_server_ack_keep_local_message_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            observed = []
            for remote in (0, 555):
                file = pathlib.Path(directory, f'{remote}.db')
                make_database(file, f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                              f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,server_id INTEGER,sort_seq INTEGER);"
                              f"INSERT INTO {table} VALUES(1,1,100,1,'newer',{remote},20),(2,1,100,2,'older',444,10);")
                db = sql.Database(sql.Pages(file, KEY))
                try:
                    result = data.messages(db, 'message_0.db', 'a', 'b', 'wxid_self', 'wxid_a')
                    self.assertEqual([m['text'] for m in result], ['newer', 'older'])
                    observed.append(result[0]['id'])
                finally: db.close()
            self.assertEqual(observed[0], observed[1])

    def test_active_account_is_taken_only_from_this_process_inside_this_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            home, proc = base / 'home', base / 'proc'
            first = home / 'xwechat_files/wxid_self_abcd/db_storage/contact/contact.db'
            second = home / 'xwechat_files/wxid_other_abcd/db_storage/contact/contact.db'
            foreign = base / 'other-home/xwechat_files/wxid_self_abcd/db_storage/contact/contact.db'
            for file in (first, second, foreign):
                file.parent.mkdir(parents=True); file.touch()
            fds = proc / '42/fd'; fds.mkdir(parents=True); (fds / '10').touch()
            with patch.object(data.os, 'readlink', return_value=str(first)):
                self.assertEqual(data.active_root(42, home, proc), first.parent.parent)
            # Even a single old account directory is not evidence of the
            # account currently logged in to the running WeChat process.
            second.unlink()
            with patch.object(data.os, 'readlink', return_value=str(foreign)), self.assertRaisesRegex(ValueError, 'active account unavailable'):
                data.active_root(42, home, proc)
            second.touch()
            with patch.object(data.os, 'readlink', return_value=str(foreign)), self.assertRaises(ValueError):
                data.active_root(42, home, proc)
            (fds / '11').touch()
            with patch.object(data.os, 'readlink', side_effect=lambda fd: str(first if fd.name == '10' else second)), self.assertRaises(ValueError):
                data.active_root(42, home, proc)
            (fds / '10').unlink()
            with patch.object(data.os, 'readlink', return_value=str(second)):
                self.assertEqual(data.active_root(42, home, proc), second.parent.parent)
            # The parent process can bind a live root for this private worker
            # when Linux denies the worker access to WeChat's /proc/PID/fd.
            with patch.dict(data.os.environ, {'QIBOX_ACCOUNT_ROOT': str(second.parent.parent)}), \
                    patch.object(data.pathlib.Path, 'iterdir', side_effect=PermissionError):
                self.assertEqual(data.active_root(42, home, proc), second.parent.parent)
            with patch.dict(data.os.environ, {'QIBOX_ACCOUNT_ROOT': str(second.parent.parent)}), \
                    patch.object(data.os, 'readlink', return_value=str(first)), self.assertRaisesRegex(ValueError, 'active account unavailable'):
                data.active_root(42, home, proc)

    def test_same_instance_account_switch_never_reads_the_previous_account(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            home, proc = base / 'home', base / 'proc'
            roots = [home / 'xwechat_files' / (name + '_abcd') / 'db_storage' for name in ('wxid_one', 'wxid_two')]
            for name, root in zip(('wxid_one', 'wxid_two'), roots):
                (root / 'contact').mkdir(parents=True)
                make_database(root / 'contact/contact.db',
                              "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER);"
                              f"INSERT INTO contact VALUES('{name}','我','','',1),('{name}_friend','{name} friend','','',1);")
            fds = proc / '42' / 'fd'; fds.mkdir(parents=True); (fds / '10').touch()
            selected = [roots[0] / 'contact' / 'contact.db']
            original = data.active_root
            with patch.object(data, 'active_root', side_effect=lambda pid, home: original(pid, home, proc)), \
                    patch.object(data.os, 'readlink', side_effect=lambda _: str(selected[0]) if selected[0] else ''), \
                    patch.object(data, 'discover_keys', side_effect=lambda *_: {SALT: KEY}):
                first = data.execute({'action': 'contacts'}, 42, home, lambda: None)
                self.assertEqual(first['account'], data.digest('wechat-data-account\0wxid_one'))
                self.assertEqual(len(first['contacts']), 1)
                selected[0] = roots[1] / 'contact' / 'contact.db'
                self.assertEqual(data.execute({'action': 'contacts', 'account': first['account']}, 42, home, lambda: None),
                                 {'error': 'account-changed'})
                second = data.execute({'action': 'contacts'}, 42, home, lambda: None)
                self.assertEqual(second['account'], data.digest('wechat-data-account\0wxid_two'))
                self.assertEqual(len(second['contacts']), 1)
                self.assertNotEqual(first['contacts'][0]['id'], second['contacts'][0]['id'])
                selected[0] = None
                with self.assertRaisesRegex(ValueError, 'active account unavailable'):
                    data.execute({'action': 'contacts'}, 42, home, lambda: None)

    def test_complete_data_api_reads_contacts_and_multiple_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, 'wxid_self_abcd/db_storage')
            (root / 'contact').mkdir(parents=True); (root / 'message').mkdir()
            make_database(root / 'contact/contact.db', "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER,delete_flag INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self','我','','alias_self',1,0),('wxid_a','A','','alias_a',1,0),('wxid_b','B','','alias_b',1,NULL),"
                          "('stranger','陌生人','','',3,0),('service','服务','','',0,0),('cached','其他缓存','','',5,0),('removed','已删除','','',1,1);")
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            for index in range(2):
                make_database(root / f'message/message_{index}.db', f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                              f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                              f"INSERT INTO {table} VALUES(1,1,{100+index},{index+1},'消息{index}');")
            with patch.object(data, 'active_root', return_value=root), patch.object(data, 'discover_keys', side_effect=lambda *_: {SALT: KEY}):
                scan = data.execute({'action': 'contacts'}, 42, directory, lambda: None)
                self.assertEqual(len(scan['contacts']), 2)
                account, contact = scan['account'], scan['contacts'][0]['id']
                request = {'action': 'read', 'account': account, 'contact': contact}
                result = data.execute(request, 42, directory, lambda: None)
                self.assertEqual([m['text'] for m in result['messages']], ['消息0', '消息1'])
                self.assertEqual([m['direction'] for m in result['messages']], ['self', 'other'])
                self.assertEqual(len({m['id'] for m in result['messages']}), 2)
                self.assertEqual(data.execute({**request, 'account': 'old'}, 42, directory, lambda: None), {'error': 'account-changed'})
                original = data.messages
                def changing(db, shard, *args, **kwargs):
                    result = original(db, shard, *args, **kwargs)
                    if shard == 'message_1.db':
                        file = root / 'message/message_0.db'
                        file.write_bytes(file.read_bytes() + bytes(4096))
                    return result
                with patch.object(data, 'messages', side_effect=changing), self.assertRaisesRegex(ValueError, 'database set changing'):
                    data.execute(request, 42, directory, lambda: None)

    def test_keys_are_authenticated_and_split_memory_chunks_are_handled(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'contact.db')
            make_database(file, 'CREATE TABLE t(x);')
            encoded = b"x'" + KEY.hex().encode() + SALT.hex().encode() + b"'"
            block = b'\0' * (1024 * 1024 - 50) + encoded + bytes(200)
            maps = '1000-201000 rw-p 00000000 00:00 0 [heap]\n'
            with patch.object(pathlib.Path, 'read_text', return_value=maps), patch.object(data.os, 'pread', create=True,
                    side_effect=lambda _, size, offset: block[offset-4096:offset-4096+size]):
                self.assertEqual(data.discover_keys(42, 3, [file], lambda: None), {SALT: KEY})

    def test_encoded_keys_use_validated_codec_pointers_and_page_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'contact.db')
            make_database(file, 'CREATE TABLE t(x);')
            page = file.read_bytes()[:4096]
            for mask in (bytes(32), hashlib.sha256(b'linux-build-mask').digest()):
                literal = b"x'" + KEY.hex().encode() + SALT.hex().encode() + b"'"
                blob = bytes(value ^ mask[index % 32] for index, value in enumerate(literal))
                self.assertEqual(data.decode_keyspec(blob, SALT, page), KEY)
                corrupt = bytearray(blob); corrupt[3] ^= 1
                self.assertIsNone(data.decode_keyspec(bytes(corrupt), SALT, page))
                # The codec signature straddles a scan boundary, while its salt,
                # read context and encoded keyspec live in another mapping.
                start, context = 0x1000, 0x1000 + 1024 * 1024 - 30
                heap = bytearray(1024 * 1024 + 400)
                struct.pack_into('<10I', heap, context-start, 32, 16, 16, 4096, 99, 80, 64, 0, 2, 2)
                struct.pack_into('<Q', heap, context-start+56, 0x400000)
                struct.pack_into('<Q', heap, context-start+88, 0x400100)
                other = bytearray(4096); other[:16] = SALT
                struct.pack_into('<Q', other, 0x100+8, 0x400200)
                struct.pack_into('<Q', other, 0x100+32, 0x400300)
                other[0x300:0x300+99] = blob
                maps = f'{start:x}-{start+len(heap):x} rw-p 00000000 00:00 0 [heap]\n400000-401000 rw-p 00000000 00:00 0\n'
                def read(_, size, address):
                    region, base = (heap, start) if start <= address < start+len(heap) else (other, 0x400000)
                    if not base <= address < address+size <= base+len(region):
                        raise OSError('unmapped')
                    return bytes(region[address-base:address-base+size])
                with patch.object(pathlib.Path, 'read_text', return_value=maps), patch.object(data.os, 'pread', create=True, side_effect=read):
                    self.assertEqual(data.discover_keys(42, 3, [file], lambda: None), {SALT: KEY})
                    if any(mask):
                        struct.pack_into('<Q', heap, context-start+88, 0xdeadbeef)
                        with self.assertRaisesRegex(ValueError, 'database key unavailable'):
                            data.discover_keys(42, 3, [file], lambda: None)

    def test_wal_index_limits_reads_to_published_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'db')
            make_database(file, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);')
            encrypted = file.read_bytes()
            wal = wal_bytes([(i // 4096 + 1, encrypted[i:i+4096]) for i in range(0, len(encrypted), 4096)])
            pathlib.Path(str(file) + '-wal').write_bytes(wal)
            header = bytearray(40)
            struct.pack_into('<I', header, 0, 3007000); header[12] = 1
            struct.pack_into('<H', header, 14, 4096)
            # No published WAL frames yet; the otherwise valid commit is ignored.
            header[32:40] = wal[16:24]
            head = header + struct.pack('<II', *sql.checksum(header, '<'))
            shm = pathlib.Path(str(file) + '-shm'); shm.write_bytes(head * 2)
            db = sql.Database(sql.Pages(file, KEY))
            try:
                self.assertEqual(db.pages.frames, {})
                self.assertEqual(db.query('SELECT * FROM t'), [[1]])
                shm.write_bytes(bytes(96))
                with self.assertRaises(sql.SnapshotChanged): db.query('SELECT * FROM t')
            finally: db.close()

    def test_authenticated_lazy_sqlite_queries_and_no_plaintext_files(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'contact.db')
            make_database(file, "CREATE TABLE contact(username TEXT, nick_name TEXT, remark TEXT, alias TEXT, local_type INTEGER);"
                          "INSERT INTO contact VALUES('wxid_self', '我', '', 'my_alias', 1), ('wxid_a', '同名', '', 'alias_a', 1), ('wxid_b', '同名', '', '', 1);")
            encrypted = file.read_bytes()
            db = sql.Database(sql.Pages(file, KEY))
            try:
                rows = db.query('SELECT username, nick_name, remark, alias FROM contact WHERE local_type != 3')
                account, people = data.contacts(rows, 'wxid_self')
                self.assertEqual(len(people), 2)
                self.assertNotEqual(people[0]['id'], people[1]['id'])
                self.assertEqual(people[0]['label'], people[1]['label'])
                self.assertEqual(db.query('SELECT username FROM contact WHERE username=?', ('wxid_a',)), [['wxid_a']])
                self.assertEqual(len(db.pages.cache), 2)
                with self.assertRaises(ValueError):
                    db.query("INSERT INTO contact(username) VALUES('forbidden')")
            finally:
                db.close()
            self.assertEqual(file.read_bytes(), encrypted)
            self.assertEqual([p.name for p in pathlib.Path(directory).iterdir()], ['contact.db'])

    def test_tampered_key_or_page_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'contact.db')
            make_database(file, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);')
            with self.assertRaises(ValueError) as rejected:
                sql.Pages(file, bytes(32))
            self.assertNotIsInstance(rejected.exception, sql.SnapshotChanged)
            damaged = bytearray(file.read_bytes()); damaged[4200] ^= 1; file.write_bytes(damaged)
            db = sql.Database(sql.Pages(file, KEY))
            try:
                with self.assertRaises(ValueError) as rejected: db.query('SELECT * FROM t')
                self.assertNotIsInstance(rejected.exception, sql.SnapshotChanged)
            finally: db.close()

    def test_wal_commit_overlay_uncommitted_tail_and_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            file, newer = pathlib.Path(directory, 'old.db'), pathlib.Path(directory, 'new.db')
            make_database(file, "CREATE TABLE t(x TEXT); INSERT INTO t VALUES('old');")
            make_database(newer, "CREATE TABLE t(x TEXT); INSERT INTO t VALUES('new');")
            encrypted = newer.read_bytes()
            frames = [(i // 4096 + 1, encrypted[i:i+4096]) for i in range(0, len(encrypted), 4096)]
            wal = pathlib.Path(str(file) + '-wal')
            for committed, expected in [(False, 'old'), (True, 'new')]:
                wal.write_bytes(wal_bytes(frames, committed))
                db = sql.Database(sql.Pages(file, KEY))
                try:
                    self.assertEqual(db.query('SELECT * FROM t'), [[expected]])
                    wal.write_bytes(wal.read_bytes() + b'partial')
                    with self.assertRaises(sql.SnapshotChanged): db.query('SELECT * FROM t')
                finally: db.close()

    def test_message_ids_directions_shards_and_repeat_text(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'message_0.db')
            table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            make_database(file, f"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'), ('wxid_a');"
                          f"CREATE TABLE {table}(local_id INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER);"
                          f"INSERT INTO {table} VALUES(1,1,100,1,'一样',101),(2,1,101,2,'一样',102),(3,1,102,2,'你好😀',103);")
            db = sql.Database(sql.Pages(file, KEY))
            try:
                messages = data.messages(db, file.name, 'a', 'b', 'wxid_self', 'wxid_a')
                self.assertEqual([m['direction'] for m in messages], ['other', 'other', 'self'])
                self.assertEqual(len({m['id'] for m in messages}), 3)
                self.assertEqual(messages[0]['text'], '你好😀')
                self.assertEqual(messages, data.messages(db, file.name, 'a', 'b', 'wxid_self', 'wxid_a'))
                self.assertEqual(data.messages(db, file.name, 'a', 'b', 'wxid_self', 'missing'), [])
            finally: db.close()

    def test_xml_media_and_unknown_formats(self):
        self.assertEqual(data.message_text('<msg><appmsg><type>57</type><title>我说的话</title><refermsg><content>引用</content></refermsg></appmsg></msg>', 49), '我说的话')
        self.assertEqual(data.message_text('<xml/>', 3), '[图片]')
        for text, kind in [('x', 999), ('<!DOCTYPE a><a/>', 49), ('<invalid', 49)]:
            with self.assertRaises((ValueError, data.ET.ParseError)): data.message_text(text, kind)
        with self.assertRaises(ValueError): data.decode(b'abc', 99)

    def test_analysis_skips_only_unparseable_bodies_preserving_ids_and_database(self):
        with tempfile.TemporaryDirectory() as directory:
            file=pathlib.Path(directory,'message_0.db');table='Msg_'+hashlib.md5(b'wxid_a').hexdigest()
            make_database(file,"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                +f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                +f"INSERT INTO {table} VALUES(1,1,100,1,'valid'),(2,999,101,2,'unparseable'),(3,49,102,2,'<invalid');")
            before=file.read_bytes();db=sql.Database(sql.Pages(file,KEY))
            try:
                # A strict read keeps an unreadable body as a placeholder too and
                # marks it, instead of failing the whole chat on one bad row.
                strict=data.messages(db,file.name,'a','b','wxid_self','wxid_a')
                self.assertEqual([m['text'] for m in strict],['','','valid'])
                self.assertEqual([m.get('_unparsable') for m in strict],[True,True,None])
                rows=data.messages(db,file.name,'a','b','wxid_self','wxid_a',skip_unparsed=True)
                self.assertEqual([m['text'] for m in rows],['','','valid'])
                self.assertEqual(len({m['id'] for m in rows}),3)
                self.assertEqual(file.read_bytes(),before)
            finally:db.close()
        broken=Mock();broken.query.side_effect=OSError('database unavailable')
        with self.assertRaises(OSError):data.messages(broken,'message_0.db','a','b','wxid_self','wxid_a',skip_unparsed=True)

    def test_analysis_skips_unknown_sender_without_guessing_a_direction(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'message_0.db'); table = 'Msg_' + hashlib.md5(b'wxid_a').hexdigest()
            make_database(file, "CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_a');"
                + f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT);"
                + f"INSERT INTO {table} VALUES(1,1,100,1,'known'),(2,1,101,99,'unknown');")
            db = sql.Database(sql.Pages(file, KEY))
            try:
                # An unresolved sender is still never guessed: the row stays a
                # marked placeholder instead of failing the whole read.
                strict = data.messages(db, file.name, 'a', 'b', 'wxid_self', 'wxid_a')
                self.assertEqual(strict[0]['text'], '')
                self.assertEqual(strict[0]['direction'], 'system')
                self.assertTrue(strict[0]['_unparsable'])
                rows = data.messages(db, file.name, 'a', 'b', 'wxid_self', 'wxid_a', skip_unparsed=True)
                self.assertEqual(rows[0]['text'], ''); self.assertEqual(rows[0]['direction'], 'system')
                self.assertEqual(rows[0]['timestamp'], 101); self.assertEqual(rows[1]['text'], 'known')
            finally: db.close()



class GroupMetadataTest(unittest.TestCase):
    def test_mentions_are_validated_from_source_only(self):
        for xml, expected in [('<msgsource><atuserlist>wxid_self</atuserlist></msgsource>', 'self'),
                              ('<msgsource><atuserlist>notify@all</atuserlist></msgsource>', 'all'),
                              ('<msgsource><atuserlist>wxid_other</atuserlist></msgsource>', 'others')]:
            flags = data.group_mentions(xml, 'wxid_self')
            self.assertTrue(flags['verified']); self.assertTrue(flags[expected])
        for xml in ['@我', '<!DOCTYPE a><msgsource/>', '<other/>', '<msgsource><atuserlist>a</atuserlist><atuserlist>b</atuserlist></msgsource>']:
            self.assertFalse(data.group_mentions(xml, 'wxid_self')['verified'])

    def test_group_identity_sender_and_mentions_survive_sqlcipher_read(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory, 'message_0.db'); group = '12345@chatroom'
            table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
            make_database(file, "CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('wxid_self'),('wxid_member');"
                + f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,source TEXT);"
                + f"INSERT INTO {table} VALUES(1,1,100,2,'wxid_member:' || char(10) || '@other正文不决定真实提及','<msgsource><atuserlist>wxid_self</atuserlist></msgsource>');")
            db = sql.Database(sql.Pages(file, KEY, lambda: None))
            try: messages = data.messages(db, 'message_0.db', 'account', 'contact', 'wxid_self', group)
            finally: db.close()
            self.assertEqual(len(messages), 1); message = messages[0]
            self.assertEqual(message['direction'], 'other'); self.assertEqual(message['text'], '@other正文不决定真实提及')
            self.assertEqual(len(message['sender']), 64); self.assertTrue(message['mentions']['self'])
            _, contacts = data.contacts([('wxid_self', '本人', '', ''), (group, '讨论群', '', 'misleading-alias')], 'wxid_self')
            self.assertEqual(contacts[0]['kind'], 'group')
            self.assertEqual(contacts[0]['native'], data.native_route('wxid_self', group))



    def test_unknown_name_group_chats_are_dropped_but_named_groups_kept(self):
        rows = [('wxid_self', '本人', '', ''),
                ('12345@chatroom', '讨论群', '', ''),
                ('67890@chatroom', '', '', ''),
                ('wxid_a', 'A', '', '')]
        account, contacts = data.contacts(rows, 'wxid_self')
        self.assertEqual([c['kind'] for c in contacts], ['group', 'person'])
        self.assertEqual(contacts[0]['label'], '讨论群')
        # A group whose nickname and remark are both empty (deleted or left
        # chat) resolves to the raw chatroom id and must not be listed.
        self.assertNotIn('67890@chatroom', [c['username'] for c in contacts])

if __name__ == '__main__': unittest.main()
