"""Read an authenticated message's local video and extract bounded frames.

WeChat's MP4 filename is not its content MD5. Use the message's exact byte
length to narrow the local account/month, then verify the whole-file MD5.
Never use an XML path/URL or choose a video merely because its time is close.
"""
import base64
import datetime
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET

MAX_BYTES = 100 * 1024 * 1024
MAX_FRAME = 1024 * 1024
MAX_DIRECTORY_ENTRIES = 20000
MAX_HASH_CANDIDATES = 64


def video_reference(content):
    if not isinstance(content, str) or len(content) > 65536 or re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I):
        return None
    try:
        root = ET.fromstring(content)
        video = root if root.tag == 'videomsg' else root.find('videomsg')
        if video is None:
            return None
        references = []
        for digest_name, length_name in (('md5', 'length'), ('newmd5', 'length'), ('rawmd5', 'rawlength')):
            digest, length = video.get(digest_name, ''), video.get(length_name, '')
            if not re.fullmatch(r'[a-fA-F0-9]{32}', digest) or not re.fullmatch(r'\d{1,9}', length):
                continue
            if 1024 <= int(length) <= MAX_BYTES and (digest.lower(), int(length)) not in references:
                references.append((digest.lower(), int(length)))
        return references or None
    except ET.ParseError:
        return None


def _run(binary, args, timeout, check):
    check()
    try:
        result = subprocess.run([binary, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    check()
    return result.stdout if result.returncode == 0 else None


def _candidate(root, filename, expected, expected_length, check):
    try:
        if filename.is_symlink():
            return None
        resolved = filename.resolve(strict=True)
        resolved.relative_to(root)
        info = resolved.stat()
        if not resolved.is_file() or info.st_size != expected_length:
            return None
        digest = hashlib.md5()
        with resolved.open('rb') as handle:
            while block := handle.read(1024 * 1024):
                check()
                digest.update(block)
        after = resolved.stat()
        if (after.st_size, after.st_mtime_ns) != (info.st_size, info.st_mtime_ns) or digest.hexdigest() != expected:
            return None
        return resolved
    except (OSError, ValueError):
        return None


def _files(directory, pattern, check):
    try:
        if directory.resolve(strict=True) != directory:
            return
        for index, filename in enumerate(directory.iterdir()):
            check()
            if index >= MAX_DIRECTORY_ENTRIES:
                return
            if pattern.fullmatch(filename.name):
                yield filename
    except (OSError, ValueError):
        return


def _video_paths(root, username, timestamp, check):
    months = {datetime.datetime.fromtimestamp(timestamp + offset, datetime.timezone.utc).strftime('%Y-%m')
              for offset in (-86400, 0, 86400)}
    for month in sorted(months, reverse=True):
        video_dir = root / 'msg' / 'video' / month
        yield from _files(video_dir, re.compile(r'[a-f0-9]{32}(?:_raw)?\.mp4'), check)
        # Some locally recorded clips live in this contact's attachment tree.
        recordings = root / 'msg' / 'attach' / hashlib.md5(username.encode()).hexdigest() / month / 'Rec'
        for folder in _files(recordings, re.compile(r'[a-f0-9]{16}'), check):
            yield from _files(folder / 'V', re.compile(r'\d{1,5}\.mp4'), check)


def read_video_frames(account_root, username, reference, timestamp, check):
    if not isinstance(reference, list) or not 1 <= len(reference) <= 3 or any(
            not isinstance(item, tuple) or len(item) != 2 or
            not isinstance(item[0], str) or not re.fullmatch(r'[a-f0-9]{32}', item[0]) or
            not isinstance(item[1], int) or not 1024 <= item[1] <= MAX_BYTES for item in reference):
        return None
    if not isinstance(username, str) or not username or not isinstance(timestamp, (int, float)) or timestamp <= 0:
        return None
    probe, converter = shutil.which('ffprobe'), shutil.which('ffmpeg')
    if not probe or not converter:
        return None
    root = pathlib.Path(account_root).resolve()
    file = None
    hashed = 0
    for path in _video_paths(root, username, timestamp, check):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        for digest, length in reference:
            if size != length:
                continue
            hashed += 1
            if hashed > MAX_HASH_CANDIDATES:
                return None
            file = _candidate(root, path, digest, length, check)
            if file is not None:
                break
        if file is not None:
            break
    if file is not None:
        raw = _run(probe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=duration,format=duration', '-of', 'json', str(file)], 8, check)
        if not raw or len(raw) > 8192:
            return None
        try:
            meta = json.loads(raw)
            duration = float((meta.get('streams') or [{}])[0].get('duration') or meta.get('format', {}).get('duration'))
        except (ValueError, TypeError, KeyError, IndexError):
            return None
        if not 0 < duration <= 600:
            return None
        frames = []
        for fraction in (0.1, 0.5, 0.8):
            frame = _run(converter, ['-nostdin', '-v', 'error', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-ss', f'{duration * fraction:.3f}', '-i', str(file), '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 8, check)
            if not frame or not frame.startswith(b'\xff\xd8\xff') or len(frame) > MAX_FRAME:
                return None
            frames.append({'mime': 'image/jpeg', 'data': base64.b64encode(frame).decode('ascii'), 'at': round(duration * fraction, 2)})
        return frames
    return None
