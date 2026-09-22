"""Read-only current-conversation identity for explicitly verified WeChat builds.

The caller lends an O_RDONLY /proc/PID/mem descriptor. No process attachment,
code injection, memory writes, UI actions, output, or persisted identifiers are
used. Raw usernames remain in this private helper's memory; callers should use
matches/verify and expose only their existing account/contact hashes.
"""
import hashlib
import json
import os
import pathlib
import re
import struct
import time


PROFILES = {
    'd16278a416e000526fd22aec59973e54f91291e4': {
        'sha256': '91c2e3237ba69acadb23a84bdde360c714719889756aed92e9e45785c3d97010',
        'machine': 62, 'manager_vtable': 0xa66d808,
        'manager_key': 0x178, 'controller': 0x1a8,
        'inner': 0xf8, 'current': 0x40, 'username': 0x148,
        'map': 0x18, 'map_first': 0x10, 'map_size': 0x18, 'node_key': 0x10,
        'vector_begin': 0x28, 'vector_end': 0x30,
    },
}

# Cross-build discovery. A rebuild moves every RVA, so the vtable address above
# cannot be reused for an unknown binary. What does survive rebuilds is a
# source-level literal: each manager keeps a short std::string equal to
# ANCHOR at offset manager_key, and libc++ stores those bytes from object+1.
# So we search memory for the literal instead of for a vtable pointer, read the
# vtable back out of whichever object we land on, and let the existing live
# structure checks decide whether that object really is the manager.
ANCHOR = b'normal_key'
BASE_LAYOUT = {
    'machine': 62,
    'controller': 0x1a8, 'inner': 0xf8, 'current': 0x40, 'username': 0x148,
    'map': 0x18, 'map_first': 0x10, 'map_size': 0x18, 'node_key': 0x10,
    'vector_begin': 0x28, 'vector_end': 0x30,
}
# The known manager_key first, then neighbouring slots in case a rebuild shuffled
# the class by one or two members. Anything further is not worth guessing.
KEY_CANDIDATES = (0x178,) + tuple(off for off in range(0x148, 0x1c8, 8) if off != 0x178)
MAX_CANDIDATES = 8
KEY = re.compile(r'[a-f0-9]{64}')
USERNAME = re.compile(r'[A-Za-z0-9_.@-]{1,128}')
SELF = re.compile(r'[A-Za-z][A-Za-z0-9_.-]{2,127}')
MAX_ADDRESS = (1 << 63) - 1
MAX_SCAN = 2 * 1024 * 1024 * 1024
MAX_VECTOR = 20000
HINT_AGE_MS = 30000


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def file_stamp(path):
    value = path.stat()
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def elf_identity(stream, check=lambda: None):
    """Parse bounded ELF64 notes and hash the exact executable, not a version label."""
    stream.seek(0)
    header = stream.read(64)
    if len(header) != 64 or header[:6] != b'\x7fELF\x02\x01':
        raise ValueError('unsupported session executable')
    machine = struct.unpack_from('<H', header, 18)[0]
    offset = struct.unpack_from('<Q', header, 32)[0]
    entry, count = struct.unpack_from('<HH', header, 54)
    if entry != 56 or not 1 <= count <= 256 or offset > 1024 * 1024:
        raise ValueError('unsupported session executable')
    stream.seek(offset)
    table = stream.read(entry * count)
    if len(table) != entry * count:
        raise ValueError('unsupported session executable')
    identities = set()
    for index in range(count):
        check()
        segment = struct.unpack_from('<IIQQQQQQ', table, index * entry)
        if segment[0] != 4:
            continue
        if segment[5] > 1024 * 1024 or segment[2] > 1024 * 1024 * 1024:
            raise ValueError('unsupported session executable')
        stream.seek(segment[2])
        notes = stream.read(segment[5])
        if len(notes) != segment[5]:
            raise ValueError('unsupported session executable')
        position = 0
        while position + 12 <= len(notes):
            namesize, size, kind = struct.unpack_from('<III', notes, position)
            position += 12
            name_end = position + namesize
            data_start = position + ((namesize + 3) & ~3)
            data_end = data_start + size
            next_position = data_start + ((size + 3) & ~3)
            if name_end > len(notes) or next_position > len(notes):
                raise ValueError('unsupported session executable')
            if notes[position:name_end].rstrip(b'\0') == b'GNU' and kind == 3:
                identities.add(notes[data_start:data_end].hex())
            position = next_position
    if len(identities) != 1:
        raise ValueError('unsupported session executable')
    build_id = identities.pop()
    if machine != BASE_LAYOUT['machine']:
        raise ValueError('unsupported session executable')
    profile = PROFILES.get(build_id)
    if not profile:
        # Unrecognised build. Nothing here weakens the downstream checks: the
        # caller falls back to discovery, reads the vtable out of whatever
        # object it lands on, and every candidate still has to prove itself.
        return build_id, None
    stream.seek(0)
    total, sha = 0, hashlib.sha256()
    while block := stream.read(1024 * 1024):
        check()
        total += len(block)
        if total > 1024 * 1024 * 1024:
            raise ValueError('unsupported session executable')
        sha.update(block)
    if sha.hexdigest() != profile['sha256']:
        raise ValueError('unsupported session executable')
    return build_id, profile


