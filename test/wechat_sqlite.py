"""The private SQLite view must not depend on the launcher's directory."""
import ctypes as c
import importlib.util
import pathlib
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('wechat_sqlite', pathlib.Path(__file__).parents[1] / 'server/wechat-sqlite.py')
sql = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sql)


class MemoryPages:
    def __init__(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE fixture(value TEXT)')
            db.execute("INSERT INTO fixture VALUES ('private snapshot')")
            self.data = db.serialize()
        self.size = len(self.data)

    def read(self, offset, amount):
        return self.data[offset:offset + amount]

    def check(self):
        pass

    def stable(self):
        return True

    def close(self):
        pass


class VirtualPathTest(unittest.TestCase):
    def test_reader_works_when_the_host_vfs_cannot_resolve_a_path(self):
        api = sql.library('libsqlite3.so.0', 'sqlite3.dll')
        api.sqlite3_vfs_find.restype = sql.P
        api.sqlite3_vfs_find.argtypes = [c.c_char_p]
        api.sqlite3_vfs_register.argtypes = [sql.P, sql.I]
        api.sqlite3_vfs_unregister.argtypes = [sql.P]
        original = api.sqlite3_vfs_find(None)
        host = sql.VFS.from_buffer_copy(c.string_at(original, c.sizeof(sql.VFS)))
        host.name = b'qibox-test-unresolvable-host-path'
        rejected_paths = []

        def cannot_resolve(_, name, size, output):
            rejected_paths.append(name)
            return 14  # SQLITE_CANTOPEN, as with an inaccessible/deleted cwd.

        callback = c.CFUNCTYPE(sql.I, sql.P, c.c_char_p, sql.I, sql.P)(cannot_resolve)
        host.fullpath = c.cast(callback, sql.P)
        self.assertEqual(api.sqlite3_vfs_register(c.byref(host), 1), 0)
        try:
            db = sql.Database(MemoryPages())
            try:
                self.assertEqual(db.query('SELECT value FROM fixture'), [['private snapshot']])
                self.assertEqual(rejected_paths, [])
            finally:
                db.close()
        finally:
            api.sqlite3_vfs_unregister(c.byref(host))
            api.sqlite3_vfs_register(original, 1)


if __name__ == '__main__':
    unittest.main()
