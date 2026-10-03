"""Share identical files across architectures and compress each final tree once.

Only the documentation removals already approved by prepare-runtime-slim apply.
Original package provenance and the final file/link/mode inventories are retained.
"""
import copy
import hashlib
import json
import lzma
import pathlib
import posixpath
import tarfile
import tempfile
import time
import importlib.util

from prepare_runtime_slim_import import removable

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.cache/runtime-solid'

spec = importlib.util.spec_from_file_location('runtime_elf', pathlib.Path(__file__).with_name('audit-runtime-dependencies.py'))
elf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(elf)


def compression_name(label, preset):
    return 'x86-9e' if label == 'x64' else 'lzma2-' + str(preset & ~lzma.PRESET_EXTREME) + ('e' if preset & lzma.PRESET_EXTREME else '')


def runtime_fingerprint(locks, policy, preset):
    return hashlib.sha256(json.dumps({'locks': locks, 'policy': policy, 'preset': preset, 'version': 3}, sort_keys=True).encode()).hexdigest()


def apply_policy(arch, tree, spool, policy):
    excluded = policy.get(arch, {}).get('excluded', {})
    for name, expected in excluded.items():
        if canonical(name) != name or name not in tree or signature(*tree[name]) != expected:
            raise ValueError('Runtime policy source changed: ' + name)
    removed_sonames = set()
    for name in excluded:
        member, content = tree[name]
        info = elf.elf_dynamic((spool / content).read_bytes()) if member.isfile() else None
        if info and info['soname']:
            removed_sonames.add(info['soname'])
    retained = {name: item for name, item in tree.items() if name not in excluded}
    for name, (member, content) in retained.items():
        if member.issym() or member.islnk():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname) if member.issym() else member.linkname)
            if target in excluded:
                raise ValueError('Retained runtime link needs removed path: ' + name)
        if member.isfile():
            info = elf.elf_dynamic((spool / content).read_bytes())
            if info and removed_sonames.intersection(info['needed']):
                raise ValueError('Retained ELF needs removed runtime library: ' + name)
    return retained


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def canonical(name):
    path = posixpath.normpath(name)
    if path.startswith('/') or '..' in path.split('/'):
        raise ValueError('Unsafe runtime path: ' + name)
    return path


def signature(member, content=None):
    return [member.type.decode('ascii'), member.mode, member.uid, member.gid, member.linkname, member.size, content]


def inventory(arch, lock, spool):
    tree = {}
    hardlink_contents = {}
    cache = ROOT / ('.cache/runtime' if arch == 'x64' else '.cache/runtime-arm64')
    for item in lock['packages']:
        source = cache / item['file']
        if digest(source) != item['sha256']:
            raise ValueError('Original archive digest mismatch: ' + item['name'])
        with tarfile.open(source) as archive:
            members = archive.getmembers()
            dropped = {canonical(m.name) for m in members if removable(m)}
            # Preserve transitive targets of retained links, as the old preparer does.
            changed = True
            while changed:
                changed = False
                for member in members:
                    if canonical(member.name) in dropped or not (member.issym() or member.islnk()):
                        continue
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname) if member.issym() else member.linkname)
                    if target in dropped:
                        dropped.remove(target)
                        changed = True
            for member in members:
                name = canonical(member.name)
                if name in dropped:
                    continue
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise ValueError('Unsupported runtime member: ' + name)
                content = None
                if member.isfile():
                    data = archive.extractfile(member).read()
                    content = hashlib.sha256(data).hexdigest()
                    destination = spool / content
                    if not destination.exists():
                        destination.write_bytes(data)
                if member.islnk():
                    hardlink_contents[name] = hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest()
                else:
                    hardlink_contents.pop(name, None)
                normalized = copy.copy(member)
                normalized.name = name
                normalized.mtime = 0
                normalized.uname = normalized.gname = ''
                normalized.pax_headers = {}
                tree[name] = (normalized, content)
    for name, expected in hardlink_contents.items():
        target = canonical(tree[name][0].linkname)
        visited = {name}
        while target in tree and tree[target][0].islnk():
            if target in visited:
                raise ValueError('Cyclic source hard links: ' + name)
            visited.add(target)
            target = canonical(tree[target][0].linkname)
        if target not in tree or tree[target][1] != expected:
            raise ValueError('Hard-link content would change after consolidation: ' + name)
    return tree