def active_root(pid, home, proc=pathlib.Path('/proc')):
    roots = set()
    descriptors = list((proc / str(pid) / 'fd').iterdir())
    if len(descriptors) > 10000:
        raise ValueError('active account unavailable')
    for descriptor in descriptors:
        try:
            target = pathlib.Path(os.readlink(descriptor))
            if target.name not in ('contact.db', 'contact.db-wal'):
                continue
            target = target.resolve(strict=True)
            relative = target.relative_to(home)
            if len(relative.parts) >= 5 and relative.parts[-3:-1] == ('db_storage', 'contact'):
                roots.add(target.parent.parent)
        except (OSError, ValueError):
            continue
    if len(roots) != 1:
        raise ValueError('active account unavailable')
    return roots.pop()


class SessionIdentity:
    def __init__(self, pid, home, fd=3, check=lambda: None, hint=None):
        if not isinstance(pid, int) or pid <= 1 or not isinstance(fd, int) or fd < 0:
            raise ValueError('invalid session process')
        self.pid, self.fd, self.check = pid, fd, check
        self.home = pathlib.Path(home).resolve(strict=True)
        self.proc = pathlib.Path('/proc')
        self.manager = None
        self.maps = []
        self._validate_descriptor()
        before = self._stamp()
        with (self.proc / str(pid) / 'exe').open('rb') as executable:
            self.build_id, self.profile = elf_identity(executable, self.check)
        self.bound = self._stamp()
        if before != self.bound:
            raise ValueError('session process changed')
        if hint is not None:
            self._apply_hint(hint)

    def _hint_scope(self):
        return {'version': 1, 'pid': self.pid, 'processStart': self.bound[0],
                'buildId': self.build_id, 'rootKey': digest(self.bound[3]),
                'executableKey': digest(json.dumps(self.bound[1:3], separators=(',', ':')))}

    def _apply_hint(self, hint):
        """Hints arrive only over the existing trusted, private data-worker pipe.

        A hint avoids rediscovering an already unique manager; it never bypasses
        the subsequent live object/vector/account checks in current().
        """
        # An unknown build has no layout yet: the only way to get one is
        # discovery, which also yields the manager. Reusing a hinted address
        # here would leave _selection without offsets and fail every send.
        if self.profile is None:
            return
        if not isinstance(hint, dict) or set(hint) != set(self._hint_scope()) | {'manager', 'issuedAt'}:
            raise ValueError('session hint unavailable')
        if any(type(hint.get(key)) is not type(value) or hint[key] != value for key, value in self._hint_scope().items()):
            raise ValueError('session hint scope changed')
        now, issued = int(time.monotonic() * 1000), hint.get('issuedAt')
        if type(issued) is not int or not 0 <= now - issued <= HINT_AGE_MS:
            raise ValueError('session hint expired')
        address = hint.get('manager')
        if not isinstance(address, str) or not re.fullmatch(r'0x[0-9a-f]{1,16}', address):
            raise ValueError('session hint unavailable')
        manager = int(address, 16)
        if manager < 0x10000 or manager >= MAX_ADDRESS or manager % 8:
            raise ValueError('session hint unavailable')
        self.manager = manager

    def hint(self):
        self.current()
        return {**self._hint_scope(), 'manager': hex(self.manager),
                'issuedAt': int(time.monotonic() * 1000)}

    def _validate_descriptor(self):
        import fcntl
        if fcntl.fcntl(self.fd, fcntl.F_GETFL) & getattr(os, 'O_ACCMODE', 3) != os.O_RDONLY:
            raise ValueError('session memory must be read-only')
        if os.readlink(self.proc / 'self' / 'fd' / str(self.fd)) != f'/proc/{self.pid}/mem':
            raise ValueError('session memory process changed')

    def _stamp(self):
        self.check()
        process = self.proc / str(self.pid)
        fields = (process / 'stat').read_text().rsplit(')', 1)[-1].split()
        if len(fields) < 20 or not fields[19].isdigit():
            raise ValueError('session process unavailable')
        exe = process / 'exe'
        target = exe.resolve(strict=True)
        root = active_root(self.pid, self.home, self.proc)
        return fields[19], str(target), file_stamp(exe), str(root)

    def _context(self):
        self.check()
        if self._stamp() != self.bound:
            self.manager = None
            raise ValueError('session process or account changed')
        self._validate_descriptor()
        maps = []
        for line in (self.proc / str(self.pid) / 'maps').read_text().splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) < 5:
                raise ValueError('session mappings unavailable')
            start, end = (int(value, 16) for value in fields[0].split('-'))
            offset = int(fields[2], 16)
            if start >= MAX_ADDRESS and len(fields) > 5 and fields[5] == '[vsyscall]':
                continue
            if not 0 < start < end <= MAX_ADDRESS or maps and start < maps[-1][1]:
                raise ValueError('session mappings unavailable')
            maps.append((start, end, fields[1], offset, fields[5] if len(fields) > 5 else ''))
        if not maps or len(maps) > 10000:
            raise ValueError('session mappings unavailable')
        self.maps = maps
        bases = {start for start, end, permissions, offset, name in maps
                 if name == self.bound[1] and offset == 0 and 'r' in permissions}
        if len(bases) != 1:
            raise ValueError('session executable mapping unavailable')
        self.base = bases.pop()

    def _read(self, address, length):
        self.check()
        if not isinstance(address, int) or not isinstance(length, int) or not 0 < length <= 1024 * 1024:
            raise ValueError('session memory unavailable')
        if address < 0x10000 or address + length > MAX_ADDRESS:
            raise ValueError('session memory unavailable')
        end = address + length
        cursor = address
        for start, stop, permissions, offset, name in self.maps:
            if stop <= cursor:
                continue
            if start > cursor or 'r' not in permissions:
                break
            cursor = min(end, stop)
            if cursor == end:
                value = os.pread(self.fd, length, address)
                if len(value) != length:
                    break
                return value
        raise ValueError('session memory unavailable')

    def _pointer(self, address):
        value = struct.unpack('<Q', self._read(address, 8))[0]
        if value < 0x10000 or value >= MAX_ADDRESS or value % 8:
            raise ValueError('session pointer unavailable')
        return value

    def _string(self, address):
        header = self._read(address, 24)
        if header[0] & 1:
            capacity, length, pointer = struct.unpack('<QQQ', header)
            capacity &= ~1
            if not 0 < length <= 128 or not length < capacity <= 1024 * 1024:
                raise ValueError('session string unavailable')
            raw = self._read(pointer, length + 1)
        else:
            length = header[0] >> 1
            if not 0 < length <= 22:
                raise ValueError('session string unavailable')
            raw = header[1:length + 2]
        if raw[-1] != 0 or b'\0' in raw[:-1]:
            raise ValueError('session string unavailable')
        value = raw[:-1].decode('ascii')
        if not USERNAME.fullmatch(value) or self._read(address, 24) != header:
            raise ValueError('session string changed')
        return value, header, raw

    def _managers(self):
        # A known build keeps the whole-memory vtable search. An unknown one
        # cannot reuse that address, so it is located via its 'normal_key'.
        return self._scan_vtable() if self.profile else self._discover()

    def _scan_vtable(self):
        """Known build: search for the exact vtable pointer we have on file."""
        needle = struct.pack('<Q', self.base + self.profile['manager_vtable'])
        result, scanned = set(), 0
        for start, end, permissions, offset, name in self.maps:
            # Managers are heap/private writable allocations, never image data.
            if permissions != 'rw-p' or name not in ('', '[heap]'):
                continue
            scanned += end - start
            if scanned > MAX_SCAN:
                raise ValueError('session memory scan limit')
            cursor, tail = start, b''
            while cursor < end:
                self.check()
                length = min(1024 * 1024, end - cursor)
                chunk = tail + self._read(cursor, length)
                position = 0
                while (position := chunk.find(needle, position)) >= 0:
                    candidate = cursor - len(tail) + position
                    position += 1
                    if candidate % 8:
                        continue
                    try:
                        if self._string(candidate + self.profile['manager_key'])[0] == 'normal_key':
                            result.add(candidate)
                    except (ValueError, OSError, UnicodeError):
                        continue
                tail = chunk[-(len(needle) - 1):]
                cursor += length
        if len(result) != 1:
            raise ValueError('session manager ambiguous or unavailable')
        return result.pop()

    def _in_executable_image(self, pointer):
        # A vtable is read-only data, so it lands in the image's r--p segment
        # far more often than in its executable r-xp one. Belonging to this
        # exact binary is the constraint that matters; anything loose is then
        # rejected by the live structure checks in _selection.
        return any(start <= pointer < end and name == self.bound[1]
                   for start, end, permissions, offset, name in self.maps)

    def _discover(self):
        """Unknown build: find the manager through its 'normal_key' member.

        Only member offsets are assumed, from BASE_LAYOUT. The vtable is read
        back off the candidate itself, so a rebuilt binary keeps working while
        its classes are unchanged. Nothing is trusted blindly: each candidate
        still has to survive the full live structure check in _selection, and a
        single ambiguous result fails exactly like an unsupported build.
        """
        base = getattr(self, 'base', None)
        if not base:
            raise ValueError('session executable mapping unavailable')
        overlap = len(ANCHOR) - 1
        candidates, scanned = {}, 0
        for start, end, permissions, offset, name in self.maps:
            if permissions != 'rw-p' or name not in ('', '[heap]'):
                continue
            scanned += end - start
            if scanned > MAX_SCAN:
                raise ValueError('session memory scan limit')
            cursor, tail = start, b''
            while cursor < end:
                self.check()
                length = min(1024 * 1024, end - cursor)
                chunk = tail + self._read(cursor, length)
                position = 0
                while (position := chunk.find(ANCHOR, position)) >= 0:
                    found = cursor - len(tail) + position
                    position += 1
                    for manager_key in KEY_CANDIDATES:
                        manager = found - manager_key - 1
                        if manager % 8 or manager in candidates:
                            continue
                        try:
                            if not self._in_executable_image(self._pointer(manager)):
                                continue
                            if self._string(manager + manager_key)[0] != 'normal_key':
                                continue
                            profile = {**BASE_LAYOUT, 'manager_key': manager_key,
                                       'manager_vtable': self._pointer(manager) - base}
                            self._selection(manager, profile)
                        except (ValueError, OSError, UnicodeError):
                            continue
                        candidates[manager] = profile
                    if len(candidates) > MAX_CANDIDATES:
                        raise ValueError('session manager ambiguous or unavailable')
                tail = chunk[-overlap:] if overlap else b''
                cursor += length
        if len(candidates) != 1:
            raise ValueError('session manager ambiguous or unavailable')
        manager, self.profile = candidates.popitem()
        return manager

    def _selection(self, manager, profile=None):
        p = profile or self.profile
        if not p:
            raise ValueError('session profile unavailable')
        if self._pointer(manager) != self.base + p['manager_vtable']:
            raise ValueError('session manager changed')
        manager_key = self._string(manager + p['manager_key'])
        if manager_key[0] != 'normal_key':
            raise ValueError('session manager changed')
        controller = self._pointer(manager + p['controller'])
        inner = self._pointer(controller + p['inner'])
        current = struct.unpack('<Q', self._read(inner + p['current'], 8))[0]
        if current and (current < 0x10000 or current >= MAX_ADDRESS or current % 8):
            raise ValueError('session pointer unavailable')
        # The supported binary's unordered_map insertion at RVA 0x48f8992
        # reads size at map+0x18; bucket/first-node fields precede it. An empty
        # map is accepted only when its count and current selection are zero.
        map_header = self._read(inner + p['map'], 32)
        node = struct.unpack_from('<Q', map_header, p['map_first'])[0]
        map_size = struct.unpack_from('<Q', map_header, p['map_size'])[0]
        if not node:
            if current or map_size:
                raise ValueError('session vector unavailable')
            return (manager, controller, inner, current, manager_key, map_header, (), (None, b'', b''))
        if node < 0x10000 or node >= MAX_ADDRESS or node % 8 or not 0 < map_size <= 128:
            raise ValueError('session vector unavailable')
        seen, vectors = set(), []
        while node:
            if node in seen or len(seen) >= 128:
                raise ValueError('session vector unavailable')
            seen.add(node)
            node_key = self._string(node + p['node_key'])[0]
            if node_key == 'normal_key':
                begin = struct.unpack('<Q', self._read(node + p['vector_begin'], 8))[0]
                end = struct.unpack('<Q', self._read(node + p['vector_end'], 8))[0]
                if begin == end:
                    if current or begin and (begin < 0x10000 or begin >= MAX_ADDRESS or begin % 8
                                             or not any(start <= begin <= stop and 'r' in perms for start, stop, perms, _, _ in self.maps)):
                        raise ValueError('empty session vector has an invalid selection')
                    vectors.append((node, begin, end, b''))
                elif (not 0x10000 <= begin < end < MAX_ADDRESS or begin % 8 or end % 8
                      or (end - begin) % 16 or (end - begin) // 16 > MAX_VECTOR):
                    raise ValueError('session vector unavailable')
                else:
                    entries = self._read(begin, end - begin)
                    pointers = [struct.unpack_from('<Q', entries, offset)[0] for offset in range(0, len(entries), 16)]
                    if (len(set(pointers)) != len(pointers) or any(pointer < 0x10000 or pointer >= MAX_ADDRESS or pointer % 8 for pointer in pointers)
                            or current and pointers.count(current) != 1):
                        raise ValueError('selected session is not a unique live member')
                    vectors.append((node, begin, end, entries))
            node = struct.unpack('<Q', self._read(node, 8))[0]
            if node and (node < 0x10000 or node % 8 or node >= MAX_ADDRESS):
                raise ValueError('session vector unavailable')
        if len(vectors) != 1 or len(seen) != map_size:
            raise ValueError('session vector ambiguous or unavailable')
        username = self._string(current + p['username']) if current else (None, b'', b'')
        return (manager, controller, inner, current, manager_key, map_header, tuple(vectors), username)

    def current(self):
        started = time.monotonic()
        self._context()
        # The helper is short lived. Locate once; every subsequent guard rereads
        # the complete live pointer chain, vector and account/process identity.
        if self.manager is None or not self.profile:
            self.manager = self._managers()
        first = self._selection(self.manager)
        self._context()
        second = self._selection(self.manager)
        if first != second or self._stamp() != self.bound:
            self.manager = None
            raise ValueError('selected session changed')
        self.last_read_ms = round((time.monotonic() - started) * 1000, 3)
        return {'username': second[-1][0], 'root': self.bound[3],
                'processStart': self.bound[0], 'buildId': self.build_id}

    def matches(self, account, contact):
        if not isinstance(account, str) or not KEY.fullmatch(account) or not isinstance(contact, str) or not KEY.fullmatch(contact):
            raise ValueError('invalid session identity')
        value = self.current()
        directory = pathlib.Path(value['root']).parent.name
        candidates = {directory, re.sub(r'_[a-fA-F0-9]{4,}$', '', directory)}
        accounts = [name for name in candidates if SELF.fullmatch(name)
                    and digest('wechat-data-account\0' + name) == account]
        if len(accounts) != 1:
            raise ValueError('account-changed')
        return value['username'] is not None and digest('wechat-data-contact\0' + account + '\0' + value['username']) == contact

    def verify(self, account, contact):
        if not self.matches(account, contact):
            raise ValueError('selected contact changed')
        return {'account': account, 'contact': contact}
