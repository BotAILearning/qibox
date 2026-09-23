"""Bounded, account-local image lookup. Unsupported formats are skipped."""
import base64
import ctypes as c
import datetime
import hashlib
import pathlib
import re
import struct
import sys
import xml.etree.ElementTree as ET

LIMIT = 4 * 1024 * 1024
V2 = b'\x07\x08V2\x08\x07'


def file_version(value):
    # Reading may update atime; only content/identity changes invalidate the snapshot.
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def image_keys(account_root, check):
    """Derive candidates from this instance's cache filenames, never their contents."""
    root = pathlib.Path(account_root)
    home = root.parent.parent
    account = root.name
    match = re.fullmatch(r'(wxid_[A-Za-z0-9]+)_([a-f0-9]{4})', account)
    if not match or root.parent.name != 'xwechat_files': return
    names = (match[1], account)
    folders = [home / '.xwechat' / part / 'kvcomm' for part in ('ilink', 'net')]
    base = home / '.xwechat/radium/ilink'
    try:
        if base.resolve(strict=True) == base:
            for i, folder in enumerate(base.iterdir()):
                if i >= 64: break
                if re.fullmatch(match[2] + r'[a-f0-9]{28}', folder.name): folders.append(folder / 'kvcomm')
    except OSError: pass
    seen = set()
    for folder in folders:
        check()
        try:
            if folder.resolve(strict=True) != folder: continue
            for i, file in enumerate(folder.iterdir()):
                if i >= 2000 or len(seen) >= 64: break
                check()
                found = re.fullmatch(r'key_(\d{1,10})_.+\.statistic', file.name, re.I)
                if not found: continue
                code = found[1]
                if code in seen or int(code) > 0xffffffff: continue
                seen.add(code)
                for name in names:
                    yield hashlib.md5((code + name).encode()).hexdigest()[:16].encode('ascii'), int(code) & 255
        except OSError: continue


def aes_prefix(data, key):
    """AES-128 ECB with OpenSSL's checked PKCS7 removal; key stays in memory."""
    api = c.CDLL(str(pathlib.Path(sys.base_prefix, 'DLLs/libcrypto-3-x64.dll')) if sys.platform == 'win32' else 'libcrypto.so.3')
    api.EVP_CIPHER_CTX_new.restype = c.c_void_p
    api.EVP_aes_128_ecb.restype = c.c_void_p
    api.EVP_CIPHER_CTX_free.argtypes = [c.c_void_p]
    api.EVP_DecryptInit_ex.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p]
    api.EVP_DecryptUpdate.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int), c.c_void_p, c.c_int]
    api.EVP_DecryptFinal_ex.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_int)]
    ctx = api.EVP_CIPHER_CTX_new()
    if not ctx: return None
    try:
        out, size, final = c.create_string_buffer(len(data) + 16), c.c_int(), c.c_int()
        if (api.EVP_DecryptInit_ex(ctx, api.EVP_aes_128_ecb(), None, key, None) != 1
                or api.EVP_DecryptUpdate(ctx, out, c.byref(size), data, len(data)) != 1
                or api.EVP_DecryptFinal_ex(ctx, c.byref(out, size.value), c.byref(final)) != 1): return None
        return out.raw[:size.value + final.value]
    finally: api.EVP_CIPHER_CTX_free(ctx)


def decode_v2(data, account_root, check):
    if not 31 <= len(data) <= LIMIT or data[:6] != V2 or data[14] != 1: return None
    size, tail = struct.unpack_from('<II', data, 6)
    encrypted = (size // 16 + 1) * 16
    if size < 12 or encrypted > len(data) - 15 or tail > len(data) - 15 - encrypted: return None
    for key, xor in image_keys(account_root, check):
        check()
        try: head = aes_prefix(data[15:15 + encrypted], key)
        except (OSError, AttributeError): return None
        if head is None or len(head) != size: continue
        end = len(data) - tail
        content = head + data[15 + encrypted:end] + bytes(value ^ xor for value in data[end:])
        decoded = decode_image(content)
        # A V2 plaintext must already be a standard image, not another guessed XOR layer.
        if decoded and decoded[1] == content: return decoded
    return None

def image_reference(content):
    if not isinstance(content, str) or len(content) > 65536 or re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I): return None
    try:
        root = ET.fromstring(content)
        node = root if root.tag == 'img' else root.find('img')
        value = node.get('md5', '') if node is not None else ''
        return value.lower() if re.fullmatch(r'[a-fA-F0-9]{32}', value) else None
    except ET.ParseError: return None

