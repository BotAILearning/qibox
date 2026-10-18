"""Complete bundled runtimes: shared architecture resources, local preparation.

Every fallback byte ships in the universal FPK. Host reuse saves expanded disk
space only; it is never counted as a smaller store download.
"""
import hashlib
import importlib.util
import json
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.cache/runtime-bundled'


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def safe(name):
    if name.startswith('/') or '\\' in name or '..' in name.split('/'):
        raise ValueError('Unsafe runtime path')
    return pathlib.PurePosixPath(name).as_posix()


def offline_bundle(manifest, folder):
    file = OUT / ('qibox-runtime-' + manifest['arch'] + '-' + manifest['identity'][:16] + '.qir')
    index = folder / 'runtime-offline.json'
    previous = json.loads(index.read_text('utf8')) if index.exists() else {}
    if not file.exists() or previous.get('identity') != manifest['identity'] or digest(file) != previous.get('sha256'):
        with tarfile.open(file, 'w', format=tarfile.PAX_FORMAT) as tar:
            for resource in manifest['resources']:
                entry = tarfile.TarInfo(resource['file'])
                entry.mode, entry.size = 0o600, resource['size']
                with (OUT / 'resources' / resource['file']).open('rb') as source:
                    tar.addfile(entry, source)
        previous = {'arch': manifest['arch'], 'identity': manifest['identity'], 'file': file.name,
                    'size': file.stat().st_size, 'sha256': digest(file), 'delivery': 'optional offline repair; complete resources also ship inside FPK'}
        index.write_text(json.dumps(previous) + '\n', encoding='utf8')


def main():
    (OUT / 'resources').mkdir(parents=True, exist_ok=True)
    compatibility = json.loads((ROOT / 'config/runtime-compatibility.json').read_text('utf8'))
    for arch in ['x64', 'arm64']:
        lock = json.loads((ROOT / '.cache/runtime-solid' / arch / 'runtime-lock.json').read_text('utf8'))
        inventory = json.loads((ROOT / '.cache/runtime-solid' / arch / 'inventory.json').read_text('utf8'))
        supplement = json.loads((ROOT / '.cache/runtime-supplements' / arch / 'runtime-supplement.json').read_text('utf8'))
        base_identity = hashlib.sha256(json.dumps({'lock': lock, 'inventory': inventory, 'compatibility': compatibility.get(arch),
                                                   'supplement': supplement, 'delivery': 'bundled-v2'}, sort_keys=True).encode()).hexdigest()
        folder = OUT / arch
        folder.mkdir(exist_ok=True)
        file = folder / 'runtime-manifest.json'
        existing = json.loads(file.read_text('utf8')) if file.exists() else {}
        if existing.get('identity') == base_identity and all((OUT / 'resources' / r['file']).is_file() and digest(OUT / 'resources' / r['file']) == r['sha256'] for r in existing['resources']):
            offline_bundle(existing, folder)
            print(json.dumps({'arch': arch, 'cached': True, 'delivery': 'complete-bundled'}), flush=True)
            continue
        manifest = {'format': 1, 'identity': base_identity, 'arch': arch, 'minimumGlibc': '2.36', 'delivery': 'complete-bundled',
                    'profile': compatibility.get(arch, {}).get('profile'), 'resources': [], 'files': {}, 'host': {},
                    'inventory': inventory, 'sources': lock['packages'] + supplement['packages'], 'realDeviceAcceptance': False}

        def add_archive(source, expected_sha, kind, additional=False):
            if digest(source) != expected_sha:
                raise ValueError('Bundled runtime source hash differs')
            resource = {'id': expected_sha, 'sha256': expected_sha, 'version': base_identity, 'size': source.stat().st_size,
                        'file': expected_sha + '.tar.xz', 'kind': kind}
            target = OUT / 'resources' / resource['file']
            if not target.exists() or digest(target) != expected_sha:
                shutil.copyfile(source, target)
            manifest['resources'].append(resource)
            with tarfile.open(source) as tar:
                for member in tar:
                    name = safe(member.name)
                    if additional:
                        if name in inventory:
                            raise ValueError('Supplement overlaps original runtime: ' + name)
                        content = hashlib.sha256(tar.extractfile(member).read()).hexdigest() if member.isfile() else None
                        inventory[name] = [member.type.decode('ascii'), member.mode, member.uid, member.gid, member.linkname, member.size, content]
                    if member.isfile():
                        expected = inventory[name]
                        if name in manifest['files']:
                            raise ValueError('Duplicate archive file: ' + name)
                        manifest['files'][name] = {'sha256': expected[6], 'size': member.size, 'mode': member.mode, 'resource': expected_sha}
        for entry in lock['archives']:
            add_archive(ROOT / '.cache/runtime-solid/shared' / entry['payloadFile'], entry['payloadSha256'], 'private')
        add_archive(ROOT / '.cache/runtime-supplements' / arch / supplement['archive']['file'], supplement['archive']['sha256'], 'private-supplement', True)
        hardlink_targets = {pathlib.PurePosixPath(entry[4]).as_posix() for entry in inventory.values() if entry[0] == '1'}
        candidates = compatibility.get(arch, {}).get('files', {})
        for name, file_info in manifest['files'].items():
            media = pathlib.PurePosixPath(name).name.startswith(('ffmpeg', 'ffprobe', 'libav', 'libswresample', 'libswscale', 'libpostproc'))
            if media or name in hardlink_targets or file_info['resource'] == supplement['archive']['sha256']:
                continue
            row = candidates.get(name)
            if row:
                manifest['host'][name] = {'path': row['target'], 'sha256': row['sha256'], 'kind': 'identical' if row['sha256'] == file_info['sha256'] else 'tested-profile'}
            elif arch == 'arm64' and name.startswith(('usr/lib/python3.11/', 'usr/share/')):
                manifest['host'][name] = {'path': '/' + name, 'sha256': file_info['sha256'], 'kind': 'identical'}
        manifest['unpackedBytes'] = sum(f['size'] for f in manifest['files'].values())
        file.write_text(json.dumps(manifest, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf8')
        offline_bundle(manifest, folder)
        print(json.dumps({'arch': arch, 'delivery': manifest['delivery'], 'bundledBytes': sum(r['size'] for r in manifest['resources']),
                          'hostCandidates': len(manifest['host']), 'unpackedFileBytes': manifest['unpackedBytes']}), flush=True)


if __name__ == '__main__':
    main()
