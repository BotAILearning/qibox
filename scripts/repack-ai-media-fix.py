"""Replace the AI flow/media fix in the verified 0.10.43 dual-arch payload."""
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
base_sha = '57fee8032f94824261a582cc880447f87365ec8066a79387471cf24e42ca4c49'
base_source = '04727f9e1ec8e103030742deeca431640ed55757'
with base.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == base_sha
assert not output.exists()
product = json.loads((root / 'config/product.json').read_text(encoding='utf-8'))
assert product['buildId'] == '0.10.44-stable.001' and product['version'] == '0.10.44'
replacements = {name: (root / name).read_bytes() for name in [
    'server/ai-data.mjs', 'server/ai-native-render.py', 'server/ai-native-voice.py',
    'server/ai-native.py', 'server/ai-prompts.mjs', 'server/ai-provider.mjs',
    'server/ai-service.mjs', 'server/wechat-data.py', 'server/wechat-images.py',
    'public/app.js', 'public/index.html', 'config/product.json']}
added = 'server/ai-media-input.mjs'
output.parent.mkdir(parents=True, exist_ok=True)
expected, changed = {}, []
with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
    payload = pathlib.Path(temporary) / 'app.tgz'
    with tarfile.open(base, 'r:gz') as outer:
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as source, tarfile.open(payload, 'w:gz', compresslevel=1) as target:
            for entry in source:
                name = entry.name.removeprefix('./')
                assert not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
                assert entry.isdir() or entry.isfile()
                assert name != added
                data = source.extractfile(entry).read() if entry.isfile() else None
                if name in replacements:
                    if name.startswith('server/'):
                        previous = subprocess.check_output(['git', 'show', base_source + ':' + name], cwd=root)
                        assert data.replace(b'\r\n', b'\n') == previous.replace(b'\r\n', b'\n'), name
                    elif name == 'config/product.json':
                        assert json.loads(data)['buildId'] == '0.10.43-stable.001'
                    data = replacements.pop(name)
                    changed.append(name)
                elif name == 'package.json':
                    package = json.loads(data)
                    assert package['version'] == '0.10.43'
                    package['version'] = product['version']
                    data = (json.dumps(package, indent=2) + '\n').encode()
                    changed.append(name)
                if data is not None:
                    entry.size = len(data)
                    sha = hashlib.sha256(data).hexdigest()
                    # The verified base repeats two identical fnOS config
                    # entries. Preserve them, rejecting conflicting duplicates.
                    assert name not in expected or expected[name] == sha, name
                    expected[name] = sha
                target.addfile(entry, io.BytesIO(data) if data is not None else None)
            assert not replacements, list(replacements)
            data = (root / added).read_bytes()
            entry = tarfile.TarInfo(added)
            entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
            target.addfile(entry, io.BytesIO(data))
            expected[added] = hashlib.sha256(data).hexdigest()
            changed.append(added)
        manifest = outer.extractfile('manifest').read().decode()
        manifest = re.sub(r'^(version\s*=\s*).*$', lambda m: m[1] + product['version'], manifest, flags=re.M)
        with payload.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'md5').hexdigest()
        manifest = re.sub(r'^(checksum\s*=\s*).*$', lambda m: m[1] + checksum, manifest, flags=re.M).encode()
        with tarfile.open(output, 'w:gz', format=tarfile.USTAR_FORMAT, compresslevel=1) as target:
            for entry in outer:
                if entry.name == 'app.tgz':
                    entry.size = payload.stat().st_size
                    with payload.open('rb') as stream: target.addfile(entry, stream)
                elif entry.name == 'manifest':
                    entry.size = len(manifest)
                    target.addfile(entry, io.BytesIO(manifest))
                else:
                    target.addfile(entry, outer.extractfile(entry) if entry.isfile() else None)
    with tarfile.open(output, 'r:gz') as outer, tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as app:
        seen = {}
        for entry in app:
            if entry.isfile():
                seen[entry.name.removeprefix('./')] = hashlib.file_digest(app.extractfile(entry), 'sha256').hexdigest()
        assert seen == expected
    subprocess.run([sys.executable, str(root / 'scripts/verify-fpk.py'), str(output), '--payload-only'], check=True)
with output.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
output.with_suffix('.fpk.sha256').write_text(f'{digest}  {output.name}\n')
print(json.dumps({'package': str(output), 'sha256': digest, 'verifiedFiles': len(expected),
                  'changedPayloadFiles': sorted(changed)}, ensure_ascii=False), flush=True)
