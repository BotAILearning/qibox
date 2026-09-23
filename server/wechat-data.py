"""Private process-pipe API for the current instance's contacts and messages.

Reads only databases under the active profile, identified by this WeChat PID's
open files. Keys are discovered in the inherited read-only process descriptor
and are persisted only as an encrypted, HMAC-authenticated cache (mode 0600,
keystream derived from the instance ai-secret.key) so a WeChat restart does not
need to rescan the whole address space. Keys never cross stdout, logs or HTTP.
No window, clipboard or network calls.
"""
import ctypes as c
import bisect
from collections import OrderedDict
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import re
import signal
import struct
import sys
import time
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('qibox_sqlite', pathlib.Path(__file__).with_name('wechat-sqlite.py'))
sql = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sql)
image_spec = importlib.util.spec_from_file_location('qibox_images', pathlib.Path(__file__).with_name('wechat-images.py'))
images = importlib.util.module_from_spec(image_spec)
image_spec.loader.exec_module(images)
USER = re.compile(r'[A-Za-z][A-Za-z0-9_.-]{2,127}')
GROUP = re.compile(r'[A-Za-z0-9_-]{1,100}@chatroom')
SYSTEM = {'weixin', 'filehelper', 'newsapp', 'fmessage', 'medianote', 'floatbottle', 'qqmail', 'qqsafe',
          'shakeapp', 'feedsapp', 'brandsessionholder', 'weixinreminder', 'officialaccounts', 'notification_messages'}

# Upper bound for key discovery. WeChat maps several GiB of anonymous memory and
# a 2 GiB budget once missed keys that lived in later regions after a restart.
# The scan now walks only resident pages (see resident_segments), so the limit is
# a safety net for a pathological address space, not the tuning knob it used to
# be; the request deadline enforced through check() bounds real wall-clock time.
SCAN_LIMIT = 8 * 1024**3

# WeChat keeps a cached key only for the databases it has currently opened, and
# every database uses its own key (there is no shared master key to reuse across
# shards). A read asks for contact.db plus every message shard, so most of those
# keys are simply not in the process. Remembering the salts that were searched
# stops each poll from walking the whole address space again for them.
MISSING_KEY_TTL = 300.0
# Discovery is only worth a slice of the request deadline: a partial key set
# still reads the shards WeChat has open, while spending the whole deadline on
# the rest fails the read entirely and throws away the keys that were found.
KEY_SCAN_BUDGET = 12.0

# An automatic reply reasons about the newest readable messages only, so a plain
# read returns that many messages. Rows whose body cannot be decoded keep their
# place in the conversation but carry no text and do not consume the budget.
RECENT_REPLY_MESSAGES = 50
# How far a reply read may look back while filling that budget. It bounds the
# work spent on undecodable rows, not what the model is eventually shown.
RECENT_REPLY_SCAN = 300
# A range read is one globally ordered snapshot. Keep one extra metadata row so
# the caller can distinguish exactly 30,000 messages from a larger range.
RANGE_MAX_MESSAGES = 150000
# The worker's line protocol has a 12 MiB ceiling. Range reads are allowed to
# use that transport budget, with a small margin for the JSON envelope; plain
# reads continue to use their existing 80 KiB response budget below.
RANGE_OUTPUT_BYTES = 48 * 1024 * 1024


class ScanBudget(Exception):
    """Raised when key discovery used its own budget, not the request deadline."""


# Failures that describe the content itself rather than a momentary database
# state. They are reported through a stage and are not worth retrying.
# Every failure the reader can classify is mapped here. An unmapped reason used
# to reach the app with no stage at all, and the UI then showed the generic
# "暂时无法读取微信数据" message for anything from a missing database key to a
# contact that had simply left the address book. Each name below has a specific,
# actionable message on the app side.
FAILURE_STAGES = {'message too long': 'message-too-long', 'unsupported message type': 'message-type', 'unsupported latest incoming message': 'message-latest',
                  'invalid message XML': 'message-format', 'unsupported app message': 'message-format',
                  'invalid message text': 'message-format', 'unknown message sender': 'message-sender',
                  'message databases unavailable': 'message-database', 'invalid analysis range': 'analysis-range',
                  'chat messages not loaded': 'message-unloaded',
                  # Databases / keys: WeChat loads these on demand, so a missing
                  # key is a "not loaded yet" state, not a broken session.
                  'database key unavailable': 'key-unavailable', 'key scan limit': 'limit',
                  'unsupported encryption': 'encryption', 'database path changed': 'database-changed',
                  # Account / directory identity.
                  'active account unavailable': 'account-unavailable', 'account identity unavailable': 'account-unavailable',
                  'ambiguous account': 'account-unavailable', 'duplicate contact identity': 'contact-unavailable',
                  'unsupported contact label': 'contact-unavailable', 'contact unavailable': 'contact-unavailable',
                  # Layouts this build cannot read.
                  'unsupported message schema': 'schema', 'unsupported contacts schema': 'schema',
                  'unsupported message ordering schema': 'schema-ordering',
                  'unsupported sessions schema': 'schema', 'session database unavailable': 'key-unavailable',
                  'unsupported compression': 'message-format', 'invalid compressed message': 'message-format',
                  'message decompression failed': 'message-format', 'unsupported XML declaration': 'message-format',
                  # Content that cannot be attributed.
                  'conflicting message identity': 'identity', 'invalid message identity': 'identity',
                  'invalid action': 'request', 'request too large': 'request', 'invalid request': 'request'}

# Named but still retried. These mean "WeChat is writing right now": the request
# loop should try again, and only if every attempt fails does the app explain it.
TRANSIENT_STAGES = {'database changing': 'database-changed', 'WAL changing': 'database-changed',
                    'WAL commit changing': 'database-changed', 'database set changing': 'database-changed'}


def resident_segments(fd, address, size):
    """Split [address, address+size) into present physical-memory segments.

    Returns [(segment_address, segment_size)] for the pages that pagemap reports
    resident. With fd=None (pagemap unreadable) the whole range is treated as one
    resident segment. Entries are read in bulk so the overhead stays at a couple
    of syscalls per MiB. Skipping swapped-out pages keeps a full multi-GiB scan
    fast and avoids forcing WeChat's cold pages back into memory.
    """
    if fd is None:
        return [(address, size)]
    page = sql.PAGE
    first = address // page
    count = (address + size - 1) // page - first + 1
    try:
        os.lseek(fd, first * 8, os.SEEK_SET)
        raw = os.read(fd, count * 8)
    except OSError:
        return [(address, size)]
    if len(raw) < count * 8:
        return [(address, size)]
    segments, current = [], None
    for index in range(count):
        entry = struct.unpack('<Q', raw[index * 8:(index + 1) * 8])[0]
        if entry & (1 << 63):
            if current is None:
                current = (first + index) * page
        elif current is not None:
            segments.append((current, (first + index) * page - current))
            current = None
    if current is not None:
        segments.append((current, (first + count) * page - current))
    return segments


def keyspec_matches(block, pattern):
    """Yield the hex bodies of x'...' keyspecs without scanning the block with a regex.

    A regex pass over every resident MiB dominated discovery time. The quote is
    rare compared with the block size, so find it first and try one match there.
    """
    at = 0
    while True:
        at = block.find(b"'", at)
        if at < 0:
            return
        if at:
            match = pattern.match(block, at - 1)
            if match:
                yield match[1]
        at += 1


