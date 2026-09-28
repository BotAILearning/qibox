"""Read only an authenticated chat's locally available video and extract frames.

The message's video MD5 must match the complete file. Never search by time or
run a path supplied by message XML. Missing/offline media returns None.
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


def video_reference(content):
    if not isinstance(content, str) or len(content) > 65536 or re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I):
        return None
    try:
        root = ET.fromstring(content)
        video = root if root.tag == 'videomsg' else root.find('videomsg')
        value = video.get('md5', '') if video is not None else ''
        return value.lower() if re.fullmatch(r'[a-fA-F0-9]{32}', value) else None
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


def _candidate(root, filename, expected, check):
    try:
        if filename.is_symlink():
            return None
        resolved = filename.resolve(strict=True)
        resolved.relative_to(root)
        info = resolved.stat()
        if not resolved.is_file() or not 1024 <= info.st_size <= MAX_BYTES:
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


def read_video_frames(account_root, username, reference, timestamp, check):
    if not isinstance(reference, str) or not re.fullmatch(r'[a-f0-9]{32}', reference):
        return None
    if not isinstance(username, str) or not username or not isinstance(timestamp, (int, float)) or timestamp <= 0:
        return None
    probe, converter = shutil.which('ffprobe'), shutil.which('ffmpeg')
    if not probe or not converter:
        return None
    root = pathlib.Path(account_root).resolve()
    month = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y-%m')
    attach = hashlib.md5(username.encode()).hexdigest()
    paths = [root / 'msg' / 'video' / month / (reference + suffix) for suffix in ('.mp4', '_raw.mp4')]
    paths += [root / 'msg' / 'attach' / attach / month / 'Video' / (reference + suffix) for suffix in ('.mp4', '_raw.mp4')]
    for path in paths:
        file = _candidate(root, path, reference, check)
        if file is None:
            continue
        raw = _run(probe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=duration,format=duration', '-of', 'json', str(file)], 8, check)
        if not raw or len(raw) > 8192:
            continue
        try:
            meta = json.loads(raw)
            duration = float((meta.get('streams') or [{}])[0].get('duration') or meta.get('format', {}).get('duration'))
        except (ValueError, TypeError, KeyError, IndexError):
            continue
        if not 0 < duration <= 600:
            continue
        frames = []
        for fraction in (0.1, 0.5, 0.8):
            frame = _run(converter, ['-nostdin', '-v', 'error', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-ss', f'{duration * fraction:.3f}', '-i', str(file), '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 8, check)
            if not frame or not frame.startswith(b'\xff\xd8\xff') or len(frame) > MAX_FRAME:
                return None
            frames.append({'mime': 'image/jpeg', 'data': base64.b64encode(frame).decode('ascii'), 'at': round(duration * fraction, 2)})
        return frames
    return None