def archive_tree(label, tree, spool, preset):
    pending = OUT / (label + '.pending.tar.xz')
    started = time.monotonic()
    # Directory and regular-file entries precede hard links. Shared targets are
    # extracted first; no hard link can refer to another architecture's files.
    ordered = sorted(tree, key=lambda p: (2 if tree[p][0].islnk() else 0 if tree[p][0].isdir() else 1,
                                         pathlib.PurePosixPath(p).suffix, p))
    # Preserve hard-link dependency order, including rare chained links.
    emitted = set()
    deferred = []
    for name in ordered:
        member, _ = tree[name]
        if member.islnk() and canonical(member.linkname) in tree and canonical(member.linkname) not in emitted:
            deferred.append(name)
        else:
            emitted.add(name)
    ordered = [n for n in ordered if n not in deferred]
    while deferred:
        ready = [n for n in deferred if canonical(tree[n][0].linkname) not in tree or canonical(tree[n][0].linkname) in emitted]
        if not ready:
            raise ValueError('Cyclic runtime hard links')
        ordered.extend(ready)
        emitted.update(ready)
        deferred = [n for n in deferred if n not in emitted]
    compression = {'filters': [{'id': lzma.FILTER_X86}, {'id': lzma.FILTER_LZMA2, 'preset': 9 | lzma.PRESET_EXTREME}]} if label == 'x64' else {'preset': preset}
    with lzma.LZMAFile(pending, 'w', **compression, check=lzma.CHECK_SHA256) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
            for name in ordered:
                member, content = tree[name]
                if content is None:
                    archive.addfile(member)
                else:
                    with (spool / content).open('rb') as stream:
                        archive.addfile(member, stream)
    actual = {}
    with tarfile.open(pending) as check:
        for member in check:
            content = hashlib.file_digest(check.extractfile(member), 'sha256').hexdigest() if member.isfile() else None
            actual[canonical(member.name)] = signature(member, content)
    expected = {name: signature(*value) for name, value in tree.items()}
    if actual != expected:
        raise ValueError('Retained runtime content/mode/link mismatch: ' + label)
    hashed = digest(pending)
    filename = hashed + '-data.tar.xz'
    destination = OUT / 'shared' / filename
    pending.replace(destination)
    proof = {'file': filename, 'sha256': hashed, 'bytes': destination.stat().st_size,
             'members': len(tree), 'compression': compression_name(label, preset),
             'inventorySha256': hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()}
    print(json.dumps({'archive': label, 'bytes': proof['bytes'], 'members': len(tree), 'seconds': round(time.monotonic() - started, 2)}), flush=True)
    return proof


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'shared').mkdir(exist_ok=True)
    locks = {arch: json.loads((ROOT / 'config' / name).read_text('utf8')) for arch, name in [('x64', 'runtime-lock.json'), ('arm64', 'runtime-lock-arm64.json')]}
    preset = 9 | lzma.PRESET_EXTREME
    policy = json.loads((ROOT / 'config/runtime-policy.json').read_text('utf8'))
    fingerprint = runtime_fingerprint(locks, policy, preset)
    existing_path = OUT / 'provenance.json'
    existing = json.loads(existing_path.read_text()) if existing_path.exists() else {}
    if existing.get('fingerprint') == fingerprint and set(existing.get('groups', {})) == {'common', 'x64', 'arm64'}:
        # Reuse a complete, verified output without rewriting thousands of
        # unchanged files. Source archives are still hashed on every build.
        for arch, lock in locks.items():
            cache = ROOT / ('.cache/runtime' if arch == 'x64' else '.cache/runtime-arm64')
            for item in lock['packages']:
                if digest(cache / item['file']) != item['sha256']:
                    raise ValueError('Original archive digest mismatch: ' + item['name'])
        complete = all(p.get('compression', 'lzma2-9') == compression_name(g, preset) and (OUT / 'shared' / p['file']).is_file() and digest(OUT / 'shared' / p['file']) == p['sha256'] for g, p in existing['groups'].items())
        for arch, original in locks.items():
            expected = {**original, 'payloadFormat': 3, 'archives': [{'payloadFile': existing['groups'][g]['file'], 'payloadSha256': existing['groups'][g]['sha256']} for g in ['common', arch]]}
            cached = OUT / arch / 'runtime-lock.json'
            complete = complete and cached.is_file() and json.loads(cached.read_text('utf8')) == expected
        if complete:
            print(json.dumps({'format': 3, 'reused': True, 'archives': 3, 'bytes': existing['bytes']}), flush=True)
            return
    with tempfile.TemporaryDirectory(prefix='qibox-solid-', dir=OUT) as temp:
        spool = pathlib.Path(temp)
        trees = {arch: apply_policy(arch, inventory(arch, lock, spool), spool, policy) for arch, lock in locks.items()}
        common = {name for name in trees['x64'].keys() & trees['arm64'].keys() if signature(*trees['x64'][name]) == signature(*trees['arm64'][name])}
        changed = True
        while changed:
            invalid = {name for name in common if trees['x64'][name][0].islnk() and canonical(trees['x64'][name][0].linkname) not in common}
            changed = bool(invalid)
            common -= invalid
        groups = {'common': {n: trees['x64'][n] for n in common},
                  **{arch: {n: item for n, item in tree.items() if n not in common} for arch, tree in trees.items()}}
        for arch in trees:
            reconstructed = {**groups['common'], **groups[arch]}
            if {n: signature(*v) for n, v in reconstructed.items()} != {n: signature(*v) for n, v in trees[arch].items()}:
                raise ValueError('Architecture reconstruction differs: ' + arch)
        proofs = {}
        for label, tree in groups.items():
            expected = {name: signature(*value) for name, value in tree.items()}
            inventory_hash = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
            previous = existing.get('groups', {}).get(label, {})
            compression = compression_name(label, preset)
            # Format-3 initial common/ARM64 archives used the same LZMA2-9.
            if previous.get('inventorySha256') == inventory_hash and previous.get('compression', 'lzma2-9') == compression and (OUT / 'shared' / previous['file']).is_file() and digest(OUT / 'shared' / previous['file']) == previous['sha256']:
                proofs[label] = {**previous, 'compression': compression}
                print(json.dumps({'archive': label, 'reused': True, 'bytes': previous['bytes']}), flush=True)
            else:
                proofs[label] = archive_tree(label, tree, spool, preset)
        for arch, lock in locks.items():
            lock['payloadFormat'] = 3
            lock['archives'] = [{'payloadFile': proofs[group]['file'], 'payloadSha256': proofs[group]['sha256']} for group in ['common', arch]]
            folder = OUT / arch
            folder.mkdir(exist_ok=True)
            (folder / 'runtime-lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
            manifest = {name: signature(*value) for name, value in trees[arch].items()}
            (folder / 'inventory.json').write_text(json.dumps(manifest, sort_keys=True) + '\n', encoding='utf8')
        proof = {'format': 3, 'fingerprint': fingerprint, 'references': sum(len(lock['packages']) for lock in locks.values()),
                 'archives': len(proofs), 'bytes': sum(p['bytes'] for p in proofs.values()), 'groups': proofs,
                 'policy': policy,
                 'sources': {arch: [{'name': item['name'], 'sha256': item['sha256']} for item in lock['packages']] for arch, lock in locks.items()}}
        existing_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        print(json.dumps({k: proof[k] for k in ['format', 'references', 'archives', 'bytes']}), flush=True)


if __name__ == '__main__':
    main()