def _key_keystream(secret, salt, counter):
    return hmac.new(secret, b'qibox-wxkey-v1\x00' + salt + counter.to_bytes(4, 'big'), hashlib.sha256).digest()


def seal_key(secret, salt, key):
    """Encrypt one discovered WeChat key for the on-disk cache.

    Each entry derives its own one-time keystream from the instance ai-secret.key
    (HMAC-SHA256 counter mode), so reusing the file secret across entries never
    reuses a pad, and an HMAC authenticates the sealed entry. The strongest check
    remains the caller's sql.Cipher(key, salt).valid() against the database page.
    """
    stream = b''.join(_key_keystream(secret, salt, index) for index in range((len(key) + 31) // 32))
    sealed = bytes(value ^ stream[index % len(stream)] for index, value in enumerate(key))
    mac = hmac.new(secret, b'qibox-wxkey-v1\x00' + salt + sealed, hashlib.sha256).hexdigest()
    return {'salt': salt.hex(), 'key': sealed.hex(), 'mac': mac}


def open_key(secret, salt_hex, key_hex, mac_hex):
    """Decrypt a sealed cache entry; returns None when the MAC does not match."""
    try:
        salt = bytes.fromhex(salt_hex)
        sealed = bytes.fromhex(key_hex)
    except ValueError:
        return None
    expected = hmac.new(secret, b'qibox-wxkey-v1\x00' + salt + sealed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac_hex):
        return None
    stream = b''.join(_key_keystream(secret, salt, index) for index in range((len(sealed) + 31) // 32))
    return bytes(value ^ stream[index % len(stream)] for index, value in enumerate(sealed))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def contact_id(account, username):
    return digest('wechat-data-contact\0' + account + '\0' + username)


def new_session_reader(pid, home, check):
    # Optional send acceleration must not make contacts/history depend on a
    # supported native-session layout. Import only when the worker can warm it.
    spec = importlib.util.spec_from_file_location('qibox_wechat_session', pathlib.Path(__file__).with_name('wechat-session.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SessionIdentity(pid, home, fd=3, check=check)


def native_route(self_name, username):
    account = digest('wechat-account\0' + self_name)
    return {'account': account, 'contact': digest(account + '\0' + digest('wechat-contact\0' + username))}


def active_root(pid, home, proc=pathlib.Path('/proc')):
    home = pathlib.Path(home).resolve(strict=True)
    # The worker is a sibling of WeChat, so Linux Yama may allow it to open
    # the inherited memory descriptor but deny readlink(/proc/<wechat>/fd/*).
    # Each qibox instance has one xwechat_files account directory; use that
    # stable on-disk identity before falling back to the process-FD probe.
    candidates = set()
    for contact in (home / 'xwechat_files').glob('*/db_storage/contact/contact.db'):
        try:
            contact = contact.resolve(strict=True)
            relative = contact.relative_to(home)
            if len(relative.parts) >= 5 and relative.parts[-3:-1] == ('db_storage', 'contact'):
                candidates.add(contact.parent.parent)
        except (OSError, ValueError):
            continue
    if len(candidates) == 1:
        return candidates.pop()
    roots = set()
    for fd in (proc / str(pid) / 'fd').iterdir():
        try:
            target = pathlib.Path(os.readlink(fd))
            if target.name not in ('contact.db', 'contact.db-wal'):
                continue
            target = target.resolve(strict=True)
            relative = target.relative_to(home)
            if len(relative.parts) < 5 or relative.parts[-3:-1] != ('db_storage', 'contact'):
                continue
            roots.add(target.parent.parent)
        except (OSError, ValueError):
            continue
    if len(roots) != 1:
        raise ValueError('active account unavailable')
    return roots.pop()


def discover_keys(pid, memory, files, check, known=None):
    first_pages = {}
    for file in files:
        with file.open('rb') as stream:
            first = stream.read(sql.PAGE)
        if len(first) != sql.PAGE or first.startswith(sql.HEADER):
            raise ValueError('unsupported encryption')
        first_pages[first[:16]] = first
    # `known` is the working set and is updated in place, so a caller that passes
    # a dict keeps every key authenticated before a budget or deadline interrupt
    # instead of losing them along with the half-finished walk.
    keys = known if isinstance(known, dict) else {}
    scanned = 0
    pattern = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
    candidates = set()
    regions = []
    for line in pathlib.Path('/proc', str(pid), 'maps').read_text().splitlines():
        fields = line.split()
        if len(fields) < 2 or not fields[1].startswith('r'):
            continue
        start, end = (int(v, 16) for v in fields[0].split('-'))
        name = fields[5] if len(fields) > 5 else ''
        regions.append((start, end, fields[1], name))
    regions.sort()
    starts = [r[0] for r in regions]

    def read(address, size):
        check()
        index = bisect.bisect_right(starts, address) - 1
        if index < 0 or not regions[index][0] <= address < address + size <= regions[index][1]:
            return b''
        try:
            return os.pread(memory, size, address)
        except OSError:
            return b''

    def pointer(address):
        value = read(address, 8)
        return struct.unpack('<Q', value)[0] if len(value) == 8 else 0

    # WCDB's 64-bit SQLCipher context records the encryption parameters before
    # its salt/read/write pointers. Recent Linux builds encode the cached
    # keyspec, so searching only for a literal x'...' never finds their keys.
    # Locate by structure, validate every pointer and authenticate the result;
    # no executable offsets, version-specific mask or process writes are used.
    signature = struct.pack('<10I', 32, 16, 16, 4096, 99, 80, 64, 0, 2, 2)
    # Resident-page awareness: read /proc/<pid>/pagemap and pread only pages that
    # are actually present in physical memory. Skipping swapped-out ranges avoids
    # forcing WeChat's cold pages in and keeps a full multi-GiB scan within the
    # request deadline. When pagemap is unreadable, fall back to scanning every
    # page of the private regions.
    try:
        pagemap_fd = os.open(f'/proc/{pid}/pagemap', os.O_RDONLY)
    except OSError:
        pagemap_fd = None
    try:
        scan_regions = [r for r in regions if r[2].startswith('rw') and
                        (not r[3] or r[3] in ('[heap]', '[stack]') or r[3].startswith('[anon:'))]
        scan_regions.sort(key=lambda r: r[3] != '[heap]')
        for start, end, _, _ in scan_regions:
            tail = b''
            for offset in range(start, end, 1024 * 1024):
                check()
                size = min(1024 * 1024, end - offset)
                scanned += size
                if scanned > SCAN_LIMIT:
                    raise ValueError('key scan limit')
                for seg_addr, seg_size in resident_segments(pagemap_fd, offset, size):
                    try:
                        block = os.pread(memory, seg_size, seg_addr)
                    except OSError:
                        tail = b''
                        continue
                    combined, base = tail + block, seg_addr - len(tail)
                    at = combined.find(signature)
                    while at >= 0:
                        address = base + at
                        salt = read(pointer(address + 56), 16)
                        if salt in first_pages and salt not in keys:
                            for field in (88, 96):
                                context = pointer(address + field)
                                if not context:
                                    continue
                                raw = read(pointer(context + 8), 32)
                                if len(raw) == 32 and sql.Cipher(raw, salt).valid(first_pages[salt], 1):
                                    keys[salt] = raw
                                    break
                                blob = read(pointer(context + 32), 99)
                                key = decode_keyspec(blob, salt, first_pages[salt])
                                if key:
                                    keys[salt] = key
                                    break
                        if len(keys) == len(first_pages):
                            return keys
                        at = combined.find(signature, at + 1)
                    for match in keyspec_matches(combined, pattern):
                        if len(match) % 2:
                            continue
                        raw = bytes.fromhex(match.decode('ascii'))
                        key, salt = raw[:32], raw[-16:] if len(raw) >= 48 else None
                        if len(candidates) < 512:
                            candidates.add(key)
                        if salt in first_pages and salt not in keys and sql.Cipher(key, salt).valid(first_pages[salt], 1):
                            keys[salt] = key
                    tail = block[-200:]
                    if keys and len(keys) < len(first_pages):
                        # WeChat shares one key across its message shards. Authenticate
                        # every found key against the remaining salts inside the scan so
                        # a single discovered key completes the set immediately instead
                        # of scanning the whole address space.
                        for salt in [s for s in first_pages if s not in keys]:
                            for key in set(keys.values()):
                                if sql.Cipher(key, salt).valid(first_pages[salt], 1):
                                    keys[salt] = key
                                    break
                    if len(keys) == len(first_pages):
                        return keys
    finally:
        if pagemap_fd is not None:
            os.close(pagemap_fd)
    # Some WCDB builds cache raw keys without the salt or reuse a key across
    # shards. Authenticate against each missing database, never guess a key.
    for salt, page in first_pages.items():
        if salt in keys:
            continue
        for key in set(keys.values()) | candidates:
            check()
            if sql.Cipher(key, salt).valid(page, 1):
                keys[salt] = key
                break
    if not keys:
        raise ValueError('database key unavailable')
    # WeChat loads message shards on demand; shards the client has not opened
    # have no cached key in process memory. Return the keys that were found and
    # let execute() skip the unreadable shards instead of failing every read.
    return keys


def decode_keyspec(blob, salt, page):
    """Authenticate plain or repeating-XOR WCDB raw keyspecs, without caching.

    The final 32 hex characters encode the known database salt. They cover
    one full mask period; recovering it from this suffix avoids hard-coding
    compiler/platform machine-code masks. HMAC authentication is mandatory.
    """
    if len(blob) != 99 or len(salt) != 16:
        return None
    for suffix in (salt.hex().encode(), salt.hex().upper().encode()):
        mask = bytearray(32)
        for index, value in enumerate(suffix, 66):
            mask[index % 32] = blob[index] ^ value
        decoded = bytes(value ^ mask[index % 32] for index, value in enumerate(blob))
        if not re.fullmatch(rb"[xX]'[0-9a-fA-F]{96}'", decoded):
            continue
        key = bytes.fromhex(decoded[2:66].decode('ascii'))
        if sql.Cipher(key, salt).valid(page, 1):
            return key
    return None


def safe_file(root, file):
    resolved = file.resolve(strict=True)
    resolved.relative_to(root)
    if resolved != file or not resolved.is_file():
        raise ValueError('database path changed')
    return resolved


def optional_file(root, file):
    """Like safe_file, but a missing database is a soft condition, not a fault.

    The chat-list index lives in session.db, which older layouts or a fresh
    WeChat install may not have. Losing the index only costs the app its
    change-signal shortcut (it falls back to the old rotation); it must never
    make contacts or message reads fail.
    """
    try:
        return safe_file(root, file)
    except (ValueError, OSError):
        return None


def file_versions(files):
    result = []
    for file in files:
        for candidate in (file, pathlib.Path(str(file) + '-wal')):
            try:
                s = candidate.stat()
                result.append((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns))
            except FileNotFoundError:
                result.append(None)
        try:
            with pathlib.Path(str(file) + '-shm').open('rb') as stream:
                result.append(stream.read(96))
        except FileNotFoundError:
            result.append(None)
    return result


def check_versions(files, before):
    after = file_versions(files)
    if after == before:
        return
    # Replacement, disappearance or a new sidecar is a full invalidation.
    # Only content/commit changes of the exact same files can retain keys.
    if len(before) != len(after) or len(before) != len(files) * 3:
        raise ValueError('database set changing')
    for index in range(0, len(before), 3):
        for offset in (0, 1):
            old, new = before[index + offset], after[index + offset]
            if old is None and new is None:
                continue
            if old is None or new is None or old[:2] != new[:2]:
                raise ValueError('database path changed')
    raise sql.SnapshotChanged('database set changing')


def self_username(root, rows):
    directory = root.parent.name
    candidates = {directory, re.sub(r'_[a-fA-F0-9]{4,}$', '', directory)}
    matches = {row[0] for row in rows if row[0] in candidates and USER.fullmatch(row[0])}
    if len(matches) != 1:
        raise ValueError('account identity unavailable')
    return matches.pop()


def contacts(rows, username):
    account = digest('wechat-data-account\0' + username)
    own = [row for row in rows if row[0] == username]
    if len(own) != 1:
        raise ValueError('ambiguous account')
    own_alias = own[0][3] or username
    result, seen = [], set()
    for name, nickname, remark, alias in rows:
        if not isinstance(name, str) or not (USER.fullmatch(name) or GROUP.fullmatch(name)) or name == username or name in SYSTEM or name.startswith('gh_'):
            continue
        if name in seen:
            raise ValueError('duplicate contact identity')
        seen.add(name)
        group = bool(GROUP.fullmatch(name))
        # A deleted or left group chat can keep a contact row whose nickname
        # and remark are both empty; the raw chatroom id is not a display
        # name, so drop those entries instead of listing unknown groups.
        if group and not (nickname or '').strip() and not (remark or '').strip():
            continue
        label = (remark or nickname or name).strip()
        if not label or len(label) > 120 or re.search(r'[\x00-\x1f\x7f]', label):
            raise ValueError('unsupported contact label')
        # The WeChat nickname is carried alongside the label so the interface can
        # tell apart contacts sharing one remark. Anything unprintable or overly
        # long is dropped rather than surfaced, the label stays authoritative.
        display_nickname = nickname.strip() if isinstance(nickname, str) else ''
        if len(display_nickname) > 120 or re.search(r'[\x00-\x1f\x7f]', display_nickname):
            display_nickname = ''
        route = native_route(own_alias, name if GROUP.fullmatch(name) else alias or name)
        result.append({'id': contact_id(account, name), 'label': label, 'nickname': display_nickname, 'kind': 'group' if group else 'person', 'username': name, 'native': route})
    return account, result


def decode(content, compression):
    if compression not in (None, 0, 4):
        raise ValueError('unsupported compression')
    if compression == 4:
        if not isinstance(content, bytes) or len(content) > 1024 * 1024:
            raise ValueError('invalid compressed message')
        api = c.CDLL('libzstd.so.1')
        api.ZSTD_decompress.argtypes = [c.c_void_p, c.c_size_t, c.c_void_p, c.c_size_t]
        api.ZSTD_decompress.restype = c.c_size_t
        api.ZSTD_isError.argtypes, api.ZSTD_isError.restype = [c.c_size_t], c.c_uint
        output = c.create_string_buffer(1024 * 1024)
        length = api.ZSTD_decompress(output, len(output), content, len(content))
        if api.ZSTD_isError(length) or length > len(output):
            raise ValueError('message decompression failed')
        content = output.raw[:length]
    if isinstance(content, bytes):
        content = content.decode('utf8')
    if not isinstance(content, str) or len(content) > 1024 * 1024 or '\0' in content:
        raise ValueError('invalid message text')
    return content


def message_text(content, kind):
    if kind == 1:
        return content
    placeholders = {3: '[图片]', 34: '[语音]', 43: '[视频]', 47: '[表情]', 48: '[位置]', 50: '[通话]', 42: '[名片]'}
    if kind in placeholders:
        return placeholders[kind]
    if kind not in (49, 10000, 10002):
        raise ValueError('unsupported message type')
    if not content.lstrip().startswith('<'):
        if kind in (10000, 10002):
            return content
        raise ValueError('invalid message XML')
    if re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I):
        raise ValueError('unsupported XML declaration')
    root = ET.fromstring(content)
    if kind in (10000, 10002):
        return ''.join(root.itertext()).strip()
    app = root if root.tag == 'appmsg' else root.find('appmsg')
    if app is None:
        raise ValueError('unsupported app message')
    subtype = app.findtext('type', '')
    title = app.findtext('title', '').strip()
    if subtype == '57':
        # Only the newly authored reply; quoted XML never changes its sender.
        return title
    return {'6': '[文件]', '19': '[合并转发]', '2000': '[转账]', '2001': '[红包]'}.get(subtype, '[链接]') + (' ' + title if title else '')


def group_mentions(source, self_name):
    unknown = {'verified': False, 'self': False, 'all': False, 'others': False}
    try:
        if source in ('', None):
            return {**unknown, 'verified': True}
        if not isinstance(source, str) or re.search(r'<!\s*(DOCTYPE|ENTITY)', source, re.I): return unknown
        root = ET.fromstring(source)
        if root.tag != 'msgsource': return unknown
        tags = root.findall('atuserlist')
        if len(tags) > 1: return unknown
        names = [x.strip() for x in (tags[0].text or '').split(',') if x.strip()] if tags else []
        if any(not USER.fullmatch(x) and x != 'notify@all' for x in names): return unknown
        return {'verified': True, 'self': self_name in names, 'all': 'notify@all' in names,
                'others': any(x not in (self_name, 'notify@all') for x in names)}
    except (ValueError, ET.ParseError): return unknown


def messages(db, shard, account, contact, self_name, target, selected=None, metadata=False, bounds=None, skip_unparsed=False):
    table = 'Msg_' + hashlib.md5(target.encode()).hexdigest()
    if not db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)):
        return []
    senders = dict(db.query('SELECT rowid, user_name FROM Name2Id'))
    columns = {row[1] for row in db.query(f'PRAGMA table_info([{table}])')}
    required = {'local_id', 'local_type', 'create_time', 'real_sender_id', 'message_content'}
    if not required <= columns:
        raise ValueError('unsupported message schema')
    compression = 'WCDB_CT_message_content' if 'WCDB_CT_message_content' in columns else '0'
    server_id = 'server_id' if 'server_id' in columns else '0'
    sequence = 'COALESCE(sort_seq, local_id)' if 'sort_seq' in columns else 'local_id'
    group = bool(GROUP.fullmatch(target))
    source = 'source' if 'source' in columns else 'NULL'
    source_compression = 'WCDB_CT_source' if 'WCDB_CT_source' in columns else '0'
    shard_number = int(re.fullmatch(r'message_(\d+)\.db', shard)[1])
    conditions, params = [], []
    if selected is not None:
        if not selected: return []
        conditions.append('local_id IN (' + ','.join('?' for _ in selected) + ')')
        params.extend(selected)
    if bounds:
        conditions.extend(['create_time >= ?', 'create_time < ?']); params.extend(bounds)
    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    direction = 'ASC' if bounds else 'DESC'
    order_by = f' ORDER BY create_time {direction}, {sequence} {direction}, local_id {direction}'
    if metadata:
        limit = RANGE_MAX_MESSAGES + 1 if bounds else 301
        rows = db.query(f'SELECT local_id, {server_id}, create_time, {sequence} FROM [{table}]' + where + order_by + f' LIMIT {limit}', tuple(params))
        return [{'local': local, 'shard': shard, '_order': (timestamp, order, shard_number, local),
                 '_dedup': f'server:{remote}' if remote else f'local:{shard}:{local}'} for local, remote, timestamp, order in rows]
    limit = RANGE_MAX_MESSAGES + 1 if bounds else 301
    rows = db.query(f'SELECT local_id, local_type, create_time, real_sender_id, message_content, {compression}, {server_id}, {sequence}, {source}, {source_compression} '
                    f'FROM [{table}]' + where + order_by + f' LIMIT {limit}', tuple(params))
    result = []
    shard_number = int(re.fullmatch(r'message_(\d+)\.db', shard)[1])
    for local, raw_type, timestamp, sender, content, compressed, remote, order, source, source_compressed in rows:
        if not all(isinstance(v, int) for v in (local, raw_type, timestamp, order)) or local < 1 or timestamp < 0:
            raise ValueError('invalid message identity')
        kind = raw_type & 0xffffffff
        sender_name = senders.get(sender)
        known_other = sender_name == target or group and isinstance(sender_name, str) and USER.fullmatch(sender_name)
        # A group can retain historical rows after a member leaves or while
        # Name2Id is catching up with the local database. Keep that row
        # addressable, but never let an unresolved sender become a reply
        # trigger or be mistaken for the logged-in account.
        direction = 'system' if kind in (10000, 10002) else ('self' if sender_name == self_name else 'other' if known_other else 'system' if group else None)
        parsed, unparsable, text_truncated = True, False, False
        try:
            if direction is None:
                raise ValueError('unknown message sender')
            content = decode(content, compressed)
            if group and sender_name and content.startswith(sender_name + ':\n'): content = content[len(sender_name) + 2:]
            text = message_text(content, kind)
            if len(text) > 150000:
                text = text[:150000]
                text_truncated = True
            if kind == 3: image_ref = images.image_reference(content)
        except (ValueError, ET.ParseError):
            # An unreadable body keeps its identity and ordering so pagination
            # and the second snapshot stay verifiable. It no longer aborts the
            # whole read: one old undecodable row used to disable a contact for
            # good, because every later retry hit the same row again. The caller
            # rejects only an unreadable newest incoming message, which is the
            # one case an automatic reply must never be guessed about.
            text, parsed, unparsable = '', False, True
            # Preserve pagination identity but never guess who wrote a message.
            if direction is None: direction = 'system'
        # The local identity does not change when an outgoing row receives its
        # server acknowledgement. Otherwise a late ack resembles a manual reply.
        identity = f'local:{shard}:{local}'
        result.append({'id': digest(account + '\0' + contact + '\0' + identity), 'direction': direction,
                       'text': text, 'timestamp': timestamp, '_order': (timestamp, order, shard_number, local),
                       '_dedup': f'server:{remote}' if remote else identity})
        if unparsable: result[-1]['_unparsable'] = True
        if text_truncated: result[-1]['_text_truncated'] = True
        if kind == 3 and parsed:
            result[-1]['type'] = 'image'
            result[-1]['_image'] = image_ref
        if kind == 34:
            result[-1]['type'] = 'voice'
        if group:
            try: mentions = group_mentions(decode(source, source_compressed) if source is not None else None, self_name) if 'source' in columns else {'verified': False, 'self': False, 'all': False, 'others': False}
            except ValueError: mentions = {'verified': False, 'self': False, 'all': False, 'others': False}
            sender_key = sender_name or f'unknown:{sender}'
            if direction == 'system' and sender_name is None: mentions = {'verified': False, 'self': False, 'all': False, 'others': False}
            result[-1].update({'sender': digest(account + '\0' + contact + '\0' + sender_key), 'mentions': mentions})
    return result


class SessionCache:
    """Process-scoped cache for keys, read snapshots and the session reader.

    Keys survive WeChat restarts through an encrypted on-disk cache next to the
    instance ai-secret.key (mode 0600). Loading verifies every entry's HMAC and
    the caller re-authenticates each key against the live database page, so a
    stale or foreign entry is simply discarded and rediscovered.
    """
    def __init__(self, home=None):
        self.scope = None
        self.keys = {}
        self.sealed = {}
        self.missing = {}
        self.snapshots = OrderedDict()
        self.session_reader = None
        self.cache_path = None
        self.cache_secret = None
        if home is not None:
            self._init_persistent_cache(home)

    def _init_persistent_cache(self, home):
        try:
            root = pathlib.Path(home).resolve().parent
            secret_file = root / 'ai-secret.key'
            if not secret_file.is_file():
                return
            secret = secret_file.read_bytes()
            if len(secret) != 32:
                return
            self.cache_secret = secret
            self.cache_path = root / 'wechat-keys.json'
            data = json.loads(self.cache_path.read_text('utf-8'))
            entries = data.get('sealed', []) if isinstance(data, dict) else []
            if not isinstance(entries, list):
                return
            loaded = {}
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                key = open_key(secret, entry.get('salt', ''), entry.get('key', ''), entry.get('mac', ''))
                if key is not None:
                    loaded[bytes.fromhex(entry['salt'])] = key
            if loaded:
                self.keys = loaded
                # Kept apart from self.keys so a WeChat restart (which clears the
                # in-memory set) still starts from everything ever discovered.
                self.sealed = dict(loaded)
        except (ValueError, OSError, KeyError):
            pass  # Missing or damaged cache falls back to a full discovery scan.

    def _save_persistent_cache(self):
        if self.cache_secret is None or self.cache_path is None:
            return
        try:
            entries = [seal_key(self.cache_secret, salt, key) for salt, key in self.keys.items()]
            temporary = self.cache_path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'v': 1, 'sealed': entries}, ensure_ascii=False), 'utf-8')
            os.chmod(temporary, 0o600)
            temporary.replace(self.cache_path)
            # Keep the in-memory baseline in step with the file so clearing the
            # cache after a failed read cannot drop a key that was just found.
            self.sealed = dict(self.keys)
        except (ValueError, OSError):
            pass  # A failed cache write never fails the current read.

    def clear(self):
        self.scope = None
        # A key belongs to the database file, not to the WeChat process, so the
        # encrypted cache stays available across restarts. Everything is
        # re-authenticated against the live page before it is used again.
        self.keys = dict(self.sealed)
        self.snapshots.clear()
        self.session_reader = None

    def invalidate(self, error):
        if isinstance(error, sql.SnapshotChanged):
            # Drop all results so the next attempt must reauthenticate current
            # pages. Keys and the independently revalidated session stay in RAM.
            self.snapshots.clear()
        else:
            self.clear()

    def bind(self, pid, root):
        scope = (pid, str(root))
        if self.scope != scope:
            self.clear()
            # A new WeChat process can hold keys for different shards, so the
            # "searched and absent" notes only apply to the process we walked.
            self.missing.clear()
            self.scope = scope

    def authenticated_keys(self, pid, files, check, required=()):
        """Return the keys usable right now, discovering what is still missing.

        `required` lists databases a request cannot proceed without. Their salts
        are never rested on the "searched and absent" TTL: WeChat loads message
        shards on demand, so that short-cut is right for shards but wrong for
        contact.db, where one failed search used to fail every read for five
        minutes straight.
        """
        result, missing = {}, []
        required = set(required)
        now = time.monotonic()
        for file in files:
            check()
            with file.open('rb') as stream:
                page = stream.read(sql.PAGE)
            salt = page[:16]
            key = self.keys.get(salt)
            if len(page) == sql.PAGE and key and sql.Cipher(key, salt).valid(page, 1):
                result[salt] = key
            elif file not in required and self.missing.get(salt, 0) > now:
                # Already searched within the TTL and absent from the process:
                # do not pay for another full scan on this request.
                continue
            else:
                missing.append(file)
        if missing:
            # Reuse the already authenticated keys as the starting set: WeChat
            # loads message shards on demand, so keys for shards the client has
            # not opened are simply absent from process memory. A partial set
            # must not fail the whole request, and any shared key still unlocks
            # the remaining shards through discover_keys' cross-salt check.
            result.update(self._discover(pid, missing, check, result))
        if result:
            self.keys.update(result)
            # Persist newly authenticated keys so a later WeChat restart can read
            # the databases without rescanning the process address space.
            self._save_persistent_cache()
        # Bound old shards retained after compaction or database rotation.
        if len(self.keys) > 256:
            self.keys = dict(result)
        return result

    def _discover(self, pid, files, check, known):
        """Scan for missing keys inside their own budget.

        Most shards have no key anywhere in memory, so an unbounded search used
        the whole request deadline and then failed the read. Bounded, it returns
        whatever it found and records the salts it searched, so later reads skip
        straight to the shards WeChat actually has open. A request deadline is a
        TimeoutError and still propagates; only the local budget is caught here.
        """
        deadline = time.monotonic() + KEY_SCAN_BUDGET

        def scoped():
            check()
            if time.monotonic() > deadline:
                raise ScanBudget('key scan budget')

        # Discovery authenticates into this dict, which is also the result, so
        # keys found before the budget runs out are kept. Returning only the
        # starting set used to throw away real keys, making the next request pay
        # for the same scan again and often time out instead.
        sink = dict(known)
        found = sink
        complete = True
        try:
            found = discover_keys(pid, 3, files, scoped, sink)
        except ScanBudget:
            # The walk stopped early, so the unvisited tail may still hold a
            # key. Only a finished search is allowed to rest for the full TTL.
            complete = False
        finally:
            now = time.monotonic()
            ttl = MISSING_KEY_TTL if complete else min(MISSING_KEY_TTL, 30.0)
            for file in files:
                try:
                    with file.open('rb') as stream:
                        salt = stream.read(16)
                except OSError:
                    continue
                if salt in found:
                    self.missing.pop(salt, None)
                else:
                    self.missing[salt] = now + ttl
        return found

    def session_hint(self, pid, home, check):
        try:
            check()
            if self.session_reader is None:
                self.session_reader = new_session_reader(pid, home, check)
            # Request deadlines/cancellation belong to the current request.
            self.session_reader.check = check
            hint = self.session_reader.hint()
            check()
            return hint
        except SoftCancel:
            # A cancelled request says nothing about the session found so far:
            # rebuilding it costs seconds on the very next read.
            raise
        except TimeoutError:
            self.session_reader = None
            raise
        except (ValueError, OSError, UnicodeError, ImportError):
            self.session_reader = None
            check()  # Never suppress cancellation while warming optional data.
            return None

    def remember(self, identity, versions, result):
        self.snapshots[identity] = (versions, result)
        self.snapshots.move_to_end(identity)
        while len(self.snapshots) > 16:
            self.snapshots.popitem(last=False)


