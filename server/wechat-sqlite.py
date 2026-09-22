"""Read-only, page-at-a-time SQLCipher 4 view of a live WeChat database.

No decrypted database, WAL or key is written to disk. A private SQLite VFS
reads authenticated pages and the last complete WAL transaction. File changes
invalidate the entire query; callers retry rather than publish a mixed view.
"""
import ctypes as c
import ctypes.util
import hashlib
import hmac
import os
import pathlib
import struct
import sys
from collections import OrderedDict

PAGE = 4096
HEADER = b'SQLite format 3\0'
# Ceiling on the rows one query may materialise. A range read legitimately asks
# for 30,001 rows of narrow message metadata (three integers and an id); a lower
# ceiling silently turned every chat longer than the ceiling into a failed read,
# and the range read had no way to report that as a bounded result.
ROW_LIMIT = 30001


class SnapshotChanged(ValueError):
    """Only a version change on the same database/WAL files, never bad data."""


def library(linux, windows):
    if sys.platform == 'win32':
        return c.CDLL(str(pathlib.Path(sys.base_prefix, 'DLLs', windows)))
    return c.CDLL(linux)


class Cipher:
    def __init__(self, key, salt):
        self.key = key
        self.mac = hashlib.pbkdf2_hmac('sha512', key, bytes(b ^ 0x3a for b in salt), 2, 32)
        self.api = library('libcrypto.so.3', 'libcrypto-3-x64.dll')
        self.api.EVP_CIPHER_CTX_new.restype = c.c_void_p
        self.api.EVP_aes_256_cbc.restype = c.c_void_p
        self.api.EVP_CIPHER_CTX_free.argtypes = [c.c_void_p]
        self.api.EVP_DecryptInit_ex.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p]
        self.api.EVP_CIPHER_CTX_set_padding.argtypes = [c.c_void_p, c.c_int]
        self.api.EVP_DecryptUpdate.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int), c.c_void_p, c.c_int]
        self.api.EVP_DecryptFinal_ex.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int)]

    def valid(self, page, number):
        start = 16 if number == 1 else 0
        return len(page) == PAGE and hmac.compare_digest(
            hmac.new(self.mac, page[start:PAGE-64] + struct.pack('<I', number), 'sha512').digest(), page[-64:])

    def decrypt(self, page, number):
        if not self.valid(page, number):
            raise ValueError('page authentication failed')
        start = 16 if number == 1 else 0
        encrypted, iv = page[start:PAGE-80], page[PAGE-80:PAGE-64]
        ctx = self.api.EVP_CIPHER_CTX_new()
        if not ctx:
            raise ValueError('cipher unavailable')
        try:
            out, length, final = c.create_string_buffer(PAGE), c.c_int(), c.c_int()
            if (self.api.EVP_DecryptInit_ex(ctx, self.api.EVP_aes_256_cbc(), None, self.key, iv) != 1
                    or self.api.EVP_CIPHER_CTX_set_padding(ctx, 0) != 1
                    or self.api.EVP_DecryptUpdate(ctx, out, c.byref(length), encrypted, len(encrypted)) != 1
                    or self.api.EVP_DecryptFinal_ex(ctx, c.byref(out, length.value), c.byref(final)) != 1
                    or length.value + final.value != len(encrypted)):
                raise ValueError('decryption failed')
            return (HEADER if number == 1 else b'') + out.raw[:length.value] + bytes(80)
        finally:
            self.api.EVP_CIPHER_CTX_free(ctx)


def fingerprint(file):
    s = os.fstat(file.fileno())
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def checksum(data, order, initial=(0, 0)):
    a, b = initial
    for x, y in struct.iter_unpack(order + 'II', data):
        a = (a + x + b) & 0xffffffff
        b = (b + y + a) & 0xffffffff
    return a, b


