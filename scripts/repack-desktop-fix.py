"""Preserve a verified release payload while replacing the desktop window fix."""
import hashlib, io, json, pathlib, re, subprocess, sys, tarfile, tempfile

base, output = map(pathlib.Path, sys.argv[1:3])
version = sys.argv[3]
root = pathlib.Path(__file__).resolve().parents[1]
assert not output.exists()
output.parent.mkdir(parents=True, exist_ok=True)
replacement = (root / 'server/desktop.mjs').read_bytes()
expected = {}
with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
    payload = pathlib.Path(temporary) / 'app.tgz'
    with tarfile.open(base, 'r:gz') as outer:
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as source, tarfile.open(payload, 'w:gz', compresslevel=1) as target:
            for entry in source:
                name = entry.name.removeprefix('./')
                assert not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
                assert entry.isdir() or entry.isfile()
                data = source.extractfile(entry).read() if entry.isfile() else None
                if name == 'server/desktop.mjs':
                    assert data.replace(b'\r\n', b'\n') == subprocess.check_output(['git', 'show', 'HEAD:server/desktop.mjs'], cwd=root).replace(b'\r\n', b'\n')
                    data = replacement
                elif name == 'config/product.json':
                    product = json.loads(data)
                    assert product['buildId'] == '0.9.71-debug.001'
                    product.update(version=version, buildId=version + '-debug.001', channel='debug')
                    data = (json.dumps(product, ensure_ascii=False, indent=2) + '\n').encode()
                elif name == 'package.json':
                    product = json.loads(data); product['version'] = version
                    data = (json.dumps(product, indent=2) + '\n').encode()
                if data is not None:
                    entry.size = len(data); expected[name] = hashlib.sha256(data).hexdigest()
                target.addfile(entry, io.BytesIO(data) if data is not None else None)
        manifest = outer.extractfile('manifest').read().decode()
        manifest = re.sub(r'^(version\s*=\s*).*$', lambda m: m[1] + version, manifest, flags=re.M)
        with payload.open('rb') as stream: checksum = hashlib.file_digest(stream, 'md5').hexdigest()
        manifest = re.sub(r'^(checksum\s*=\s*).*$', lambda m: m[1] + checksum, manifest, flags=re.M).encode()
        with tarfile.open(output, 'w:gz', format=tarfile.USTAR_FORMAT, compresslevel=1) as target:
            for entry in outer:
                if entry.name == 'app.tgz':
                    entry.size = payload.stat().st_size
                    with payload.open('rb') as stream: target.addfile(entry, stream)
                elif entry.name == 'manifest':
                    entry.size = len(manifest); target.addfile(entry, io.BytesIO(manifest))
                else: target.addfile(entry, outer.extractfile(entry) if entry.isfile() else None)
    with tarfile.open(output, 'r:gz') as outer, tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as app:
        seen = {}
        for entry in app:
            if entry.isfile(): seen[entry.name.removeprefix('./')] = hashlib.file_digest(app.extractfile(entry), 'sha256').hexdigest()
        assert seen == expected
    subprocess.run([sys.executable, str(root / 'scripts/verify-fpk.py'), str(output), '--payload-only'], check=True)
with output.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
output.with_suffix('.fpk.sha256').write_text(f'{digest}  {output.name}\n')
print(json.dumps({'package': str(output), 'sha256': digest, 'verifiedFiles': len(expected), 'changedPayloadFiles': ['server/desktop.mjs', 'config/product.json', 'package.json']}), flush=True)
