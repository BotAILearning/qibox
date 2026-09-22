"""Normalize Unix modes lost by fnpack's Windows filesystem adapter."""
import hashlib, io, pathlib, re, sys, tarfile, tempfile

filename = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='qibox-pack-') as temporary:
    app = pathlib.Path(temporary) / 'app.tgz'
    with tarfile.open(filename, 'r:*') as outer:
        original = outer.extractfile('app.tgz')
        original_hash = hashlib.md5()
        # Verify the vendor packer's checksum before modifying package metadata.
        while chunk := original.read(1024 * 1024): original_hash.update(chunk)
        manifest = outer.extractfile('manifest').read().decode('utf-8')
        expected = re.search(r'^checksum\s*=\s*(\S+)', manifest, re.M).group(1)
        if expected != original_hash.hexdigest(): raise ValueError('Unexpected fnpack checksum format')
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as contents:
            with tarfile.open(app, 'w:gz', compresslevel=1) as target:
                for entry in contents:
                    if entry.name.startswith('/') or '..' in pathlib.PurePosixPath(entry.name).parts or entry.issym() or entry.islnk(): raise ValueError('Unsafe application member')
                    entry.mode = 0o755 if entry.isdir() else 0o644
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.pax_headers = {}
                    target.addfile(entry, contents.extractfile(entry) if entry.isfile() else None)
        digest = hashlib.file_digest(app.open('rb'), 'md5').hexdigest()
        updated_manifest = re.sub(r'^(checksum\s*=\s*)\S+', lambda m: m[1]+digest, manifest, flags=re.M).encode('utf-8')
        pending = filename.with_suffix('.normalized.fpk')
        with tarfile.open(pending, 'w:gz', format=tarfile.USTAR_FORMAT, compresslevel=1) as target:
            for entry in outer:
                entry.mode = 0o755 if entry.isdir() or entry.name.startswith('cmd/') else 0o644
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ''
                entry.pax_headers = {}
                if entry.name == 'app.tgz':
                    entry.size = app.stat().st_size
                    with app.open('rb') as stream: target.addfile(entry, stream)
                elif entry.name == 'manifest':
                    entry.size = len(updated_manifest); target.addfile(entry, io.BytesIO(updated_manifest))
                else: target.addfile(entry, outer.extractfile(entry) if entry.isfile() else None)
    pending.replace(filename)
print('Unix modes normalized; app.tgz checksum updated.')
