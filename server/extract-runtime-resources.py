"""Extract a verified resource batch in one process, without following parents.

The specification and expected inventory are authored by the installed app.
Archives are hashed again here; uploaded manifests are never accepted.
"""
import hashlib
import json
import os
import pathlib
import posixpath
import shutil
import sys
import tarfile


def canonical(name):
    if name.startswith('/') or '\\' in name or '..' in name.split('/'):
        raise ValueError('Unsafe resource member')
    return posixpath.normpath(name)


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()


def extract(root, manifest, resources, skip_files=()):
    root = pathlib.Path(root).absolute()
    inventory = manifest['inventory']
    skip_files = set(skip_files)
    if not skip_files.issubset(manifest.get('host', {})):
        raise ValueError('Only approved host references may be omitted')
    count = 0
    for resource in resources:
        with open(resource['path'], 'rb') as source:
            if digest(source) != resource['sha256']:
                raise ValueError('Resource hash changed before extraction')
        with tarfile.open(resource['path']) as archive:
            for member in archive:
                name = canonical(member.name)
                expected = inventory.get(name)
                if expected is None or member.type.decode('ascii') != expected[0]:
                    raise ValueError('Unexpected resource member: ' + name)
                if name in skip_files:
                    if not member.isfile():
                        raise ValueError('Only regular files may be reused')
                    continue
                destination = root / name
                # An archive-controlled symlink must never become a parent.
                parent = destination.parent
                while parent != root and parent != parent.parent:
                    if parent.is_symlink():
                        raise ValueError('Symlink parent in resource')
                    parent = parent.parent
                if name == '.':
                    if not member.isdir():
                        raise ValueError('Invalid root entry')
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                if member.isdir():
                    if destination.is_symlink():
                        raise ValueError('Directory overlaps symlink')
                    destination.mkdir(exist_ok=True)
                elif member.isfile():
                    if member.size != expected[5] or destination.is_symlink():
                        raise ValueError('File size or destination differs')
                    with archive.extractfile(member) as data, destination.open('xb') as output:
                        value = hashlib.sha256()
                        for chunk in iter(lambda: data.read(1024 * 1024), b''):
                            value.update(chunk)
                            output.write(chunk)
                    if value.hexdigest() != expected[6]:
                        raise ValueError('Extracted file hash differs')
                elif member.issym():
                    if member.linkname != expected[4]:
                        raise ValueError('Symlink target differs')
                    destination.symlink_to(member.linkname)
                elif member.islnk():
                    if member.linkname != expected[4]:
                        raise ValueError('Hard-link target differs')
                    target = root / canonical(member.linkname)
                    if target.is_symlink() or not target.is_file():
                        raise ValueError('Hard-link target not private')
                    os.link(target, destination)
                else:
                    raise ValueError('Unsupported runtime member')
                if not member.issym():
                    destination.chmod(member.mode & 0o777)
                count += 1
    return {'extractedMembers': count, 'archives': len(resources)}


if __name__ == '__main__':
    request = json.loads(pathlib.Path(sys.argv[1]).read_text('utf8'))
    print(json.dumps(extract(request['root'], request['manifest'], request['resources'], request.get('skipFiles', ()))))
