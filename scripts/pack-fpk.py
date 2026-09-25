"""Assemble an FPK with standard tar/gzip, then verify every staged file.

The layout matches the project's verified fnpack-generated FPK: app.tgz,
manifest with the payload MD5, cmd/, config/, wizard/ and both icons.
This does not execute fnpack or change operating-system application policies.
"""
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
stage = root / 'build/qibox-all'
product = json.loads((root / 'config/product.json').read_text(encoding='utf-8'))
version = product['version']
manifest = dict(line.split('=', 1) for line in (stage / 'manifest').read_text(encoding='utf-8').splitlines() if '=' in line)
assert manifest['version'] == version and manifest['platform'] == 'all'
assert json.loads((stage / 'app/config/product.json').read_text(encoding='utf-8'))['version'] == version
build_id = product.get('buildId', version)
output = root / 'dist' / 'releases' / version / build_id / f'qibox-{build_id}-all.fpk'
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise FileExistsError(f'Refusing to overwrite existing release: {output}')

def normalize(entry):
    assert not entry.issym() and not entry.islnk()
    assert entry.isfile() or entry.isdir()
    entry.mode = 0o755 if entry.isdir() or entry.name.startswith('cmd/') else 0o644
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = ''
    entry.pax_headers = {}
    return entry

def file_hash(filename, algorithm='sha256'):
    with filename.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()

with tempfile.TemporaryDirectory(prefix='qibox-fpk-', dir=output.parent) as temporary:
    temporary = pathlib.Path(temporary)
    payload = temporary / 'app.tgz'
    print('Archiving staged application and both runtime architectures', flush=True)
    with tarfile.open(payload, 'w:gz', format=tarfile.PAX_FORMAT, compresslevel=1) as archive:
        for child in sorted((stage / 'app').iterdir()):
            archive.add(child, arcname=child.name, filter=normalize)
    manifest['checksum'] = file_hash(payload, 'md5')
    manifest_bytes = ('\n'.join(f'{key} = {value}' for key, value in manifest.items()) + '\n').encode('utf-8')
    pending = temporary / output.name
    print('Assembling FPK archive', flush=True)
    with tarfile.open(pending, 'w:gz', format=tarfile.USTAR_FORMAT, compresslevel=1) as archive:
        archive.add(payload, arcname='app.tgz', filter=normalize)
        for name in ['cmd', 'config', 'ICON.PNG', 'ICON_256.PNG', 'wizard']:
            archive.add(stage / name, arcname=name, filter=normalize)
        entry = tarfile.TarInfo('manifest')
        entry.size = len(manifest_bytes)
        archive.addfile(normalize(entry), io.BytesIO(manifest_bytes))
    print('Verifying full staged-file parity', flush=True)
    expected = {p.relative_to(stage / 'app').as_posix(): file_hash(p) for p in (stage / 'app').rglob('*') if p.is_file()}
    with tarfile.open(pending, 'r:gz') as outer:
        outer_expected = {p.relative_to(stage).as_posix(): file_hash(p) for name in ['cmd', 'config', 'wizard'] for p in (stage / name).rglob('*') if p.is_file()}
        for name in ['ICON.PNG', 'ICON_256.PNG']:
            outer_expected[name] = file_hash(stage / name)
        outer_seen = set()
        for entry in outer.getmembers():
            if not entry.isfile() or entry.name in ('manifest', 'app.tgz'):
                continue
            assert entry.name in outer_expected and entry.name not in outer_seen, entry.name
            assert hashlib.file_digest(outer.extractfile(entry), 'sha256').hexdigest() == outer_expected[entry.name], entry.name
            outer_seen.add(entry.name)
        assert outer_seen == outer_expected.keys()
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as archive:
            seen = set()
            for entry in archive:
                if not entry.isfile():
                    continue
                assert entry.name not in seen and entry.name in expected, entry.name
                assert hashlib.file_digest(archive.extractfile(entry), 'sha256').hexdigest() == expected[entry.name], entry.name
                seen.add(entry.name)
            assert seen == expected.keys()
    subprocess.run([sys.executable, str(root / 'scripts/verify-fpk.py'), str(pending)], check=True)
    digest = file_hash(pending)
    output.parent.mkdir(exist_ok=True)
    pending.rename(output)
    output.with_suffix('.fpk.sha256').write_text(f'{digest}  {output.name}\n', encoding='utf-8')
    print(json.dumps({'file': str(output), 'bytes': output.stat().st_size, 'sha256': digest, 'verifiedFiles': len(expected)}, ensure_ascii=False), flush=True)
