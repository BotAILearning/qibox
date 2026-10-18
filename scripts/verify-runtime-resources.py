"""Verify both offline containers and every compressed/file/link inventory byte.

This is architecture-independent archive validation, not runtime execution.
"""
import argparse
import hashlib
import json
import pathlib
import tarfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def hash_stream(stream):
    sha = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        sha.update(block)
    return sha.hexdigest()


class Meter:
    def __init__(self, source):
        self.source = source
        self.sha = hashlib.sha256()

    def read(self, size=-1):
        block = self.source.read(size)
        self.sha.update(block)
        return block


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'local/runtime-reuse-development-20261018/resource-integrity.json')
    args = parser.parse_args()
    results = {}
    for arch in ['x64', 'arm64']:
        started = time.monotonic()
        folder = ROOT / '.cache/runtime-bundled' / arch
        manifest = json.loads((folder / 'runtime-manifest.json').read_text('utf8'))
        offline = json.loads((folder / 'runtime-offline.json').read_text('utf8'))
        file = ROOT / '.cache/runtime-bundled' / offline['file']
        with file.open('rb') as source:
            if hash_stream(source) != offline['sha256'] or file.stat().st_size != offline['size']:
                raise ValueError('Offline container identity mismatch')
        resources = {r['file']: r for r in manifest['resources']}
        checked = set()
        members, regular, payload_bytes = 0, 0, 0
        with tarfile.open(file) as container:
            for resource_entry in container:
                resource = resources[resource_entry.name]
                if resource['file'] in checked or not resource_entry.isfile() or resource_entry.size != resource['size']:
                    raise ValueError('Container resource mismatch')
                checked.add(resource['file'])
                meter = Meter(container.extractfile(resource_entry))
                with tarfile.open(fileobj=meter, mode='r|xz') as archive:
                    for member in archive:
                        name = pathlib.PurePosixPath(member.name).as_posix()
                        expected = manifest['inventory'][name]
                        actual = [member.type.decode('ascii'), member.mode, member.uid, member.gid, member.linkname, member.size]
                        if actual != expected[:6]:
                            raise ValueError('Runtime metadata mismatch: ' + name)
                        if member.isfile():
                            digest = hash_stream(archive.extractfile(member))
                            if digest != expected[6]:
                                raise ValueError('Runtime file hash mismatch: ' + name)
                            regular += 1
                            payload_bytes += member.size
                        members += 1
                while meter.read(1024 * 1024):
                    pass
                if meter.sha.hexdigest() != resource['sha256']:
                    raise ValueError('Compressed resource hash differs')
        if checked != set(resources):
            raise ValueError('Missing container resource')
        results[arch] = {'passed': True, 'realDeviceAcceptance': False, 'containerBytes': file.stat().st_size,
                         'containerSha256': offline['sha256'], 'archives': len(checked), 'members': members,
                         'regularFiles': regular, 'uncompressedFileBytes': payload_bytes,
                         'seconds': round(time.monotonic() - started, 3)}
        print(json.dumps({'arch': arch, **results[arch]}), flush=True)
    out = args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