def decode_image(data):
    if not 12 <= len(data) <= LIMIT: return None
    signatures = [(b'\xff\xd8\xff', 'image/jpeg'), (b'\x89PNG\r\n\x1a\n', 'image/png'), (b'GIF8', 'image/gif')]
    for signature, mime in signatures:
        key = data[0] ^ signature[0]
        if all((data[i] ^ key) == byte for i, byte in enumerate(signature)):
            return mime, bytes(byte ^ key for byte in data) if key else data
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP': return 'image/webp', data
    return None

def read_image(account_root, username, reference, timestamp, check):
    if not isinstance(reference, str) or not re.fullmatch(r'[a-f0-9]{32}', reference): return None
    # Only the authenticated contact's attachment tree. No XML URLs/paths,
    # remote downloads, other accounts, or arbitrary filesystem traversal.
    root = pathlib.Path(account_root).resolve()
    folder = root / 'msg' / 'attach' / hashlib.md5(username.encode()).hexdigest()
    try:
        folder.resolve(strict=True).relative_to(root)
        if folder.resolve() != folder: return None
        candidates = []
        for i, month in enumerate(sorted(folder.iterdir(), reverse=True)):
            if i >= 240: break
            if not re.fullmatch(r'\d{4}-\d{2}', month.name): continue
            for suffix in ('.dat', '.jpg', '.jpeg', '.png', '.webp', '_t.dat'):
                candidates.append(month / 'Img' / (reference + suffix))
        def read_candidate(file):
            check()
            try:
                resolved = file.resolve(strict=True); resolved.relative_to(folder.resolve())
                before = resolved.stat()
                if not 12 <= before.st_size <= LIMIT: return None
                with resolved.open('rb') as handle: data = handle.read(LIMIT + 1)
                if file_version(resolved.stat()) != file_version(before): return None
                return decode_v2(data, root, check) if data.startswith(V2) else decode_image(data)
            except (OSError, ValueError): return None
        def encoded(decoded):
            return {'mime': decoded[0], 'data': base64.b64encode(decoded[1]).decode('ascii')}
        for file in candidates:
            decoded = read_candidate(file)
            if decoded: return encoded(decoded)
        # Newer WeChat builds use an unrelated attachment filename. Match the
        # decoded content hash, never merely the time or newest image. Bound the
        # search to this conversation and the message's month (including timezone
        # boundary days), with cancellation and a total read budget.
        if not isinstance(timestamp, (int, float)) or timestamp <= 0: return None
        months = {datetime.datetime.fromtimestamp(timestamp + offset, datetime.timezone.utc).strftime('%Y-%m')
                  for offset in (-86400, 0, 86400)}
        recent = []
        for month in sorted(months, reverse=True):
            directory = folder / month / 'Img'
            try:
                if directory.resolve(strict=True) != directory: continue
                for i, file in enumerate(directory.iterdir()):
                    check()
                    if i >= 2048: break
                    if not re.fullmatch(r'[a-f0-9]{32}\.dat', file.name): continue
                    if file.is_symlink(): continue
                    info = file.stat()
                    if 12 <= info.st_size <= LIMIT: recent.append((info.st_mtime_ns, info.st_size, file))
            except OSError: continue
        budget = 32 * 1024 * 1024
        for _, size, file in sorted(recent, reverse=True)[:256]:
            check()
            if size > budget: break
            budget -= size
            decoded = read_candidate(file)
            if decoded and hashlib.md5(decoded[1]).hexdigest() == reference: return encoded(decoded)
    except (OSError, ValueError): pass
    return None
