"""Static, non-executing ELF and resource-architecture audit for solid runtimes.

This checks archive identities, target machines, DT_NEEDED closure, dynamic
symbol/version metadata, and the existing host-reuse selection policy. It does
not emulate a Linux loader or prove NAS/device execution.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import posixpath
import re
import struct
import sys
import tarfile
import traceback
from collections import defaultdict, deque

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCHES = {
    'x64': {'lock': 'runtime-lock.json', 'machine': 62, 'platform': 'linux-x64', 'triple': 'x86_64-linux-gnu'},
    'arm64': {'lock': 'runtime-lock-arm64.json', 'machine': 183, 'platform': 'linux-arm64', 'triple': 'aarch64-linux-gnu'},
}
HOST_SONAME_PACKAGE = {
    'libc6': re.compile(r'^(?:libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|libresolv\.so\.2|libutil\.so\.1|libanl\.so\.1|ld-linux[^/]*\.so(?:\.[0-9]+)*|ld64\.so(?:\.[0-9]+)*)$'),
    'libgcc-s1': re.compile(r'^libgcc_s\.so\.1$'),
    'zlib1g': re.compile(r'^libz\.so\.1$'),
    'libbz2-1.0': re.compile(r'^libbz2\.so\.1\.0$'),
    'liblzma5': re.compile(r'^liblzma\.so\.5$'),
    'libzstd1': re.compile(r'^libzstd\.so\.1$'),
    'libcrypt1': re.compile(r'^libcrypt\.so\.1$'),
}
HOST_ALWAYS = {'linux-vdso.so.1', 'linux-gate.so.1'}
MEDIA_PREFIXES = ('ffmpeg', 'ffprobe', 'libav', 'libswresample', 'libswscale', 'libpostproc')
VERSION_RE = re.compile(r'^(GLIBC(?:XX)?|CXXABI)_(\d+(?:\.\d+)+)$')


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def machine_name(value: int) -> str:
    return {62: 'EM_X86_64', 183: 'EM_AARCH64'}.get(value, f'EM_{value}')


def assert_machine(machine: int, expected: int, path: str = '<ELF>') -> None:
    if machine != expected:
        raise ValueError(f'{path}: ELF machine {machine_name(machine)} ({machine}) does not match {machine_name(expected)} ({expected})')


def select_architecture(arch: str, lock_platform: str | None = None) -> dict:
    if arch not in ARCHES:
        raise ValueError(f'Unsupported resource architecture: {arch}')
    selected = ARCHES[arch]
    if lock_platform is not None and lock_platform != selected['platform']:
        raise ValueError(f'Resource selection mismatch: requested {arch} requires {selected["platform"]}, lock is {lock_platform}')
    return selected


def version_tuple(value: str) -> tuple[int, ...]:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise ValueError(f'Unsupported ELF version name: {value}')
    return tuple(int(part) for part in match.group(2).split('.'))


def check_version_requirements(required: set[str], provided: set[str], label: str) -> dict:
    missing = sorted((version for version in required if version not in provided), key=version_tuple)
    maximum = max(provided, key=version_tuple) if provided else None
    return {'required': sorted(required, key=version_tuple), 'maximumProvided': maximum,
            'missingExactDefinitions': missing, 'pass': not missing, 'label': label}


def _slice(data: bytes, offset: int, size: int, what: str) -> bytes:
    if offset < 0 or size < 0 or offset + size > len(data):
        raise ValueError(f'ELF bounds error reading {what}')
    return data[offset:offset + size]


def _cstr(data: bytes, offset: int, what: str) -> str:
    if offset < 0 or offset >= len(data):
        raise ValueError(f'ELF string offset outside {what}')
    end = data.find(b'\0', offset)
    if end < 0:
        raise ValueError(f'Unterminated ELF string in {what}')
    return data[offset:end].decode('utf8', 'replace')


def parse_elf(data: bytes) -> dict | None:
    if data[:4] != b'\x7fELF':
        return None
    if len(data) < 64 or data[4] != 2 or data[5] != 1:
        raise ValueError('Expected a complete little-endian ELF64 object')
    e_type, machine = struct.unpack_from('<HH', data, 16)
    phoff, shoff = struct.unpack_from('<QQ', data, 32)
    phentsize, phnum, shentsize, shnum, shstrndx = struct.unpack_from('<HHHHH', data, 54)
    if phentsize not in (0, 56) or shentsize not in (0, 64):
        raise ValueError('Unexpected ELF64 header entry size')

    phdrs = []
    for i in range(phnum):
        phdrs.append(struct.unpack('<IIQQQQQQ', _slice(data, phoff + i * phentsize, 56, 'program header')))

    def vaddr_offset(address: int) -> int:
        for typ, _flags, offset, vaddr, _paddr, filesz, _memsz, _align in phdrs:
            if typ == 1 and vaddr <= address < vaddr + filesz:
                return offset + address - vaddr
        raise ValueError('ELF dynamic string table is not in a file-backed PT_LOAD segment')

    dynamic_rows = []
    dynamic_ph = next((p for p in phdrs if p[0] == 2), None)
    if dynamic_ph:
        for off in range(dynamic_ph[2], dynamic_ph[2] + dynamic_ph[5], 16):
            tag, value = struct.unpack('<qQ', _slice(data, off, 16, 'dynamic entry'))
            if tag == 0:
                break
            dynamic_rows.append((tag, value))
    d = defaultdict(list)
    for tag, value in dynamic_rows:
        d[tag].append(value)
    strtab = None
    if d[5]:
        strtab = vaddr_offset(d[5][0])
    strsz = d[10][0] if d[10] else 0
    dynstr = _slice(data, strtab, strsz, 'dynamic string table') if strtab is not None and strsz else b''
    needed = [_cstr(dynstr, val, 'dynamic string table') for val in d[1]]
    soname = _cstr(dynstr, d[14][0], 'dynamic string table') if d[14] else None
    interpreter = None
    for ph in phdrs:
        if ph[0] == 3:
            interpreter = _cstr(_slice(data, ph[2], ph[5], 'PT_INTERP'), 0, 'PT_INTERP')
            break

    sections = []
    if shoff and shnum and shentsize == 64:
        raw_sections = [struct.unpack('<IIQQQQIIQQ', _slice(data, shoff + i * shentsize, 64, 'section header')) for i in range(shnum)]
        if shstrndx < len(raw_sections):
            namehdr = raw_sections[shstrndx]
            names = _slice(data, namehdr[4], namehdr[5], 'section-name string table')
            for row in raw_sections:
                name = _cstr(names, row[0], 'section-name string table') if row[0] < len(names) else ''
                sections.append({'name': name, 'type': row[1], 'offset': row[4], 'size': row[5], 'link': row[6], 'info': row[7], 'entsize': row[9]})

    by_name = {s['name']: s for s in sections}
    dynsym_section = next((s for s in sections if s['type'] == 11 and s['entsize'] == 24), None)
    imports, exports = [], []
    versym = []
    versym_section = by_name.get('.gnu.version')
    if versym_section:
        raw = _slice(data, versym_section['offset'], versym_section['size'], '.gnu.version')
        versym = [struct.unpack_from('<H', raw, i)[0] for i in range(0, len(raw) - 1, 2)]

    verneed_by_index = {}
    verneed_section = by_name.get('.gnu.version_r')
    if verneed_section and dynstr:
        raw = _slice(data, verneed_section['offset'], verneed_section['size'], '.gnu.version_r')
        off = 0
        while off + 16 <= len(raw):
            _version, count, file_idx, aux_off, next_off = struct.unpack_from('<HHIII', raw, off)
            file_name = _cstr(dynstr, file_idx, 'dynamic string table')
            aux = off + aux_off
            for _ in range(count):
                if aux + 16 > len(raw):
                    raise ValueError('Truncated ELF version requirement auxiliary entry')
                _hash, _flags, other, name_idx, aux_next = struct.unpack_from('<IHHII', raw, aux)
                verneed_by_index[other & 0x7fff] = {'name': _cstr(dynstr, name_idx, 'dynamic string table'), 'file': file_name}
                if not aux_next:
                    break
                aux += aux_next
            if not next_off:
                break
            off += next_off

    verdef_by_index = {}
    verdef_section = by_name.get('.gnu.version_d')
    if verdef_section and dynstr:
        raw = _slice(data, verdef_section['offset'], verdef_section['size'], '.gnu.version_d')
        off = 0
        while off + 20 <= len(raw):
            _version, _flags, ndx, count, _hash, aux_off, next_off = struct.unpack_from('<HHHHIII', raw, off)
            aux = off + aux_off
            if count and aux + 8 <= len(raw):
                name_idx, _aux_next = struct.unpack_from('<II', raw, aux)
                verdef_by_index[ndx & 0x7fff] = _cstr(dynstr, name_idx, 'dynamic string table')
            if not next_off:
                break
            off += next_off

    symbol_table_available = dynsym_section is not None
    if dynsym_section:
        symtab = _slice(data, dynsym_section['offset'], dynsym_section['size'], '.dynsym')
        linked = dynsym_section['link']
        if linked >= len(sections):
            raise ValueError('Invalid .dynsym string-table link')
        strhdr = sections[linked]
        strings = _slice(data, strhdr['offset'], strhdr['size'], '.dynstr')
        count = len(symtab) // dynsym_section['entsize']
        for index in range(count):
            st_name, st_info, st_other, st_shndx, _value, _size = struct.unpack_from('<IBBHQQ', symtab, index * 24)
            if not st_name:
                continue
            name = _cstr(strings, st_name, '.dynstr')
            if not name:
                continue
            bind, visibility = st_info >> 4, st_other & 3
            vindex = (versym[index] & 0x7fff) if index < len(versym) else 1
            if st_shndx == 0:
                version = verneed_by_index.get(vindex, {}).get('name') if vindex > 1 else None
                verfile = verneed_by_index.get(vindex, {}).get('file') if vindex > 1 else None
                if bind != 2:  # weak undefined references are optional
                    imports.append({'name': name, 'version': version, 'file': verfile})
            elif bind in (1, 2, 10) and visibility in (0, 3):
                version = verdef_by_index.get(vindex) if vindex > 1 else None
                exports.append({'name': name, 'version': version})

    return {'machine': machine, 'type': e_type, 'needed': needed, 'soname': soname,
            'interpreter': interpreter, 'imports': imports, 'exports': exports,
            'symbolTableAvailable': symbol_table_available}


def norm_member(name: str) -> str:
    while name.startswith('./'):
        name = name[2:]
    return name or '.'


def inventory_match(member: tarfile.TarInfo, expected: list, path: str) -> None:
    kind = member.type.decode('ascii', 'replace') if isinstance(member.type, bytes) else str(member.type)
    if kind == '\x00':
        kind = '0'
    actual = (kind, member.mode, member.uid, member.gid, member.linkname or '', member.size)
    wanted = tuple(expected[:6])
    if actual != wanted:
        raise ValueError(f'Archive/inventory metadata mismatch: {path}; archive={actual}, inventory={wanted}')


def is_host_dependency(name: str, host_packages: set[str]) -> dict | None:
    if name in HOST_ALWAYS:
        return {'kind': 'kernel', 'package': None}
    for package, pattern in HOST_SONAME_PACKAGE.items():
        if package in host_packages and pattern.fullmatch(name):
            return {'kind': 'host-package-promise', 'package': package}
    return None


def is_media_path(path: str) -> bool:
    return pathlib.PurePosixPath(path).name.startswith(MEDIA_PREFIXES)


def symlink_alias_path(alias: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(alias), target))


def audit_declared_package_dependencies(arch: str, baseline_lock: dict) -> list[dict]:
    supplement_lock = json.loads((ROOT / 'config/runtime-supplement-lock.json').read_text('utf8'))
    baseline_private = {row['name'] for row in baseline_lock['packages']}
    baseline_host = set(baseline_lock.get('hostPackages', []))
    supplement_names = {row['name'] for row in supplement_lock['architectures'][arch]['packages']}
    result = []
    for package in supplement_lock['architectures'][arch]['packages']:
        for clause in package.get('depends', '').split(','):
            alternatives = [re.split(r'\s*\(', part.strip(), maxsplit=1)[0].strip()
                            for part in clause.split('|') if part.strip()]
            private = [name for name in alternatives if name in baseline_private]
            supplement = [name for name in alternatives if name in supplement_names]
            host = [name for name in alternatives if name in baseline_host]
            if private:
                status, providers = 'baseline-private-package', private
            elif supplement:
                status, providers = 'supplement-package', supplement
            elif host:
                status, providers = 'baseline-host-package-promise', host
            else:
                status, providers = 'package-dependency-not-in-baseline', []
            result.append({'supplementPackage': package['name'], 'clause': clause.strip(),
                           'status': status, 'baselineProviders': providers})
    return result


def expected_resource_selection(arch: str, inventory: dict, compatibility: dict) -> dict:
    host_rows = compatibility.get(arch, {}).get('files', {})
    host_candidates, private = [], 0
    reasons = defaultdict(int)
    for name, row in inventory.items():
        if row[0] != '0':
            continue
        if is_media_path(name):
            private += 1
            reasons['media-kept-private'] += 1
            continue
        if arch == 'x64' and name in host_rows:
            if host_rows[name]['sha256'] == row[6]:
                kind = 'identical'
            else:
                kind = 'tested-profile'
            host_candidates.append({'path': name, 'kind': kind, 'sourceSha256': row[6], 'runtimeSha256': host_rows[name]['sha256']})
            continue
        if arch == 'arm64' and (name.startswith('usr/lib/python3.11/') or name.startswith('usr/share/')):
            host_candidates.append({'path': name, 'kind': 'identical', 'sourceSha256': row[6], 'runtimeSha256': row[6]})
            continue
        private += 1
        reasons['no-verified-host-candidate'] += 1
    counts = defaultdict(int)
    for item in host_candidates:
        counts[item['kind']] += 1
    return {'policy': 'scripts/prepare-runtime-resources.py selection reproduced from lock inventory and compatibility config',
            'profile': compatibility.get(arch, {}).get('profile'),
            'compatibilityScope': compatibility.get(arch, {}).get('scope'),
            'hostReuseCandidates': dict(sorted(counts.items())),
            'hostReuseCandidateCount': len(host_candidates), 'privateFallbackRegularFiles': private,
            'privateFallbackReasons': dict(sorted(reasons.items())),
            'examples': host_candidates[:8], 'crossArchitectureReuse': False}


def _version_parts(value: str | None) -> tuple[int, ...] | None:
    if not value:
        return None
    m = VERSION_RE.fullmatch(value)
    return tuple(int(part) for part in m.group(2).split('.')) if m else None


def _match_export(imported: dict, exports: list[dict]) -> bool:
    for exported in exports:
        if exported['name'] != imported['name']:
            continue
        if imported.get('version') is None or exported.get('version') == imported['version']:
            return True
    return False


def audit_arch(arch: str, compatibility: dict) -> dict:
    spec = select_architecture(arch)
    source_lock_path = ROOT / 'config' / spec['lock']
    solid_dir = ROOT / '.cache/runtime-solid' / arch
    lock = json.loads(source_lock_path.read_text('utf8'))
    solid_lock = json.loads((solid_dir / 'runtime-lock.json').read_text('utf8'))
    if lock.get('platform') != spec['platform'] or solid_lock.get('platform') != spec['platform']:
        raise ValueError(f'{arch}: lock platform does not match requested resource architecture')
    if lock.get('minimumGlibc') != solid_lock.get('minimumGlibc'):
        raise ValueError(f'{arch}: source and solid lock minimumGlibc differ')
    if lock['packages'] != solid_lock['packages']:
        raise ValueError(f'{arch}: solid runtime package list differs from config lock')
    inventory = json.loads((solid_dir / 'inventory.json').read_text('utf8'))
    if not isinstance(inventory, dict) or not inventory:
        raise ValueError(f'{arch}: inventory is empty or malformed')

    archive_rows, file_meta, elf_map = [], {}, {}
    expected_archive_names = set()
    for i, item in enumerate(solid_lock.get('archives', [])):
        filename, expected_sha = item.get('payloadFile'), item.get('payloadSha256')
        if not isinstance(filename, str) or not re.fullmatch(r'[a-f0-9]{64}-data\.tar\.xz', filename) or filename != expected_sha + '-data.tar.xz':
            raise ValueError(f'{arch}: invalid solid archive selection entry')
        if filename in expected_archive_names:
            raise ValueError(f'{arch}: duplicate solid archive reference {filename}')
        expected_archive_names.add(filename)
        archive_path = ROOT / '.cache/runtime-solid/shared' / filename
        print(f'[{arch}] hashing and scanning {filename}', flush=True)
        actual_sha = sha256_file(archive_path)
        if actual_sha != expected_sha:
            raise ValueError(f'{arch}: solid archive hash mismatch {filename}')
        archive_rows.append({'file': filename, 'sha256': actual_sha, 'verified': True,
                             'role': 'common' if i == 0 else 'architecture-specific'})
        with tarfile.open(archive_path, mode='r|xz') as archive:
            for member in archive:
                name = norm_member(member.name)
                if name not in inventory:
                    raise ValueError(f'{arch}: archive member absent from inventory: {name}')
                if name in file_meta:
                    raise ValueError(f'{arch}: duplicate member across solid archives: {name}')
                inventory_match(member, inventory[name], name)
                file_meta[name] = {'type': inventory[name][0], 'size': inventory[name][5], 'sha256': inventory[name][6],
                                   'target': inventory[name][4] if inventory[name][0] == '2' else None}
                if member.isfile():
                    stream = archive.extractfile(member)
                    magic = stream.read(4) if stream else b''
                    if magic == b'\x7fELF':
                        data = magic + stream.read()
                        parsed = parse_elf(data)
                        assert_machine(parsed['machine'], spec['machine'], name)
                        if hashlib.sha256(data).hexdigest() != inventory[name][6]:
                            raise ValueError(f'{arch}: ELF content hash mismatch against inventory: {name}')
                        parsed.update({'path': name, 'sha256': inventory[name][6], 'bytes': len(data)})
                        elf_map[name] = parsed
        print(f'[{arch}] scanned {filename}: {len(file_meta)} archive members, {len(elf_map)} ELF objects', flush=True)
    missing_inventory = sorted(set(inventory) - set(file_meta))
    if missing_inventory:
        raise ValueError(f'{arch}: {len(missing_inventory)} inventory paths absent from selected archives; examples={missing_inventory[:8]}')

    supplement_manifest_path = ROOT / '.cache/runtime-supplements' / arch / 'runtime-supplement.json'
    supplement = None
    if supplement_manifest_path.exists():
        supplement = json.loads(supplement_manifest_path.read_text('utf8'))
        if supplement.get('architecture') != arch or supplement.get('platform') != spec['platform']:
            raise ValueError(f'{arch}: runtime supplement selects a different architecture')
        supplement_lock = json.loads((ROOT / 'config/runtime-supplement-lock.json').read_text('utf8'))
        pinned_packages = {row['name']: row for row in supplement_lock['architectures'][arch]['packages']}
        manifest_packages = {row['name']: row for row in supplement.get('packages', [])}
        if set(pinned_packages) != set(manifest_packages):
            raise ValueError(f'{arch}: supplement package set differs from its source lock')
        for name, pinned in pinned_packages.items():
            row = manifest_packages[name]
            for key in ('version', 'architecture', 'url', 'debSha256', 'dataMember', 'dataSha256', 'depends'):
                manifest_key = 'officialDepends' if key == 'depends' else key
                if row.get(manifest_key) != pinned.get(key):
                    raise ValueError(f'{arch}: supplement manifest differs from lock for {name}.{key}')
        supplement_archive = supplement_manifest_path.parent / supplement['archive']['file']
        if sha256_file(supplement_archive) != supplement['archive']['sha256']:
            raise ValueError(f'{arch}: supplement archive SHA256 mismatch')
        listed = {row['path']: row for row in supplement.get('files', [])}
        supplement_count = 0
        with tarfile.open(supplement_archive, mode='r:xz') as archive:
            for member in archive:
                name = norm_member(member.name)
                row = listed.pop(name, None)
                if row is None or name in file_meta:
                    raise ValueError(f'{arch}: unlisted or duplicate supplement member: {name}')
                if member.isfile():
                    stream = archive.extractfile(member)
                    data = stream.read() if stream else b''
                    if row.get('sha256') != hashlib.sha256(data).hexdigest() or row.get('size') != len(data):
                        raise ValueError(f'{arch}: supplement member hash/size mismatch: {name}')
                    file_meta[name] = {'type': '0', 'size': len(data), 'sha256': row['sha256'], 'layer': 'supplement', 'target': None}
                    if data.startswith(b'\x7fELF'):
                        parsed = parse_elf(data)
                        assert_machine(parsed['machine'], spec['machine'], name)
                        parsed.update({'path': name, 'sha256': row['sha256'], 'bytes': len(data), 'layer': 'supplement'})
                        elf_map[name] = parsed
                elif member.issym():
                    if row.get('target') != member.linkname:
                        raise ValueError(f'{arch}: supplement symlink target mismatch: {name}')
                    file_meta[name] = {'type': '2', 'size': 0, 'sha256': None, 'layer': 'supplement', 'target': row['target']}
                else:
                    raise ValueError(f'{arch}: unsupported supplement member type: {name}')
                supplement_count += 1
        if listed:
            raise ValueError(f'{arch}: {len(listed)} supplement manifest entries absent from archive')
        if supplement_count != len(supplement.get('files', [])):
            raise ValueError(f'{arch}: supplement member count does not match manifest')
        supplement['verified'] = True
        supplement['mergedFiles'] = supplement_count
    else:
        supplement = {'verified': False, 'reason': 'No architecture supplement generated'}

    by_soname = defaultdict(list)
    for item in elf_map.values():
        by_soname[pathlib.PurePosixPath(item['path']).name].append(item)
        if item.get('soname'):
            by_soname[item['soname']].append(item)
    # Debian runtime packages often expose the ELF SONAME through a symlink
    # whose name differs from the embedded SONAME (for example libsndio.so.7.0).
    # Resolve in-root relative symlinks so DT_NEEDED closure sees the file the
    # loader would reach, while retaining the alias as an explicit provider.
    for alias, meta in file_meta.items():
        if meta.get('type') != '2' or not meta.get('target'):
            continue
        target = symlink_alias_path(alias, meta['target'])
        visited = {alias}
        for _ in range(16):
            if target in elf_map:
                by_soname[pathlib.PurePosixPath(alias).name].append(elf_map[target])
                break
            if target in visited:
                break
            visited.add(target)
            target_meta = file_meta.get(target)
            if not target_meta or target_meta.get('type') != '2' or not target_meta.get('target'):
                break
            target = symlink_alias_path(target, target_meta['target'])
    host_packages = set(lock.get('hostPackages', []))
    dependency_rows, private_missing = [], []
    for item in elf_map.values():
        for needed in item['needed']:
            providers = by_soname.get(needed, [])
            if providers:
                dependency_rows.append({'from': item['path'], 'needed': needed, 'status': 'private-provider',
                                        'providers': sorted({p['path'] for p in providers})[:4]})
            else:
                host = is_host_dependency(needed, host_packages)
                status = 'host-promise-unverified' if host else 'private-provider-missing'
                row = {'from': item['path'], 'needed': needed, 'status': status, 'host': host}
                dependency_rows.append(row)
                if not host:
                    private_missing.append(row)

    # Build per-object transitive DT_NEEDED closures; DSO exports are checked in
    # that closure, never against an unrelated architecture or the Windows host.
    closure_cache = {}
    def closure(start: str) -> tuple[set[str], list[dict]]:
        if start in closure_cache:
            return closure_cache[start]
        seen, missing, queue = set(), [], deque(elf_map[start]['needed'])
        while queue:
            needed = queue.popleft()
            candidates = by_soname.get(needed, [])
            if not candidates:
                if not is_host_dependency(needed, host_packages):
                    missing.append({'needed': needed, 'from': start})
                continue
            for provider in candidates:
                if provider['path'] in seen or provider['path'] == start:
                    continue
                seen.add(provider['path'])
                queue.extend(provider['needed'])
        closure_cache[start] = (seen, missing)
        return closure_cache[start]

    symbol_counts = defaultdict(int)
    unresolved_private, context_unknown, host_symbols = [], [], []
    glibc_required, glibcxx_required, cxxabi_required = set(), set(), set()
    glibcxx_provided, cxxabi_provided = set(), set()
    symbol_table_missing = []
    executable_roots = []
    for item in elf_map.values():
        if item['type'] == 2 or item.get('interpreter'):
            executable_roots.append(item['path'])
        if not item['symbolTableAvailable']:
            symbol_table_missing.append(item['path'])
        for symbol in item['exports']:
            version = symbol.get('version')
            m = VERSION_RE.fullmatch(version or '')
            if m and m.group(1) == 'GLIBCXX':
                glibcxx_provided.add(version)
            if m and m.group(1) == 'CXXABI':
                cxxabi_provided.add(version)
        for symbol in item['imports']:
            version, verfile = symbol.get('version'), symbol.get('file')
            if version:
                match = VERSION_RE.fullmatch(version)
                if match:
                    if match.group(1) == 'GLIBC':
                        glibc_required.add(version)
                    elif match.group(1) == 'GLIBCXX':
                        glibcxx_required.add(version)
                    elif match.group(1) == 'CXXABI':
                        cxxabi_required.add(version)

    for start, item in elf_map.items():
        loaded, missing = closure(start)
        loaded_items = [elf_map[p] for p in loaded]
        exports = [symbol for provider in loaded_items for symbol in provider['exports']]
        host_needed = sorted({needed for provider in [item, *loaded_items]
                              for needed in provider['needed']
                              if not by_soname.get(needed) and is_host_dependency(needed, host_packages)})
        for symbol in item['imports']:
            symbol_counts['imports'] += 1
            verfile = symbol.get('file')
            if verfile and not by_soname.get(verfile):
                host = is_host_dependency(verfile, host_packages)
                if host:
                    symbol_counts['hostExternalUnverified'] += 1
                    if len(host_symbols) < 50:
                        host_symbols.append({'object': start, 'symbol': symbol['name'], 'version': symbol.get('version'), 'provider': verfile, 'host': host})
                    continue
            if _match_export(symbol, exports):
                symbol_counts['resolvedInNeededClosure'] += 1
                continue
            # Unversioned imports have no verneed file to identify their exact DSO.
            # If the object's declared closure contains host-promised libraries,
            # retain these as unverified host/process-scope imports rather than
            # falsely reporting them as proven private-provider failures.
            if not verfile and host_needed:
                symbol_counts['hostExternalUnverified'] += 1
                if len(host_symbols) < 50:
                    host_symbols.append({'object': start, 'symbol': symbol['name'], 'version': None,
                                         'provider': None, 'hostNeededCandidates': host_needed,
                                         'host': 'unversioned import; provider not statically identifiable'})
                continue
            if verfile and not by_soname.get(verfile) and is_host_dependency(verfile, host_packages):
                symbol_counts['hostExternalUnverified'] += 1
                continue
            row = {'object': start, 'symbol': symbol['name'], 'version': symbol.get('version'), 'versionFile': verfile}
            if verfile and (by_soname.get(verfile) or not is_host_dependency(verfile, host_packages)):
                symbol_counts['unresolvedPrivate'] += 1
                if len(unresolved_private) < 200:
                    unresolved_private.append(row)
            elif item['type'] == 2 or item.get('interpreter'):
                symbol_counts['unresolvedExecutable'] += 1
                if len(unresolved_private) < 200:
                    unresolved_private.append(row)
            else:
                symbol_counts['contextAmbiguous'] += 1
                if len(context_unknown) < 100:
                    context_unknown.append(row)

    glibc_max = max(glibc_required, key=version_tuple) if glibc_required else None
    glibc_limit = lock.get('minimumGlibc')
    glibc_pass = not glibc_max or version_tuple(glibc_max) <= tuple(int(x) for x in glibc_limit.split('.'))
    glibcxx_check = check_version_requirements(glibcxx_required, glibcxx_provided, 'GLIBCXX')
    cxxabi_check = check_version_requirements(cxxabi_required, cxxabi_provided, 'CXXABI')
    resources = expected_resource_selection(arch, inventory, compatibility)
    supplement_dependency_audit = audit_declared_package_dependencies(arch, lock) if supplement.get('verified') else []
    focus = {}
    for label, matcher in {
        'python': lambda p: 'python' in pathlib.PurePosixPath(p).name.lower(),
        'sqlcipher': lambda p: 'sqlcipher' in pathlib.PurePosixPath(p).name.lower(),
        'media': lambda p: pathlib.PurePosixPath(p).name.startswith(MEDIA_PREFIXES),
    }.items():
        selected = [item for item in elf_map.values() if matcher(item['path']) or any(matcher(n) for n in item['needed'])]
        focus[label] = {'elfObjects': len({x['path'] for x in selected}), 'examples': sorted({x['path'] for x in selected})[:16]}

    errors = []
    if private_missing:
        errors.append(f'{len(private_missing)} DT_NEEDED entries have no private provider and no declared host package provider')
    if unresolved_private:
        errors.append(f'{len(unresolved_private)} dynamic imports are unresolved in their private dependency closure')
    if not glibc_pass:
        errors.append(f'maximum required GLIBC {glibc_max} exceeds declared minimum {glibc_limit}')
    if not glibcxx_check['pass']:
        errors.append(f'{len(glibcxx_check["missingExactDefinitions"])} required GLIBCXX versions are absent from private exports')
    if not cxxabi_check['pass']:
        errors.append(f'{len(cxxabi_check["missingExactDefinitions"])} required CXXABI versions are absent from private exports')
    missing_supplement_dependencies = [row for row in supplement_dependency_audit
                                       if row['status'] == 'package-dependency-not-in-baseline']
    if missing_supplement_dependencies:
        errors.append(f'{len(missing_supplement_dependencies)} declared supplement package dependencies are absent from the baseline')
    return {
        'selection': {'requestedArchitecture': arch, 'platform': lock['platform'], 'machine': machine_name(spec['machine']),
                      'sourceLock': str(source_lock_path.relative_to(ROOT)).replace('\\', '/'),
                      'solidLock': str((solid_dir / 'runtime-lock.json').relative_to(ROOT)).replace('\\', '/'),
                      'packageCount': len(lock['packages']), 'minimumGlibc': glibc_limit,
                      'archives': archive_rows, 'crossArchitecturePayloadSelected': False},
        'archiveInventory': {'inventoryEntries': len(inventory), 'matchedArchiveEntries': len(file_meta),
                             'elfObjects': len(elf_map), 'dynamicSymbolTables': len(elf_map) - len(symbol_table_missing),
                             'symbolTablesMissing': symbol_table_missing[:40]},
        'resourceSelection': resources,
        'supplement': supplement,
        'supplementPackageDependencies': supplement_dependency_audit,
        'dependencies': {'neededEdges': len(dependency_rows),
                         'privateProviderEdges': sum(x['status'] == 'private-provider' for x in dependency_rows),
                         'hostPromisesUnverified': sum(x['status'] == 'host-promise-unverified' for x in dependency_rows),
                         'privateProviderMissing': private_missing[:200]},
        'symbols': {'counts': dict(symbol_counts), 'unresolvedPrivateExamples': unresolved_private,
                    'hostExternalExamples': host_symbols, 'contextAmbiguousExamples': context_unknown,
                    'contextAmbiguousNote': 'DSO imports can be supplied by a process-global/plugin scope outside their DT_NEEDED closure; these are reported and are not claimed resolved.'},
        'versions': {'glibc': {'maximumRequired': glibc_max, 'declaredMinimum': glibc_limit, 'pass': glibc_pass},
                     'glibcxx': glibcxx_check, 'cxxabi': cxxabi_check},
        'focus': focus, 'errors': errors,
        'limitations': ['Static ELF inspection only; binaries were not executed.',
                        'Host libc/libdl/pthread and other declared host-package symbols are promises, not host-file symbol verification.',
                        'This does not reproduce ld.so search order, IFUNC behavior, dlopen/plugin scopes, environment, kernel ABI, or NAS compatibility.',
                        'A passing architecture report is not ARM hardware or product acceptance.']}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path,
                        default=ROOT / 'local/runtime-reuse-development-20261018/static-architecture.json')
    args = parser.parse_args()
    compatibility = json.loads((ROOT / 'config/runtime-compatibility.json').read_text('utf8'))
    if compatibility.get('format') != 1:
        raise ValueError('Unsupported runtime compatibility format')
    report = {'schemaVersion': 1, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'scope': 'Static architecture and ELF dependency evidence only; no binaries executed.',
              'acceptance': {'staticChecksPassed': False, 'realDeviceAcceptance': False,
                             'fullLoaderEquivalence': False},
              'architectures': {arch: audit_arch(arch, compatibility) for arch in ('x64', 'arm64')}}
    errors = {arch: result['errors'] for arch, result in report['architectures'].items() if result['errors']}
    report['acceptance']['staticChecksPassed'] = not errors
    report['errors'] = errors
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    summary = {arch: {'elfObjects': result['archiveInventory']['elfObjects'],
                      'neededEdges': result['dependencies']['neededEdges'],
                      'missingPrivate': len(result['dependencies']['privateProviderMissing']),
                      'unresolvedPrivateSymbols': result['symbols']['counts'].get('unresolvedPrivate', 0),
                      'maxGlibc': result['versions']['glibc']['maximumRequired'],
                      'maxGlibcxx': result['versions']['glibcxx']['maximumProvided'],
                      'hostReuseCandidates': result['resourceSelection']['hostReuseCandidateCount'],
                      'errors': len(result['errors'])} for arch, result in report['architectures'].items()}
    print(json.dumps({'report': str(args.output), 'staticChecksPassed': not errors, 'architectures': summary}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1)