def contact_activity(database, files, people):
    targets = {'Msg_' + hashlib.md5(p['username'].encode()).hexdigest(): p for p in people}
    for index, person in enumerate(people):
        person['contactOrder'], person['lastChatAt'] = index, None
    for file in files:
        shard = database(file)
        try:
            tables = {row[0] for row in shard.query("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in tables & targets.keys():
                columns = {row[1] for row in shard.query(f'PRAGMA table_info([{table}])')}
                if 'create_time' not in columns:
                    raise ValueError('unsupported message ordering schema')
                rows = shard.query(f'SELECT MAX(create_time) FROM [{table}]')
                latest = rows[0][0] if rows else None
                if isinstance(latest, int) and latest > 0:
                    person = targets[table]
                    person['lastChatAt'] = max(person['lastChatAt'] or 0, latest)
        finally:
            shard.close()



def utf16_length(value):
    return len(value.encode('utf-16-le')) // 2


def session_activity(database, file, people):
    """WeChat's own chat list, used as a new-message index.

    SessionTable is one small table holding a row per conversation with its
    unread count and the local id of its newest message. Reading it costs a
    fraction of a chat read and needs no message shard at all, so the app can
    ask "which object changed" on every tick instead of reading a fixed few
    objects on a blind rotation.

    Only the record id and bounded numbers leave this function. Labels,
    summaries, drafts, raw usernames and message bodies never do: the index is
    a change signal for objects the app already knows, not a message store.
    """
    known = {p['username']: p['id'] for p in people}
    db = database(file)
    if db is None:
        raise ValueError('session database unavailable')
    try:
        columns = {row[1] for row in db.query('PRAGMA table_info(SessionTable)')}
        if not {'username', 'unread_count', 'sort_timestamp', 'last_msg_locald_id'} <= columns:
            raise ValueError('unsupported sessions schema')
        hidden = 'is_hidden' if 'is_hidden' in columns else '0'
        # Only the newest conversations plus every unread one are needed: a new
        # message always moves that conversation to the newest end of
        # sort_timestamp, so nothing outside this window can have changed.
        window = ' WHERE unread_count > 0 OR sort_timestamp >= (SELECT MIN(sort_timestamp) FROM (SELECT sort_timestamp FROM SessionTable ORDER BY sort_timestamp DESC LIMIT 500)) LIMIT 2000'
        rows = db.query('SELECT username, unread_count, sort_timestamp, last_msg_locald_id, ' + hidden + ' FROM SessionTable' + window)
    finally:
        db.close()

    def bounded(value, limit):
        return value if type(value) is int and 0 <= value <= limit else 0

    result = []
    for username, unread, sort_timestamp, local_id, is_hidden in rows:
        ident = known.get(username)
        if ident is None:
            continue
        result.append({'id': ident, 'unread': bounded(unread, 1000000),
                       'at': bounded(sort_timestamp, 9999999999),
                       'last': bounded(local_id, 2 ** 53 - 1),
                       'hidden': 1 if is_hidden else 0})
    return result


def read_bounds(request):
    if request.get('action') != 'read-range': return None, None
    start, end = request.get('from'), request.get('to')
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= 9999999999:
        raise ValueError('invalid analysis range')
    return (start, end), None

def execute(request, pid, home, check, cache=None):
    bounds, _ = read_bounds(request)
    root = active_root(pid, home)
    contact_file = safe_file(root, root / 'contact' / 'contact.db')
    # WeChat's own chat list lives in one small database next to contact.db and
    # needs no message shard, so the index costs almost nothing to refresh.
    # It is optional: a layout without it must not break contacts/message reads.
    session_file = optional_file(root, root / 'session' / 'session.db')
    files = [contact_file]
    # Refreshing the contact directory only needs contact.db.  Do not make it
    # depend on every message shard: WeChat can be writing/rotating one of
    # those databases while the account is already logged in, and a broken or
    # newer message schema must not make the address book unreadable.
    # 'keys' asks for the same databases as 'read' but only authenticates and
    # persists them. It lets a warm-up pay for the cold scan while the instance
    # idles, so the following reads no longer carry a full address-space walk.
    if request.get('action') == 'sessions':
        # The index reads one small table, never a message shard. A missing
        # index is a soft failure: the app falls back to the old rotation.
        if session_file is None:
            raise ValueError('session database unavailable')
        files.append(session_file)
    elif request.get('action') in ('read', 'read-range', 'read-dates', 'read-image', 'keys'):
        files += sorted(safe_file(root, p) for p in (root / 'message').glob('message_*.db') if re.fullmatch(r'message_\d+\.db', p.name))
        if (request.get('action') in ('read', 'read-range', 'read-dates', 'read-image', 'keys') and len(files) < 2) or len(files) > 129:
            raise ValueError('message databases unavailable')
        if request.get('action') == 'keys':
            # The idle warm-up authenticates the chat-list index too, so the
            # first 'sessions' tick after a cold start adds no scan of its own.
            if session_file is not None:
                files.append(session_file)
    elif request.get('action') not in ('identity', 'contacts'):
        raise ValueError('invalid action')
    if cache is not None:
        cache.bind(pid, root)
        # Message reads warm the live identity and refresh the short-lived hint;
        # neither addresses nor usernames
        # enter saved configuration, logs, or the public history snapshot.
        # Analysis/calendar/contact reads do not navigate or send; discovering a
        # native UI session here can consume the whole data deadline needlessly.
        # 'read' needs the hint for the reply it returns; 'keys' is the idle
        # warm-up and builds the same reader in advance, so the user's first
        # "核对" no longer pays for the cold session-manager walk.
        session_hint = cache.session_hint(pid, home, check) if request.get('action') in ('read', 'keys') else None
    else:
        session_hint = None
    # A cold native-session scan can take seconds and does not read chat data.
    # Exclude that work from the interval requiring stable DB/WAL versions.
    versions = file_versions(files)
    cache_key = (request.get('action'), request.get('account'), request.get('contact'), request.get('messageId'), request.get('skipUnparsed') is True, bounds, tuple(str(f) for f in files))
    if cache is not None:
        previous = cache.snapshots.get(cache_key)
        # An empty message list is never trusted from cache: WeChat loads message
        # shards on demand, so an earlier read could have skipped every shard and
        # cached "no messages" while real history exists. Re-read instead.
        if previous and request['action'] != 'read-range' and previous[0] == versions and not (request['action'] in ('read', 'read-range') and not previous[1].get('messages')):
            # A cache hit still checks the live process's open account, all DB,
            # WAL and published-commit fingerprints, before and after lookup.
            if active_root(pid, home) != root:
                cache.clear()
                return {'error': 'account-changed'}
            check()
            check_versions(files, versions)
            cache.snapshots.move_to_end(cache_key)
            return {**previous[1], **({'sessionHint': session_hint} if request['action'] == 'read' else {})}
    # contact.db authenticates the account and the address book: without its key
    # there is no read at all, so it is never skipped as "already searched".
    keys = cache.authenticated_keys(pid, files, check, required=(contact_file,)) if cache is not None else discover_keys(pid, 3, files, check)
    def database(file):
        with file.open('rb') as stream:
            salt = stream.read(16)
        if salt not in keys:
            return None
        return sql.Database(sql.Pages(file, keys[salt], check))
    db = database(contact_file)
    if db is None:
        raise ValueError('database key unavailable')
    try:
        columns = {row[1] for row in db.query('PRAGMA table_info(contact)')}
        if not {'username', 'nick_name', 'remark', 'alias', 'local_type'} <= columns:
            raise ValueError('unsupported contacts schema')
        # Only actual friends belong in AI's personal-contact picker. Other
        # local types include system/service entries and cached group members.
        active = ' AND COALESCE(delete_flag, 0) = 0' if 'delete_flag' in columns else ''
        groups = " OR (local_type = 2 AND username LIKE '%@chatroom' AND is_in_chat_room = 1)" if 'is_in_chat_room' in columns else ''
        order = "COALESCE(NULLIF(remark_quan_pin,''), NULLIF(quan_pin,''), NULLIF(remark,''), NULLIF(nick_name,''), username) COLLATE NOCASE, username" if {'remark_quan_pin', 'quan_pin'} <= columns else "COALESCE(NULLIF(remark,''), NULLIF(nick_name,''), username) COLLATE NOCASE, username"
        rows = db.query('SELECT username, nick_name, remark, alias FROM contact WHERE (local_type = 1' + groups + ')' + active + ' ORDER BY ' + order)
        self_name = self_username(root, rows)
        account, people = contacts(rows, self_name)
        if request.get('account') and request['account'] != account:
            if cache is not None: cache.clear()
            return {'error': 'account-changed'}
        if request['action'] in ('contacts', 'identity', 'keys'):
            result = {'available': True, 'account': account, 'contacts': [{k: v for k, v in p.items() if k != 'username'} for p in people]}
        elif request['action'] == 'sessions':
            result = {'available': True, 'account': account, 'sessions': session_activity(database, session_file, people)}
        else:
            matches = [p for p in people if p['id'] == request.get('contact')]
            if len(matches) != 1:
                raise ValueError('contact unavailable')
            target, candidates = matches[0], {}
            if request['action'] == 'read-dates':
                days = set()
                table = 'Msg_' + hashlib.md5(target['username'].encode()).hexdigest()
                for file in files[1:]:
                    shard = database(file)
                    if shard is None:
                        continue
                    try:
                        if shard.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)):
                            for (day,) in shard.query(f'SELECT DISTINCT CAST((create_time + 28800) / 86400 AS INTEGER) FROM [{table}] WHERE create_time >= 0'):
                                if type(day) is int and 0 <= day <= 120000: days.add(day)
                    finally: shard.close()
                result = {'account': account, 'contact': target['id'], 'days': sorted(days)}
            else:
                # Select globally by metadata before decoding bodies. Irrelevant old
                # shards cannot fail a recent read or introduce out-of-range text.
                skipped_shards = 0
                for file in files[1:]:
                    shard = database(file)
                    if shard is None:
                        skipped_shards += 1
                        continue
                    try:
                        rows = messages(shard, file.name, account, target['id'], self_name, target['username'], metadata=True, bounds=bounds)
                        for row in rows: candidates.setdefault(row['_dedup'], []).append(row)
                        ordered_keys = sorted(candidates, key=lambda key: min(x['_order'] for x in candidates[key]))
                        keep = ordered_keys[:RANGE_MAX_MESSAGES + 1] if bounds else ordered_keys[-RECENT_REPLY_SCAN:]
                        candidates = {key: candidates[key] for key in keep}
                    finally: shard.close()
                check_versions(files, versions)
                metadata_more = bool(bounds and len(candidates) > RANGE_MAX_MESSAGES)
                if metadata_more:
                    keep = sorted(candidates, key=lambda key: min(x['_order'] for x in candidates[key]))[:RANGE_MAX_MESSAGES + 1]
                    candidates = {key: candidates[key] for key in keep}
                unique = {}
                skip_unparsed = request.get('action') == 'read-range'
                for file in files[1:]:
                    selected = [row['local'] for group in candidates.values() for row in group if row['shard'] == file.name]
                    if not selected: continue
                    shard = database(file)
                    if shard is None:
                        continue
                    try:
                        # An unknown WeChat message kind must not abort the read
                        # any more: messages() keeps its identity/order and emits
                        # an empty text placeholder for the unreadable body. A
                        # strict recent read then rejects only the case that an
                        # automatic reply must never guess about - an unreadable
                        # newest incoming message.
                        for message in messages(shard, file.name, account, target['id'], self_name, target['username'], selected=selected, bounds=bounds, skip_unparsed=skip_unparsed):
                            old = unique.get(message['_dedup'])
                            if old and any(old[k] != message[k] for k in ('direction', 'text', 'timestamp')): raise ValueError('conflicting message identity')
                            if old is None or message['_order'] < old['_order']: unique[message['_dedup']] = message
                    finally: shard.close()
                ordered = sorted(unique.values(), key=lambda m: m['_order'])
                if not skip_unparsed:
                    # Automatic-reply decisions must never consume incomplete
                    # data, but only the newest incoming message is what a reply
                    # would answer. Older unreadable rows stay as placeholders so
                    # a single undecodable old message cannot disable a contact.
                    incoming = [m for m in ordered if m['direction'] == 'other']
                    if incoming and incoming[-1].get('_unparsable'):
                        raise ValueError('unsupported latest incoming message')
                recent, size, truncated = [], 2, False
                truncated_reasons = set()
                iterable = ordered if bounds else reversed(ordered)
                # A range is one globally ordered response. A plain read answers
                # one reply and stops after that many readable messages.
                limit = RANGE_MAX_MESSAGES if bounds else RECENT_REPLY_MESSAGES
                def absorb(public, length, order):
                    """Append one message, or report that this response is full."""
                    nonlocal size, truncated
                    budget = RANGE_OUTPUT_BYTES if bounds else 80000
                    if size + length > budget and recent:
                        if bounds:
                            truncated = True
                            truncated_reasons.add('output_bytes')
                        return False
                    if size + length > budget:
                        if bounds:
                            truncated = True
                            truncated_reasons.add('output_bytes')
                            return False
                        # A single message larger than a whole page: truncate its
                        # text so the plain read continues instead of failing.
                        text = public.get('text')
                        if not isinstance(text, str) or not text: return False
                        lo, hi = 1, len(text)
                        while lo < hi:
                            mid = (lo + hi + 1) // 2
                            if utf16_length(json.dumps({**public, 'text': text[:mid]}, ensure_ascii=False, separators=(',', ':'))) + 1 <= 80000: lo = mid
                            else: hi = mid - 1
                        public = {**public, 'text': text[:lo]}
                        length = utf16_length(json.dumps(public, ensure_ascii=False, separators=(',', ':'))) + 1
                        if size + length > 80000: return False
                        truncated = True
                    recent.append(public); size += length
                    return True
                counted = 0
                for message in iterable:
                    public = {k: v for k, v in message.items() if not k.startswith('_')}
                    if bounds and message.get('_text_truncated'):
                        truncated = True
                        truncated_reasons.add('message_length')
                    if bounds and isinstance(public.get('text'), str) and len(public['text']) > 150000:
                        public = {**public, 'text': public['text'][:150000]}
                        truncated = True
                        truncated_reasons.add('message_length')
                    encoded = json.dumps(public, ensure_ascii=False, separators=(',', ':'))
                    length = len(encoded.encode('utf-8')) + 1 if bounds else utf16_length(encoded) + 1
                    if counted >= limit:
                        if bounds:
                            truncated = True
                            truncated_reasons.add('message_limit')
                        break
                    if not absorb(public, length, list(message['_order'])): break
                    # An undecodable row has no text to reason about, so it never
                    # spends the reply budget. It still keeps its place in the
                    # conversation: dropping it would tear the ordering the reply
                    # reads, and a placeholder costs the model nothing.
                    if bounds or not message.get('_unparsable'): counted += 1
                if not bounds: recent.reverse()
                if request['action'] != 'read-image' and not recent and skipped_shards:
                    # Every shard was unreadable (keys not loaded by WeChat yet),
                    # so an empty result would falsely mean "no messages". The
                    # contact may have real history in an unopened shard.
                    raise ValueError('chat messages not loaded')
                result = {'account': account, 'contact': target['id'], 'messages': recent, 'truncated': truncated,
                          'truncatedReasons': sorted(truncated_reasons),
                          'label': target['label'], 'native': target['native'],
                          'revision': digest(json.dumps(recent, ensure_ascii=False, sort_keys=True, separators=(',', ':')))}
                if request['action'] == 'read-image':
                    message = next((m for m in ordered if m['id'] == request.get('messageId') and m.get('type') == 'image' and m['direction'] == 'other'), None)
                    image = images.read_image(root.parent, target['username'], message.get('_image'), message['timestamp'], check) if message else None
                    result = {'account': account, 'contact': target['id'], 'messageId': request.get('messageId'), 'image': image}
                if bounds:
                    result.update({'from': bounds[0], 'to': bounds[1],
                                   'rangeRevision': digest(repr(versions))})
        if cache is not None and request['action'] == 'read':
            # A cold DB/key read can outlast the hint lease. Publish a newly
            # validated hint after that work, before final DB/account checks.
            session_hint = cache.session_hint(pid, home, check)
        db.pages.stable()
        if active_root(pid, home) != root:
            if cache is not None: cache.clear()
            return {'error': 'account-changed'}
        check_versions(files, versions)
        check()
        # A range can carry up to 30,000 messages and nearly the worker's line
        # budget. Do not retain that body in the 15-minute snapshot cache; the
        # cache is for bounded recent reads and metadata, not a second copy of
        # long analysis material in the worker.
        if cache is not None and request['action'] not in ('read-image', 'read-range'): cache.remember(cache_key, versions, result)
        return {**result, **({'sessionHint': session_hint} if request['action'] == 'read' else {})}
    finally:
        db.close()
        keys.clear()


