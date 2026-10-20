"""Private Openbox signal only. No shell, window ids, account data or chat input."""
import os
import pathlib
import sys
import uuid

def main():
    target = pathlib.Path(sys.argv[1])
    if target.name != 'window-close.request' or not target.is_absolute():
        raise ValueError('Invalid private signal')
    info = target.parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Private session required')
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return
    try:
        os.write(fd, str(uuid.uuid4()).encode('ascii'))
    finally:
        os.close(fd)

if __name__ == '__main__':
    main()
