"""Bounded, account-local image lookup. Unsupported formats are skipped."""
import base64
import hashlib
import pathlib
import re
import xml.etree.ElementTree as ET

LIMIT = 4 * 1024 * 1024

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
        for file in candidates:
            check()
            try:
                resolved = file.resolve(strict=True); resolved.relative_to(folder.resolve())
                before = resolved.stat()
                if not 12 <= before.st_size <= LIMIT: continue
                with resolved.open('rb') as handle: data = handle.read(LIMIT + 1)
                if resolved.stat() != before: continue
                decoded = decode_image(data)
                if decoded:
                    mime, content = decoded
                    return {'mime': mime, 'data': base64.b64encode(content).decode('ascii')}
            except (OSError, ValueError): continue
    except (OSError, ValueError): pass
    return None
