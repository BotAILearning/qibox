"""Verify a clean Linux extraction against its retained runtime inventory."""
import hashlib
import json
import os
import pathlib
import posixpath
import stat
import sys


def verify(root, inventory):
    root = pathlib.Path(root).absolute()
    failures = []
    for name, expected in inventory.items():
        if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
            raise ValueError('Unsafe inventory path')
        file = root / name
        try:
            info = file.lstat()
            kind, mode, uid, gid, link, size, sha = expected
            if kind == '5':
                if not stat.S_ISDIR(info.st_mode): raise ValueError('Not a directory')
            elif kind == '2':
                if not stat.S_ISLNK(info.st_mode) or os.readlink(file) != link: raise ValueError('Symbolic link differs')
            elif kind == '1':
                target = root / posixpath.normpath(link)
                if not stat.S_ISREG(info.st_mode) or info.st_ino != target.stat().st_ino: raise ValueError('Hard link differs')
            else:
                if not stat.S_ISREG(info.st_mode) or info.st_size != size: raise ValueError('File type or size differs')
                with file.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != sha: raise ValueError('File content differs')
            # Extracted executables must remain executable by their owner.
            if mode & 0o100 and not info.st_mode & 0o100: raise ValueError('Execute permission lost')
        except (OSError, ValueError) as error:
            failures.append({'path': name, 'reason': str(error)})
    if failures:
        raise ValueError(json.dumps(failures[:20]))
    return {'verifiedMembers': len(inventory), 'mismatches': 0}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1], json.loads(pathlib.Path(sys.argv[2]).read_text()))))
