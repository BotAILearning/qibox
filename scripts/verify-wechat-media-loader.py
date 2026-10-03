"""Linux diagnostic: resolve the vendor VLC codec in an isolated subprocess.

Pass an existing WeChat PID and the bundled runtime root. No WeChat process,
binary, account file, or environment is modified. Only sanitized results print.
"""
import argparse
import json
import pathlib
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('pid', type=int)
parser.add_argument('runtime', type=pathlib.Path)
args = parser.parse_args()
proc = pathlib.Path('/proc') / str(args.pid)
wechat = (proc / 'exe').resolve().parent
plugin = wechat / 'vlc_plugins/codec/libavcodec_plugin.so'
if not plugin.is_file():
    raise SystemExit('Vendor VLC codec not found')
env = dict(item.decode().split('=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
env.update(PYTHONHOME=str(args.runtime / 'usr'), PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1')
radium = str(wechat / 'RadiumWMPF/runtime')
paths = [item for item in env['LD_LIBRARY_PATH'].split(':') if item and item != radium]
python = args.runtime / 'usr/bin/python3.11'
code = 'import ctypes;ctypes.CDLL(' + repr(str(plugin)) + ',mode=ctypes.RTLD_GLOBAL);print("loaded")'
results = []
for name, search in [('component-local', paths), ('legacy-global-radium', [radium, *paths])]:
    current = {**env, 'LD_LIBRARY_PATH': ':'.join(search)}
    result = subprocess.run([str(python), '-c', code], env=current, capture_output=True, text=True, timeout=20)
    missing = re.search(r'undefined symbol: (\w+)', result.stderr)
    results.append({'variant': name, 'loaded': result.returncode == 0 and result.stdout.strip() == 'loaded',
                    'missingSymbol': missing.group(1) if missing else None})
print(json.dumps(results))
if not results[0]['loaded']:
    raise SystemExit('Component-local codec load failed')