class SoftCancel(TimeoutError):
    """Cancel only the request in flight, keeping the worker and its caches.

    Aborting a read used to kill this process, and rebuilding it repeats the
    cold key/session discovery before any answer comes back. A cancellation
    therefore has to stop the current work and return to serving requests.
    """


def publish(result):
    """Write exactly one line, undividable by a cancellation signal.

    A cancellation handler raises inside whatever python is executing, so signal
    delivery is blocked here: a half-written line would pair the next request
    with a truncated reply and make the node side restart this worker.
    """
    payload = json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n'
    signals = None
    try:
        # SIGUSR1 does not exist on every platform (notably Windows test hosts);
        # without this guard the worker would die before ever writing a reply.
        signals = {signal.SIGUSR1, signal.SIGTERM}
        signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    except (AttributeError, ValueError, OSError):
        signals = None
    try:
        sys.stdout.write(payload)
        sys.stdout.flush()
    finally:
        if signals is not None:
            try:
                signal.pthread_sigmask(signal.SIG_UNBLOCK, signals)
            except (AttributeError, ValueError, OSError):
                pass


def main():
    deadline = time.monotonic() + 40
    cancelled = False
    soft = False
    def cancel(*_):
        nonlocal cancelled
        cancelled = True
        raise TimeoutError('cancelled')
    def soft_cancel(*_):
        nonlocal cancelled, soft
        cancelled = True
        soft = True
        raise SoftCancel('cancelled')
    def check():
        # A cancellation handler raises wherever python happens to be, so the
        # flag decides: whatever reaches the next check stops as a soft cancel,
        # which keeps the cache and the worker instead of ending the process.
        if soft: raise SoftCancel('cancelled')
        if cancelled or time.monotonic() > deadline:
            raise TimeoutError('cancelled')
    signal.signal(signal.SIGTERM, cancel)
    # Optional: an environment without SIGUSR1 simply falls back to restarting.
    try:
        signal.signal(signal.SIGUSR1, soft_cancel)
    except (AttributeError, ValueError, OSError):
        pass
    cache = SessionCache(os.environ.get('HOME')) if '--worker' in sys.argv[2:] else None
    try:
        pid = int(sys.argv[1])
        if cache is not None:
            # Authenticate and persist every key WeChat currently holds before
            # the first request arrives, so a read does not spend its own
            # deadline on the cold walk. Anything it finds is written to the
            # encrypted cache and reused by later workers too.
            warm = time.monotonic() + 20

            def warm_check():
                if soft: raise SoftCancel('cancelled')
                if cancelled or time.monotonic() > warm:
                    raise TimeoutError('cancelled')

            try:
                execute({'action': 'keys'}, pid, os.environ['HOME'], warm_check, cache)
            except SoftCancel:
                cancelled = False; soft = False  # Keep serving; the keys stay worth keeping.
            except Exception:
                pass  # A cold start that cannot warm up simply falls back to the request path.
        while not cancelled or soft:
            try:
                raw = sys.stdin.readline(4097) if cache is not None else sys.stdin.read(4097)
            except SoftCancel:
                # No request was running: stay hot and wait for the next one.
                cancelled = False; soft = False
                continue
            if not raw: break
            result = {'error': 'data-unavailable'}
            deadline = time.monotonic() + 40
            try:
                if len(raw) > 4096: raise ValueError('request too large')
                request = json.loads(raw)
                if not isinstance(request, dict): raise ValueError('invalid request')
                # HOME comes from the instance runtime, never from the request.
                for attempt in range(3):
                    try:
                        result = execute(request, pid, os.environ['HOME'], check, cache)
                        break
                    except SoftCancel:
                        raise
                    except (ValueError, OSError) as error:
                        if cache is not None: cache.invalidate(error)
                        check()
                        # Retrying only helps when the databases were caught mid
                        # write. A verdict about this content (an unreadable
                        # body, a shard WeChat never loaded, an invalid range)
                        # will not change, so do not pay for it three times.
                        if attempt == 2 or str(error) in FAILURE_STAGES: raise
            except SoftCancel:
                # Only the request was cancelled. Keys, the native session and
                # read snapshots stay in memory, so the next read - usually the
                # one the user just clicked for - answers immediately.
                result = {'error': 'data-unavailable', 'stage': 'timeout'}
                cancelled = False; soft = False
            except Exception as error:
                if soft:  # The flag decides, not where the raise happened to land.
                    result = {'error': 'data-unavailable', 'stage': 'timeout'}
                    cancelled = False; soft = False
                else:
                    if cache is not None: cache.invalidate(error)
                    stage = FAILURE_STAGES.get(str(error)) or TRANSIENT_STAGES.get(str(error)) or (
                        'timeout' if isinstance(error, TimeoutError) else 'message-format' if isinstance(error, ET.ParseError) else None)
                    result = {'error': 'data-unavailable', **({'stage': stage} if stage else {})}
            if cancelled: break
            publish(result)
            if cache is None or len(raw) > 4096: break
    except Exception:
        pass  # No account, key, SQL, chat body or raw exception in logs/stdout.
    finally:
        if cache is not None: cache.clear()


if __name__ == '__main__':
    main()
