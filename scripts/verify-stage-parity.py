"""Verify every staged file against the corresponding FPK application file."""
import hashlib
import json
import pathlib
import sys
import tarfile
import tempfile

package = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
expected = {file.relative_to(stage).as_posix(): hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
            for file in stage.rglob('*') if file.is_file()}
actual = {}
with tempfile.TemporaryFile() as temp:
    with tarfile.open(package) as outer:
        reader = outer.extractfile('app.tgz')
        while block := reader.read(1024 * 1024): temp.write(block)
    temp.seek(0)
    with tarfile.open(fileobj=temp, mode='r|gz') as archive:
        for member in archive:
            if member.isfile():
                name = member.name.removeprefix('./')
                if name in actual: raise ValueError('Duplicate application file: ' + name)
                actual[name] = hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest()
missing = sorted(set(expected) - set(actual))
extra = sorted(set(actual) - set(expected) - {'config/privilege', 'config/resource'})
different = sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name])
if missing or extra or different:
    raise ValueError(json.dumps({'missing': missing, 'extra': extra, 'different': different}))
print(json.dumps({'stagedFiles': len(expected), 'packageFiles': len(actual), 'mismatches': 0}))
