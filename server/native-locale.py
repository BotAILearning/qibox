"""Prepare an app-owned UTF-8 locale without changing NAS locale settings."""
import ctypes as c
import json
import locale
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


def supported(name, search):
    os.environ['LOCPATH'] = search
    libc = c.CDLL(None)
    libc.setlocale.argtypes = [c.c_int, c.c_char_p]
    libc.setlocale.restype = c.c_char_p
    return bool(libc.setlocale(locale.LC_ALL, name.encode()))


def prepare(root):
    root = pathlib.Path(root).resolve(strict=True)
    directory = root / 'native-locales'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.resolve() != directory or not directory.is_dir():
        raise ValueError('invalid locale directory')
    search = str(directory) + ':/lib/locale'
    if not supported('zh_CN.UTF-8', search):
        temporary = pathlib.Path(tempfile.mkdtemp(prefix='build-', dir=directory))
        try:
            candidate = temporary / 'zh_CN.UTF-8'
            subprocess.run(['/usr/bin/localedef', '--no-archive', '-i', 'zh_CN', '-f', 'UTF-8', str(candidate)],
                           env={**os.environ, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'LOCPATH': '/lib/locale'},
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=15, check=True)
            if not supported('zh_CN.UTF-8', str(temporary)):
                raise ValueError('compiled locale unavailable')
            target = directory / 'zh_CN.UTF-8'
            if target.exists():
                raise ValueError('existing locale unavailable')
            candidate.rename(target)
        finally:
            shutil.rmtree(temporary)
    if not supported('zh_CN.UTF-8', search):
        raise ValueError('UTF-8 locale unavailable')
    return {'LANG': 'zh_CN.UTF-8', 'LC_ALL': 'zh_CN.UTF-8', 'LANGUAGE': 'zh_CN:zh', 'LOCPATH': search}


if __name__ == '__main__':
    try:
        environment = prepare(sys.argv[1])
    except Exception:
        # UTF-8 filenames must never silently become '?' when Chinese locale
        # sources are absent. This fallback affects only the private desktop.
        environment = {'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'LANGUAGE': 'zh_CN:zh', 'LOCPATH': '/lib/locale'}
    print(json.dumps(environment), flush=True)
