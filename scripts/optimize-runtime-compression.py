"""Compare stronger lossless compression with the original tar stream."""
import hashlib
import json
import lzma
import pathlib
import sys
import time

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
pending = destination / 'x64-branch-filter.pending.tar.xz'
bcj = '--no-bcj' not in sys.argv[3:]
filters = ([{'id': lzma.FILTER_X86}] if bcj else []) + [{'id': lzma.FILTER_LZMA2, 'preset': 9 | lzma.PRESET_EXTREME}]
original = hashlib.sha256()
started = time.monotonic()
decoded_bytes = 0
with lzma.LZMAFile(source, 'r') as reader, lzma.LZMAFile(pending, 'w', filters=filters, check=lzma.CHECK_SHA256) as writer:
    while block := reader.read(1024 * 1024):
        original.update(block)
        decoded_bytes += len(block)
        writer.write(block)
restored = hashlib.sha256()
with lzma.LZMAFile(pending, 'r') as reader:
    while block := reader.read(1024 * 1024):
        restored.update(block)
if original.digest() != restored.digest():
    raise ValueError('Recompression changed the runtime tar stream')
with pending.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
target = destination / (digest + '-data.tar.xz')
pending.replace(target)
result = {'source': source.name, 'file': target.name, 'sha256': digest, 'bytes': target.stat().st_size,
          'sourceBytes': source.stat().st_size, 'savedBytes': source.stat().st_size - target.stat().st_size,
          'tarSha256': original.hexdigest(), 'decodedBytes': decoded_bytes,
          'seconds': round(time.monotonic() - started, 2), 'filter': 'x86' if bcj else 'none', 'preset': '9e'}
(destination / 'compression-proof.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result), flush=True)
