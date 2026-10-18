"""Download hash-pinned Debian runtime libraries into isolated architecture supplements.

No package manager, post-install script, or host filesystem mutation is used.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import lzma
import pathlib
import re
import tarfile
import urllib.request
from email.parser import Parser

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / 'config/runtime-supplement-lock.json'
ARCHES = {'x64': {'debian': 'amd64', 'machine': 62, 'triplet': 'x86_64-linux-gnu'},
          'arm64': {'debian': 'arm64', 'machine': 183, 'triplet': 'aarch64-linux-gnu'}}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def official_index(lock: dict, arch: str) -> tuple[bytes, dict[str, dict]]:
    url = lock['packageIndexes'][ARCHES[arch]['debian']]
    with urllib.request.urlopen(url, timeout=60) as response:
        compressed = response.read()
    records = {}
    for paragraph in lzma.decompress(compressed).decode('utf8', 'replace').split('\n\n'):
        if paragraph.startswith('Package: '):
            record = Parser().parsestr(paragraph)
            if record.get('Architecture') == ARCHES[arch]['debian']:
                records[record['Package']] = dict(record.items())
    return compressed, records


def ar_members(data: bytes):
    if not data.startswith(b'!<arch>\n'):
        raise ValueError('download is not a Debian ar archive')
    cursor = 8
    while cursor < len(data):
        header = data[cursor:cursor + 60]
        if len(header) != 60 or header[58:60] != b'`\n':
            raise ValueError('malformed ar member header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58].decode('ascii').strip())
        start, end = cursor + 60, cursor + 60 + size
        yield name, data[start:end]
        cursor = end + (size & 1)


def norm_name(name: str) -> str:
    while name.startswith('./'):
        name = name[2:]
    name = name.lstrip('/')
    p = pathlib.PurePosixPath(name)
    if not name or '..' in p.parts:
        raise ValueError(f'unsafe package path: {name!r}')
    return p.as_posix()


def safe_link(path: str, target: str) -> None:
    if target.startswith('/'):
        raise ValueError(f'absolute symlink is not allowed in supplement: {path} -> {target}')
    parts = list(pathlib.PurePosixPath(path).parent.parts)
    for part in pathlib.PurePosixPath(target).parts:
        if part == '..':
            if not parts:
                raise ValueError(f'symlink escapes supplement root: {path} -> {target}')
            parts.pop()
        elif part not in ('', '.'):
            parts.append(part)


def load_elf_parser():
    script = ROOT / 'scripts/verify-runtime-architecture.py'
    spec = importlib.util.spec_from_file_location('runtime_architecture', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected_member(name: str, package: str, triplet: str) -> bool:
    if name == f'usr/share/doc/{package}/copyright':
        return True
    prefix = f'usr/lib/{triplet}/'
    if not name.startswith(prefix):
        return False
    leaf = pathlib.PurePosixPath(name).name
    return leaf.startswith('lib') and ('.so' in leaf)


def prepare_arch(arch: str, lock: dict) -> dict:
    spec = ARCHES[arch]
    base_inventory = json.loads((ROOT / '.cache/runtime-solid' / arch / 'inventory.json').read_text('utf8'))
    index_bytes, records = official_index(lock, arch)
    packages = lock['architectures'][arch]['packages']
    payload: dict[str, tuple[tarfile.TarInfo, bytes | None, str]] = {}
    deb_rows, elf_rows = [], []
    parser = load_elf_parser()
    for pinned in packages:
        record = records.get(pinned['name'])
        if not record:
            raise ValueError(f'{arch}: {pinned["name"]} absent from official bookworm index')
        for field in ('Version', 'Architecture', 'Filename', 'SHA256', 'Depends'):
            expected = {'Version': pinned['version'], 'Architecture': pinned['architecture'],
                        'Filename': pinned['url'].split('/debian/', 1)[-1],
                        'SHA256': pinned['debSha256'], 'Depends': pinned['depends']}[field]
            if record.get(field) != expected:
                raise ValueError(f'{arch}: lock/index mismatch for {pinned["name"]} field {field}: {record.get(field)!r} != {expected!r}')
        with urllib.request.urlopen(pinned['url'], timeout=60) as response:
            deb = response.read()
        if sha256(deb) != pinned['debSha256']:
            raise ValueError(f'{arch}: .deb SHA256 mismatch for {pinned["name"]}')
        members = dict(ar_members(deb))
        raw_data = members.get(pinned['dataMember'])
        if raw_data is None or sha256(raw_data) != pinned['dataSha256']:
            raise ValueError(f'{arch}: data archive hash mismatch for {pinned["name"]}')
        if not pinned['dataMember'].endswith('.xz'):
            raise ValueError(f'{arch}: unsupported data archive codec {pinned["dataMember"]}')
        with tarfile.open(fileobj=io.BytesIO(raw_data), mode='r:xz') as package_tar:
            for member in package_tar:
                name = norm_name(member.name)
                if not selected_member(name, pinned['name'], spec['triplet']):
                    continue
                info = tarfile.TarInfo(name)
                info.mode, info.uid, info.gid = member.mode, 0, 0
                info.uname, info.gname, info.mtime = '', '', 0
                content = None
                target = ''
                if member.isfile():
                    stream = package_tar.extractfile(member)
                    content = stream.read() if stream else b''
                    info.type, info.size = tarfile.REGTYPE, len(content)
                elif member.issym():
                    target = member.linkname
                    safe_link(name, target)
                    info.type, info.linkname, info.size = tarfile.SYMTYPE, target, 0
                else:
                    continue
                existing = base_inventory.get(name)
                if existing:
                    same = ((content is not None and existing[0] == '0' and existing[5] == len(content)
                             and existing[6] == sha256(content))
                            or (content is None and existing[0] == '2' and existing[4] == target))
                    if not same:
                        raise ValueError(f'{arch}: supplement would replace a non-identical base resource: {name}')
                    continue
                if content is not None and content.startswith(b'\x7fELF'):
                    parsed = parser.parse_elf(content)
                    parser.assert_machine(parsed['machine'], spec['machine'], name)
                    elf_rows.append({'path': name, 'machine': parser.machine_name(parsed['machine']),
                                     'needed': parsed['needed'], 'sha256': sha256(content)})
                prior = payload.get(name)
                identity = (sha256(content) if content is not None else target)
                if prior and prior[2] != identity:
                    raise ValueError(f'{arch}: conflicting package payload path {name}')
                payload[name] = (info, content, identity)
        deb_rows.append({'name': pinned['name'], 'version': pinned['version'], 'architecture': pinned['architecture'],
                         'url': pinned['url'], 'debSha256': pinned['debSha256'], 'dataMember': pinned['dataMember'],
                         'dataSha256': pinned['dataSha256'], 'officialDepends': pinned['depends'],
                         'packageIndexUrl': lock['packageIndexes'][spec['debian']], 'packageIndexSha256': sha256(index_bytes),
                         'verifiedAgainstOfficialIndex': True})

    out_dir = ROOT / '.cache/runtime-supplements' / arch
    out_dir.mkdir(parents=True, exist_ok=True)
    archive_path = out_dir / 'runtime-supplement.tar.xz'
    with tarfile.open(archive_path, mode='w:xz', format=tarfile.PAX_FORMAT) as output:
        for name in sorted(payload):
            info, content, _ = payload[name]
            output.addfile(info, io.BytesIO(content) if content is not None else None)
    files = []
    for name in sorted(payload):
        info, content, identity = payload[name]
        files.append({'path': name, 'type': 'file' if content is not None else 'symlink',
                      'size': len(content) if content is not None else 0,
                      'sha256': sha256(content) if content is not None else None,
                      'target': identity if content is None else None})
    manifest = {'format': 1, 'architecture': arch, 'platform': 'linux-' + ('x64' if arch == 'x64' else 'arm64'),
                'debianSuite': lock['suite'], 'packages': deb_rows,
                'archive': {'file': archive_path.name, 'sha256': sha256(archive_path.read_bytes()),
                            'size': archive_path.stat().st_size},
                'files': files, 'elfObjects': elf_rows,
                'constraints': ['Supplement only: merge as a separate private layer before dynamic-link auditing.',
                                'Contains selected runtime shared libraries, symlinks, and package copyright files only.',
                                'No maintainer scripts, apt state, or host filesystem changes.']}
    (out_dir / 'runtime-supplement.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    return {'architecture': arch, 'archive': str(archive_path.relative_to(ROOT)), 'sha256': manifest['archive']['sha256'],
            'size': manifest['archive']['size'], 'files': len(files), 'elfObjects': len(elf_rows)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', choices=['x64', 'arm64', 'all'], default='all')
    args = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text('utf8'))
    if lock.get('format') != 1 or lock.get('suite') != 'bookworm':
        raise ValueError('unsupported supplement lock format or suite')
    arches = ('x64', 'arm64') if args.arch == 'all' else (args.arch,)
    print(json.dumps([prepare_arch(arch, lock) for arch in arches], ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
