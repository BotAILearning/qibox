"""Real GTK/X11 clipboard contract on an isolated NAS display and D-Bus."""
import base64
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time

RAW_OWNER = r'''
import ctypes as c, os, sys
gtk=c.CDLL('libgtk-3.so.0');gdk=c.CDLL('libgdk-3.so.0')
gtk.gtk_init(None,None)
ptr=c.c_void_p;gdk.gdk_atom_intern.argtypes=[c.c_char_p,c.c_int];gdk.gdk_atom_intern.restype=ptr
gtk.gtk_clipboard_get.argtypes=[ptr];gtk.gtk_clipboard_get.restype=ptr
clipboard=gtk.gtk_clipboard_get(gdk.gdk_atom_intern(b'CLIPBOARD',0))
mode=sys.argv[1];data=sys.stdin.buffer.read()
if mode=='text':
 gtk.gtk_clipboard_set_text.argtypes=[ptr,c.c_char_p,c.c_int]
 gtk.gtk_clipboard_set_text(clipboard,data,len(data))
elif mode=='image':
 pix=c.CDLL('libgdk_pixbuf-2.0.so.0')
 pix.gdk_pixbuf_new.argtypes=[c.c_int,c.c_int,c.c_int,c.c_int,c.c_int];pix.gdk_pixbuf_new.restype=ptr
 image=pix.gdk_pixbuf_new(0,1,8,3,2)
 pix.gdk_pixbuf_fill.argtypes=[ptr,c.c_uint];pix.gdk_pixbuf_fill(image,0x168b61ff)
 pix.gdk_pixbuf_savev.argtypes=[ptr,c.c_char_p,c.c_char_p,ptr,ptr,ptr]
 assert pix.gdk_pixbuf_savev(image,os.fsencode(os.environ['QIBOX_TEST_PNG']),b'png',None,None,None)
 gtk.gtk_clipboard_set_image.argtypes=[ptr,ptr];gtk.gtk_clipboard_set_image(clipboard,image)
elif mode=='files':
 class Target(c.Structure):_fields_=[('target',c.c_char_p),('flags',c.c_uint),('info',c.c_uint)]
 targets=(Target*1)(Target(b'text/uri-list',0,0))
 get_type=c.CFUNCTYPE(None,ptr,ptr,c.c_uint,ptr);clear_type=c.CFUNCTYPE(None,ptr,ptr)
 gtk.gtk_selection_data_set.argtypes=[ptr,ptr,c.c_int,ptr,c.c_int]
 @get_type
 def get_data(owner,selection,info,user):gtk.gtk_selection_data_set(selection,gdk.gdk_atom_intern(b'text/uri-list',0),8,data,len(data))
 @clear_type
 def clear_data(owner,user):pass
 gtk.gtk_clipboard_set_with_data.argtypes=[ptr,c.POINTER(Target),c.c_uint,get_type,clear_type,ptr]
 assert gtk.gtk_clipboard_set_with_data(clipboard,targets,1,get_data,clear_data,None)
gdk.gdk_flush();print('ready',flush=True);gtk.gtk_main()
'''


def main():
    if sys.platform != 'linux' or not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        raise RuntimeError('Requires Linux and an isolated dbus-run-session')
    server = pathlib.Path(sys.argv[1]).resolve()
    runtime = pathlib.Path(os.environ['QIBOX_TEST_RUNTIME'])
    processes, checks = [], []
    with tempfile.TemporaryDirectory(prefix='qibox-clipboard-contract-') as directory:
        folder = pathlib.Path(directory)
        read_fd, write_fd = os.pipe()
        display = subprocess.Popen([str(runtime / 'usr/bin/Xvfb'), '-displayfd', str(write_fd), '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'],
                                   pass_fds=[write_fd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(display); os.close(write_fd)
        assert select.select([read_fd], [], [], 8)[0], 'Isolated display startup timed out'
        with os.fdopen(read_fd) as pipe: number = pipe.readline().strip()
        assert number.isdigit()
        env = {**os.environ, 'DISPLAY': ':' + number, 'HOME': directory, 'TMPDIR': directory,
               'QIBOX_CLIPBOARD_ROOT': str(folder / 'snapshots'), 'QIBOX_TEST_PNG': str(folder / 'source.png'), 'NO_AT_BRIDGE': '1'}
        env.pop('XAUTHORITY', None)
        portal = subprocess.Popen([sys.executable, str(server / 'file-portal.py')], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(portal)
        owner = None

        def event(predicate, timeout=7):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if select.select([portal.stdout], [], [], .1)[0]:
                    line = portal.stdout.readline()
                    assert line, 'Portal exited'
                    value = json.loads(line)
                    if predicate(value): return value
            raise AssertionError('Clipboard event timed out')

        def own(mode, payload=b'', local=False):
            nonlocal owner
            command = [sys.executable, str(server / ('clipboard-files.py' if mode == 'files' else 'clipboard.py'))] if local else [sys.executable, '-c', RAW_OWNER, mode]
            process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            processes.append(process)
            process.stdin.write(payload); process.stdin.close()
            assert select.select([process.stdout], [], [], 7)[0], 'Clipboard owner startup timed out'
            assert process.stdout.readline().strip() == b'ready', 'Clipboard owner failed'
            if owner: owner.terminate()
            owner = process

        try:
            event(lambda value: value.get('type') == 'ready')
            text = 'QIBOX isolated 中文🙂\r\nsecond line é'
            own('text', text.encode())
            value = event(lambda value: value.get('clipboardType') == 'text')
            assert value['text'] == text
            checks.append('Real GTK text copy preserves Unicode, emoji and CRLF')
            large = '汉' * 19000
            own('text', large.encode())
            assert event(lambda value: value.get('clipboardType') == 'text')['text'] == large
            checks.append('57 KB UTF-8 clipboard crosses the portal without truncated lines')
            own('text', b'local input text', local=True)
            event(lambda value: value.get('type') == 'clipboard-clear')
            checks.append('Local input marker prevents clipboard echo')
            own('image')
            value = event(lambda value: value.get('clipboardType') == 'image')
            snapshot = pathlib.Path(value['uris'][0].removeprefix('file://'))
            assert value['snapshot'] and snapshot.parent == folder / 'snapshots'
            assert snapshot.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
            assert snapshot.stat().st_mode & 0o777 == 0o600
            checks.append('Real GTK image copy creates a private PNG snapshot')
            source = folder / 'source.png'
            payload = json.dumps([{'name': 'local.png', 'type': 'image/png', 'data': base64.b64encode(source.read_bytes()).decode()}]).encode()
            own('files', payload, local=True)
            event(lambda value: value.get('type') == 'clipboard-clear')
            checks.append('Local image paste marker prevents reverse image copy')
            ordinary = folder / '资料.txt'; ordinary.write_text('isolated file')
            own('files', (ordinary.as_uri() + '\r\n').encode())
            value = event(lambda value: value.get('operation') == 'copy' and value.get('uris') == [ordinary.as_uri()])
            assert 'text' not in value and 'snapshot' not in value
            checks.append('Real file URI clipboard is separate from text and image')
            assert portal.poll() is None
            print(json.dumps({'status': 'passed', 'layer': 'NAS isolated GTK/X11/D-Bus', 'checks': checks}), flush=True)
        finally:
            for process in reversed(processes):
                if process.poll() is None: process.terminate()
            for process in reversed(processes):
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait()


if __name__ == '__main__':
    main()
