"""Verify the release's Debian corresponding-source files without executing them."""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
directory = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.cache/corresponding-source'
lock = json.loads((ROOT / 'config/runtime-source-lock.json').read_text('utf8'))
assert lock['format'] == 1 and not lock['errors']
references = []
for source in lock['sources']:
    descriptors = []
    for item in source['files']:
        relative = pathlib.PurePosixPath(item['file'])
        assert not relative.is_absolute() and '..' not in relative.parts
        file = directory.joinpath(*relative.parts)
        assert file.stat().st_size == item['bytes'], item['file']
        with file.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256'], item['file']
        if file.suffix == '.dsc':
            descriptors.append(file)
    assert len(descriptors) == 1
    descriptor = descriptors[0].read_text('utf8')
    assert re.search(r'^Source: (.+)$', descriptor, re.M)[1] == source['source']
    assert re.search(r'^Version: (.+)$', descriptor, re.M)[1].split(':')[-1] == source['version']
    checksums = dict((name, (sha, int(size))) for sha, size, name in re.findall(
        r'^ ([a-f0-9]{64})\s+(\d+)\s+(\S+)$', descriptor.split('Checksums-Sha256:\n', 1)[1].split('\n\n')[0], re.M))
    for item in source['files']:
        if not item['file'].endswith('.dsc'):
            assert checksums[pathlib.PurePosixPath(item['file']).name] == (item['sha256'], item['bytes'])
    references.extend((b['arch'], b['name'], b['version'], b['debSha256']) for b in source['binaries'])
expected = []
for arch, name in [('x64', 'runtime-lock.json'), ('arm64', 'runtime-lock-arm64.json')]:
    for package in json.loads((ROOT / 'config' / name).read_text('utf8'))['packages']:
        expected.append((arch, package['name'], package['version'], package['debSha256']))
for arch, data in json.loads((ROOT / 'config/runtime-supplement-lock.json').read_text('utf8'))['architectures'].items():
    expected.extend((arch, p['name'], p['version'], p['debSha256']) for p in data['packages'])
assert sorted(references) == sorted(expected) and len(references) == lock['binaryReferences']
print(json.dumps({'verified': True, 'sourceGroups': len(lock['sources']), 'binaryReferences': len(references)}))
