"""Apply the identity repair to a verified release without rebuilding its UI/runtime."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
base, output = map(pathlib.Path, sys.argv[1:3])
product = json.loads((root / 'config/product.json').read_text(encoding='utf-8'))
baseline_ref = 'a516afd31709040efceda179376c6af7c02e09de'
changes = ['server/ai-reply-rules.mjs', 'server/ai-reply-safety.mjs',
           'server/ai-service.mjs', 'server/ai-proactive.mjs']
replacements = {name: (root / name).read_bytes() for name in changes}
replacements['config/product.json'] = (root / 'config/product.json').read_bytes()
assert not output.exists(), 'Release packages must never be overwritten'
output.parent.mkdir(parents=True, exist_ok=True)
expected = {}
with tempfile.TemporaryDirectory(prefix='identity-fpk-', dir=output.parent) as temporary:
    payload = pathlib.Path(temporary) / 'app.tgz'
    with tarfile.open(base, 'r:gz') as outer:
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as source, \
                tarfile.open(payload, 'w:gz', compresslevel=1) as target:
            replaced = set()
            for entry in source:
                name = entry.name.removeprefix('./')
                assert not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
                assert entry.isdir() or entry.isfile()
                data = source.extractfile(entry).read() if entry.isfile() else None
                if name in changes:
                    baseline = subprocess.check_output(['git', 'show', baseline_ref + ':' + name], cwd=root)
                    assert data.replace(b'\r\n', b'\n') == baseline.replace(b'\r\n', b'\n'), 'Source baseline mismatch: ' + name
                if name == 'config/product.json':
                    previous = json.loads(data)
                    assert previous['buildId'] == '0.10.23-stable.002', 'Unexpected base release'
                if name in replacements:
                    data = replacements[name]
                    replaced.add(name)
                elif name == 'package.json':
                    package = json.loads(data)
                    package['version'] = product['version']
                    data = (json.dumps(package, indent=2) + '\n').encode()
                    replaced.add(name)
                if data is not None:
                    entry.size = len(data)
                    expected[name] = hashlib.sha256(data).hexdigest()
                target.addfile(entry, io.BytesIO(data) if data is not None else None)
            assert replaced == set(replacements) | {'package.json'}
        manifest = outer.extractfile('manifest').read().decode()
        manifest = re.sub(r'^(version\s*=\s*).*$', lambda m: m[1] + product['version'], manifest, flags=re.M)
        with payload.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'md5').hexdigest()
        manifest = re.sub(r'^(checksum\s*=\s*).*$', lambda m: m[1] + checksum, manifest, flags=re.M).encode()
        pending = pathlib.Path(temporary) / output.name
        with tarfile.open(pending, 'w:gz', format=tarfile.USTAR_FORMAT, compresslevel=1) as target:
            for entry in outer:
                if entry.name == 'app.tgz':
                    entry.size = payload.stat().st_size
                    with payload.open('rb') as stream:
                        target.addfile(entry, stream)
                elif entry.name == 'manifest':
                    entry.size = len(manifest)
                    target.addfile(entry, io.BytesIO(manifest))
                else:
                    target.addfile(entry, outer.extractfile(entry) if entry.isfile() else None)
    with tarfile.open(pending, 'r:gz') as outer, \
            tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as app:
        seen = {}
        for entry in app:
            if entry.isfile():
                seen[entry.name.removeprefix('./')] = hashlib.file_digest(app.extractfile(entry), 'sha256').hexdigest()
        assert seen == expected, 'Payload file verification failed'
    subprocess.run([sys.executable, str(root / 'scripts/verify-fpk.py'), str(pending), '--payload-only'], check=True)
    with pending.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    pending.rename(output)
output.with_suffix('.fpk.sha256').write_text(f'{digest}  {output.name}\n', encoding='utf-8')
info = {'version': product['version'], 'buildId': product['buildId'], 'package': str(output),
        'base': str(base), 'sha256': digest, 'verifiedFiles': len(expected),
        'changedPayloadFiles': sorted(replaced)}
output.with_suffix('.fpk.json').write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(info, ensure_ascii=False), flush=True)
