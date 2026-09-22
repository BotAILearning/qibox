"""Verify real official extraction; emulate only symlink syscalls on Windows."""
import importlib.util, json, os, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).resolve().parents[1] / 'server/install-deb.py')
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
links = []
architecture = sys.argv[4] if len(sys.argv) > 4 else 'amd64'
progress_count, last_bytes, progress_total = 0, 0, None
def progress(written, total):
    global progress_count, last_bytes, progress_total
    assert last_bytes <= written <= total
    if progress_count == 0: assert written == 0
    else: assert progress_total == total
    progress_count += 1; last_bytes = written; progress_total = total
def record_link(self, target, target_is_directory=False): links.append((self, target))
if os.name == 'nt':
    with patch.object(pathlib.Path, 'symlink_to', record_link): result = installer.inspect_and_extract(pathlib.Path(sys.argv[1]), sys.argv[2], progress, architecture)
    for filename, target in links:
        resolved = filename.parent.joinpath(target).resolve()
        assert resolved.is_file(), (filename, target)
    result['symlinkCreation'] = 'Windows has no symlink privilege; validated targets, syscall emulated only for this test'
    result['validatedLinks'] = len(links)
else:
    result = installer.inspect_and_extract(pathlib.Path(sys.argv[1]), sys.argv[2], progress, architecture)
actual_bytes = sum(file.stat().st_size for file in pathlib.Path(sys.argv[2]).rglob('*') if file.is_file() and not file.is_symlink())
assert progress_count > 2 and last_bytes == progress_total == actual_bytes
result['progress'] = {'updates': progress_count, 'bytes': last_bytes, 'total': progress_total, 'matchesExtractedFiles': True}
result['status'] = 'passed'
pathlib.Path(sys.argv[3]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
