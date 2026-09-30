"""Send synthesized speech through WeChat's own recording controls.

No database/network writes, audio attachments, human voice cloning or captured
playback. The instance owns a silent private microphone from startup. Only its
generated audio is played into that source, and only an explicitly verified
native Send Voice control can submit the resulting recording.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import time

RATE = 48000
MAX_SECONDS = 55


def read_media(media):
    if (not isinstance(media, dict) or set(media) != {'name', 'type', 'delivery', 'path', 'size', 'sha256'}
            or media.get('type') != 'audio/mpeg' or media.get('delivery') != 'voice'
            or not re.fullmatch(r'(?:AI-generated|AI合成)-[a-f0-9-]{36}\.mp3', media.get('name', ''))
            or type(media.get('size')) is not int or not 0 < media['size'] <= 8 * 1024 * 1024
            or not re.fullmatch(r'[a-f0-9]{64}', media.get('sha256', ''))):
        raise ValueError('invalid voice media')
    base = pathlib.Path(os.environ['XDG_RUNTIME_DIR']) / 'audio' / 'generated'
    target = base / media['name']
    if media['path'] != str(target) or base.resolve(strict=True) != base:
        raise ValueError('invalid voice media')
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        stamp = os.fstat(stream.fileno())
        if not stat.S_ISREG(stamp.st_mode) or stamp.st_uid != os.geteuid() or stamp.st_mode & 0o077 or stamp.st_size != media['size']:
            raise ValueError('invalid voice media')
        data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) != media['size'] or hashlib.sha256(data).hexdigest() != media['sha256']:
        raise ValueError('invalid voice media')
    return data


def communicate_checked(child, payload, check, timeout):
    deadline = time.monotonic() + timeout
    first = True
    try:
        while time.monotonic() < deadline:
            check()
            try:
                result = child.communicate(payload if first else None, timeout=.1)
                if child.returncode != 0: raise ValueError('voice audio unavailable')
                return result
            except subprocess.TimeoutExpired:
                first = False
        raise TimeoutError('voice audio unavailable')
    finally:
        if child.poll() is None:
            child.kill(); child.communicate(timeout=1)


def decode_audio(data, check):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg: raise ValueError('voice audio unavailable')
    child = subprocess.Popen([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0',
                              '-t', str(MAX_SECONDS + .5), '-ac', '1', '-ar', str(RATE), '-f', 's16le', 'pipe:1'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    pcm, _ = communicate_checked(child, data, check, 12)
    if not pcm or len(pcm) % 2: raise ValueError('voice audio unavailable')
    seconds = len(pcm) / (RATE * 2)
    if seconds > MAX_SECONDS: raise ValueError('voice too long')
    # A short generated syllable must still satisfy WeChat's recording minimum.
    pcm = b'\0' * int(RATE * 2 * .3) + pcm + b'\0' * int(RATE * 2 * max(.3, 1.2 - seconds))
    return pcm


class Pulse:
    def __init__(self, pid):
        self.pid = pid
        self.pactl = shutil.which('pactl')
        self.paplay = shutil.which('paplay')
        base = pathlib.Path(os.environ['XDG_RUNTIME_DIR']) / 'audio'
        if not self.pactl or not self.paplay or os.environ.get('PULSE_SERVER') != 'unix:' + str(base / 'native'):
            raise ValueError('voice audio unavailable')

    def listing(self, kind):
        value = subprocess.run([self.pactl, '-f', 'json', 'list', kind], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, check=True, timeout=2)
        if len(value.stdout) > 200000: raise ValueError('voice audio unavailable')
        return json.loads(value.stdout)

    def microphone(self):
        sources = [source for source in self.listing('sources') if source.get('name') == 'qibox_voice_mic']
        if len(sources) != 1 or sources[0].get('mute') is not False: raise ValueError('voice audio unavailable')
        return sources[0]['index']

    def own_process(self, value):
        if not isinstance(value, str) or not value.isdigit(): return False
        pid = int(value)
        for _ in range(4):
            if pid == self.pid: return True
            if pid <= 1: break
            try:
                pid = int(pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[-1].split()[1])
            except (OSError, ValueError, IndexError): return False
        return False

    def recording(self, source):
        return [stream for stream in self.listing('source-outputs')
                if stream.get('source') == source and stream.get('corked') is False
                and self.own_process(stream.get('properties', {}).get('application.process.id'))]

    def play(self, pcm, check):
        child = subprocess.Popen([self.paplay, '--raw', '--format=s16le', '--rate=' + str(RATE), '--channels=1',
                                  '--latency-msec=100', '--device=qibox_voice_input'], stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        communicate_checked(child, pcm, check, MAX_SECONDS + 5)


def voice_buttons(ins, layout):
    cancel = ins.find(layout['frame'], '取消', 'push button', True)
    send = ins.find(layout['frame'], '发送语音', 'push button', True)
    if not cancel or not send or not ins.visible(cancel) or not ins.visible(send):
        raise ValueError('voice recording changed')
    return cancel, send


def send(adapter, media, layout):
    ins = adapter.controls
    data = read_media(media)
    pcm = decode_audio(data, ins.check)
    pulse = Pulse(ins.pid); source = pulse.microphone()
    ins.check(); adapter.verify_session(); ins.require_foreground('微信')
    if ins._visible_roots(layout['app'], layout['frame']) or adapter.editor_text(layout['editor']): return {'status': 'stale'}
    toggle = ins.find(layout['frame'], '发语音', 'push button', True)
    if not toggle or not ins.visible(toggle): raise ValueError('voice unavailable')
    adapter.owned_voice = {'layout': dict(layout), 'cancel': None, 'send': None}
    adapter.possibly_written = True
    recorded_at, recorded_clock = int(time.time() * 1000), time.monotonic()
    ins.press(toggle)
    deadline = time.monotonic() + 3
    while True:
        ins.check(); adapter.verify_session()
        try:
            cancel, send_button = voice_buttons(ins, layout)
            adapter.owned_voice.update(cancel=cancel, send=send_button)
            streams = pulse.recording(source)
            if len(streams) == 1: break
            if len(streams) > 1: raise ValueError('voice audio unavailable')
        except ValueError as error:
            if str(error) != 'voice recording changed': raise
        if time.monotonic() >= deadline: raise ValueError('voice audio unavailable')
        time.sleep(.1)
    stream_id = streams[0]['index']
    last_guard = -float('inf')
    def guard(force=False):
        nonlocal last_guard
        ins.check()
        if not force and time.monotonic() - last_guard < .5: return
        adapter.verify_session(); ins.require_foreground('微信')
        if not ins.visible(layout['frame']) or ins.string('get_name', layout['header']) != layout['label']:
            raise ValueError('voice recording changed')
        if ins._visible_roots(layout['app'], layout['frame']): raise ValueError('voice recording changed')
        if voice_buttons(ins, layout) != (cancel, send_button): raise ValueError('voice recording changed')
        active = pulse.recording(source)
        if len(active) != 1 or active[0]['index'] != stream_id: raise ValueError('voice audio unavailable')
        last_guard = time.monotonic()
    guard(True); pulse.play(pcm, guard); guard(True)
    # Only this native submit is a Send attempt. Recording or cancellation alone
    # cannot consume the incoming message or force unknown-delivery recovery.
    adapter.voice_receipt = {'startAt': recorded_at, 'endAt': int(time.time() * 1000),
                             'durationMs': int((time.monotonic() - recorded_clock) * 1000)}
    adapter.send_pressed = True
    ins.press(send_button)
    for _ in range(15):
        time.sleep(.15); ins.check(); adapter.verify_session()
        if not ins.visible(send_button) and not ins.visible(cancel):
            adapter.send_confirmed = True
            return {'status': 'submitted'}
    return {'status': 'uncertain'}


def cleanup(adapter):
    if adapter.send_pressed: return 'blocked'
    ins, owned = adapter.controls, adapter.owned_voice
    status = 'blocked'
    def cancel_owned():
        nonlocal status
        layout = owned['layout']
        adapter.verify_session(); ins.require_foreground('微信')
        if ins._visible_roots(layout['app'], layout['frame']) or ins.string('get_name', layout['header']) != layout['label']: return
        cancel, send_button = voice_buttons(ins, layout)
        if owned['cancel'] and (cancel != owned['cancel'] or send_button != owned['send']): return
        ins.press(cancel)
        for _ in range(5):
            time.sleep(.1)
            if not ins.visible(cancel) and not ins.visible(send_button):
                status = 'cleared'; return
    ins._cleanup_budget(cancel_owned, seconds=1.5)
    return status