class Pages:
    def __init__(self, filename, key, check=lambda: None):
        self.filename, self.check = pathlib.Path(filename), check
        self.db = self.wal = None
        self.shm_before = None
        self.cache, self.frames = OrderedDict(), {}
        try:
            self.db = self.filename.open('rb', buffering=0)
            self.before = fingerprint(self.db)
            self.size = self.before[2]
            if not self.size or self.size % PAGE:
                raise ValueError('unsupported database size')
            first = self.db.read(PAGE)
            self.cipher = Cipher(key, first[:16])
            if not self.cipher.valid(first, 1):
                raise ValueError('invalid key')
            try:
                self.wal = pathlib.Path(str(self.filename) + '-wal').open('rb', buffering=0)
            except FileNotFoundError:
                pass
            self.wal_before = fingerprint(self.wal) if self.wal else None
            self.shm_before = self.shm_header()
            if self.wal and self.wal_before[2]:
                self.load_wal()
            self.stable()
        except Exception:
            self.close()
            raise

    def load_wal(self):
        head = self.wal.read(32)
        if len(head) != 32:
            raise ValueError('incomplete WAL header')
        magic, version, page_size = struct.unpack('>III', head[:12])
        if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or page_size != PAGE:
            raise ValueError('unsupported WAL')
        order = '<' if magic == 0x377f0682 else '>'
        rolling = checksum(head[:24], order)
        if rolling != struct.unpack('>II', head[24:]):
            raise ValueError('WAL checksum failed')
        committed_frames = None
        if self.shm_before:
            shm = self.shm_before
            native = '<' if sys.byteorder == 'little' else '>'
            if (len(shm) != 96 or shm[:48] != shm[48:] or shm[12] != 1
                    or struct.unpack(native + 'I', shm[:4])[0] != 3007000
                    or checksum(shm[:40], native) != struct.unpack(native + 'II', shm[40:48])):
                raise ValueError('WAL index changing')
            committed_frames = struct.unpack(native + 'I', shm[16:20])[0]
            if committed_frames and shm[32:40] != head[16:24]:
                raise ValueError('WAL index salt changed')
        pending = {}
        index, committed = 0, 0
        # Recycled trailing frames and an unfinished transaction are not visible.
        while self.wal.tell() + 24 + PAGE <= self.wal_before[2]:
            if committed_frames is not None and index >= committed_frames:
                break
            self.check()
            position = self.wal.tell()
            frame, page = self.wal.read(24), self.wal.read(PAGE)
            if frame[8:16] != head[16:24]:
                break
            rolling = checksum(frame[:8] + page, order, rolling)
            if rolling != struct.unpack('>II', frame[16:]):
                break
            index += 1
            number, db_size = struct.unpack('>II', frame[:8])
            if not 0 < number < 0x7fffffff or db_size >= 0x7fffffff:
                raise ValueError('invalid WAL page')
            pending[number] = position + 24
            if db_size:
                self.frames.update(pending)
                pending.clear()
                self.size = db_size * PAGE
                committed = index
        if committed_frames is not None and committed != committed_frames:
            raise ValueError('committed WAL incomplete')
        self.frames = {n: pos for n, pos in self.frames.items() if n * PAGE <= self.size}

    def shm_header(self):
        try:
            with pathlib.Path(str(self.filename) + '-shm').open('rb') as file:
                return file.read(96)
        except FileNotFoundError:
            return None

    def stable(self):
        self.check()
        current = self.filename.stat()
        if (current.st_dev, current.st_ino) != self.before[:2]:
            raise ValueError('database replaced')
        wal_path = pathlib.Path(str(self.filename) + '-wal')
        if self.wal:
            current = wal_path.stat()
            if (current.st_dev, current.st_ino) != self.wal_before[:2]:
                raise ValueError('WAL replaced')
        elif wal_path.exists():
            raise ValueError('WAL appeared')
        if fingerprint(self.db) != self.before:
            raise SnapshotChanged('database changing')
        if self.shm_header() != self.shm_before:
            raise SnapshotChanged('WAL commit changing')
        if self.wal and fingerprint(self.wal) != self.wal_before:
            raise SnapshotChanged('WAL changing')

    def read(self, offset, amount):
        self.check()
        output = bytearray()
        end = min(offset + amount, self.size)
        while offset < end:
            number = offset // PAGE + 1
            if number not in self.cache:
                file = self.wal if number in self.frames else self.db
                file.seek(self.frames.get(number, (number - 1) * PAGE))
                page = bytearray(self.cipher.decrypt(file.read(PAGE), number))
                if number == 1:
                    # WAL is already overlaid. Prevent SQLite opening sidecars.
                    page[18:20] = b'\x01\x01'
                    page[28:32] = struct.pack('>I', self.size // PAGE)
                self.cache[number] = page
                if len(self.cache) > 256:
                    self.cache.popitem(last=False)
            self.cache.move_to_end(number)
            length = min(end - offset, PAGE - offset % PAGE)
            output.extend(self.cache[number][offset % PAGE:offset % PAGE + length])
            offset += length
        return bytes(output)

    def close(self):
        for file in (self.db, self.wal):
            if file:
                file.close()
        self.cache.clear()


# Only this minimal immutable VFS is registered. There is no write, delete,
# extension loading, network path or writable backing file.
P, I, L = c.c_void_p, c.c_int, c.c_longlong


class Methods(c.Structure):
    _fields_ = [('version', I)] + [(name, P) for name in (
        'close', 'read', 'write', 'truncate', 'sync', 'size', 'lock', 'unlock',
        'reserved', 'control', 'sector', 'characteristics')]


class File(c.Structure):
    _fields_ = [('methods', c.POINTER(Methods))]


class VFS(c.Structure):
    _fields_ = [('version', I), ('fileSize', I), ('maxPath', I), ('next', P), ('name', c.c_char_p), ('data', P)] + [
        (name, P) for name in ('open', 'delete', 'access', 'fullpath', 'dlopen', 'dlerror', 'dlsym', 'dlclose',
                             'randomness', 'sleep', 'time', 'error')]


class Database:
    def __init__(self, pages):
        self.pages, self.callbacks, self.db, self.failure = pages, [], P(), None
        self.api = library('libsqlite3.so.0', 'sqlite3.dll')
        for name, result, args in [
            ('sqlite3_vfs_find', P, [c.c_char_p]), ('sqlite3_vfs_register', I, [P, I]),
            ('sqlite3_vfs_unregister', I, [P]), ('sqlite3_open_v2', I, [c.c_char_p, c.POINTER(P), I, c.c_char_p]),
            ('sqlite3_close', I, [P]), ('sqlite3_prepare_v2', I, [P, c.c_char_p, I, c.POINTER(P), P]),
            ('sqlite3_step', I, [P]), ('sqlite3_finalize', I, [P]), ('sqlite3_column_count', I, [P]),
            ('sqlite3_column_type', I, [P, I]), ('sqlite3_column_int64', L, [P, I]),
            ('sqlite3_column_blob', P, [P, I]), ('sqlite3_column_bytes', I, [P, I]),
            ('sqlite3_bind_text', I, [P, I, c.c_char_p, I, P])]:
            fn = getattr(self.api, name)
            fn.restype, fn.argtypes = result, args
        self.name = ('qibox-memory-' + str(id(self))).encode()
        base = self.api.sqlite3_vfs_find(None)
        self.vfs = VFS.from_buffer_copy(c.string_at(base, c.sizeof(VFS)))
        self.vfs.version, self.vfs.fileSize, self.vfs.name = 1, c.sizeof(File), self.name
        self.vfs.next, self.vfs.data = None, None
        self.methods = Methods()
        self.methods.version = 1
        self.bind(self.methods, 'close', [P], lambda *_: 0)
        self.bind(self.methods, 'read', [P, P, I, L], self.read)
        self.bind(self.methods, 'write', [P, P, I, L], lambda *_: 8)
        self.bind(self.methods, 'truncate', [P, L], lambda *_: 8)
        self.bind(self.methods, 'sync', [P, I], lambda *_: 8)
        self.bind(self.methods, 'size', [P, c.POINTER(L)], self.size)
        self.bind(self.methods, 'lock', [P, I], lambda *_: 0)
        self.bind(self.methods, 'unlock', [P, I], lambda *_: 0)
        self.bind(self.methods, 'reserved', [P, c.POINTER(I)], lambda _, out: self.set_int(out, 0))
        self.bind(self.methods, 'control', [P, I, P], lambda *_: 12)
        self.bind(self.methods, 'sector', [P], lambda *_: PAGE)
        self.bind(self.methods, 'characteristics', [P], lambda *_: 0x2000)  # immutable
        self.bind(self.vfs, 'open', [P, c.c_char_p, P, I, c.POINTER(I)], self.open)
        self.bind(self.vfs, 'delete', [P, c.c_char_p, I], lambda *_: 8)
        self.bind(self.vfs, 'access', [P, c.c_char_p, I, c.POINTER(I)], lambda _, name, flags, out: self.set_int(out, 0))
        self.api.sqlite3_vfs_register(c.byref(self.vfs), 0)
        try:
            if self.api.sqlite3_open_v2(b'qibox', c.byref(self.db), 1, self.name):
                raise ValueError('database unavailable')
            self.query('PRAGMA trusted_schema=OFF')
            self.query('PRAGMA temp_store=MEMORY')
            self.query('PRAGMA cache_size=-1024')
        except Exception:
            self.close()
            raise

    def bind(self, obj, name, args, fn):
        callback = c.CFUNCTYPE(I, *args)(fn)
        self.callbacks.append(callback)
        setattr(obj, name, c.cast(callback, P))

    @staticmethod
    def set_int(out, value):
        out[0] = value
        return 0

    def open(self, _, name, file, flags, out):
        if not flags & 0x100 or flags & (2 | 4):  # only MAIN_DB, READONLY
            return 14
        c.cast(file, c.POINTER(File)).contents.methods = c.pointer(self.methods)
        if out:
            out[0] = 1
        return 0

    def size(self, _, out):
        out[0] = self.pages.size
        return 0

    def read(self, _, out, amount, offset):
        try:
            data = self.pages.read(offset, amount)
            c.memmove(out, data, len(data))
            if len(data) < amount:
                c.memset(out + len(data), 0, amount - len(data))
                return 522  # SQLITE_IOERR_SHORT_READ
            return 0
        except Exception as error:
            self.failure = error
            return 10

    def query(self, sql, params=()):
        stmt = P()
        if self.api.sqlite3_prepare_v2(self.db, sql.encode(), -1, c.byref(stmt), None):
            raise ValueError('unsupported database schema')
        try:
            for index, value in enumerate(params, 1):
                if self.api.sqlite3_bind_text(stmt, index, str(value).encode(), -1, P(-1)):
                    raise ValueError('invalid query parameter')
            rows = []
            while True:
                self.pages.check()
                result = self.api.sqlite3_step(stmt)
                if result == 101:
                    break
                if result != 100:
                    raise ValueError('database query failed') from self.failure
                row = []
                for index in range(self.api.sqlite3_column_count(stmt)):
                    kind = self.api.sqlite3_column_type(stmt, index)
                    if kind == 5:
                        value = None
                    elif kind == 1:
                        value = self.api.sqlite3_column_int64(stmt, index)
                    elif kind in (3, 4):
                        size = self.api.sqlite3_column_bytes(stmt, index)
                        if size > 1024 * 1024:
                            raise ValueError('field too large')
                        value = c.string_at(self.api.sqlite3_column_blob(stmt, index), size)
                        if kind == 3:
                            value = value.decode('utf8')
                    else:
                        raise ValueError('unsupported field')
                    row.append(value)
                rows.append(row)
                if len(rows) > ROW_LIMIT:
                    raise ValueError('query too large')
            self.pages.stable()
            return rows
        finally:
            self.api.sqlite3_finalize(stmt)

    def close(self):
        if self.db:
            self.api.sqlite3_close(self.db)
            self.db = P()
        self.api.sqlite3_vfs_unregister(c.byref(self.vfs))
        self.pages.close()
