"""Inventory both runtime architectures without executing their binaries."""
import collections
import concurrent.futures
import hashlib
import io
import json
import pathlib
import struct
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def elf_dynamic(data):
    if data[:4] != b'\x7fELF':
        return None
    if data[4:6] != b'\x02\x01':
        raise ValueError('Expected a little-endian ELF64 runtime')
    machine = struct.unpack_from('<H', data, 18)[0]
    phoff = struct.unpack_from('<Q', data, 32)[0]
    phsize, phnum = struct.unpack_from('<HH', data, 54)
    segments = [struct.unpack_from('<IIQQQQQQ', data, phoff + i * phsize) for i in range(phnum)]
    dynamic = next((s for s in segments if s[0] == 2), None)
    entries = [] if dynamic is None else [struct.unpack_from('<qQ', data, o) for o in range(dynamic[2], dynamic[2] + dynamic[5], 16)]
    string_address = next((value for tag, value in entries if tag == 5), None)
    string_offset = None if string_address is None else next((s[2] + string_address - s[3] for s in segments if s[0] == 1 and s[3] <= string_address < s[3] + s[5]), None)
    def string(index):
        if string_offset is None:
            raise ValueError('ELF string table is missing')
        start = string_offset + index
        return data[start:data.index(b'\x00', start)].decode('utf8')
    return {'machine': machine, 'needed': [string(value) for tag, value in entries if tag == 1],
            'soname': next((string(value) for tag, value in entries if tag == 14), None),
            'search': [string(value) for tag, value in entries if tag in (15, 29)]}


def inventory(arch, item):
    source = ROOT / ('.cache/runtime' if arch == 'x64' else '.cache/runtime-arm64') / item['file']
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Source digest mismatch: ' + item['name'])
    files, binaries = [], []
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            if member.isfile():
                files.append({'path': name, 'bytes': member.size})
                stream = archive.extractfile(member)
                magic = stream.read(4)
                if magic == b'\x7fELF':
                    info = elf_dynamic(magic + stream.read())
                    if info['machine'] != (62 if arch == 'x64' else 183):
                        raise ValueError('Architecture mismatch: ' + name)
                    binaries.append({'path': name, **info})
            elif member.issym() or member.islnk():
                files.append({'path': name, 'link': member.linkname})
    return {'name': item['name'], 'sourceBytes': len(raw), 'files': files, 'binaries': binaries}


def main():
    result = {}
    for arch, lockfile in [('x64', 'runtime-lock.json'), ('arm64', 'runtime-lock-arm64.json')]:
        lock = json.loads((ROOT / 'config' / lockfile).read_text('utf8'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            packages = list(pool.map(lambda item: inventory(arch, item), lock['packages']))
        providers = collections.defaultdict(set)
        for package in packages:
            for binary in package['binaries']:
                providers[binary['soname'] or pathlib.PurePosixPath(binary['path']).name].add(package['name'])
            for file in package['files']:
                if file.get('link'):
                    providers[pathlib.PurePosixPath(file['path']).name].add(package['name'])
        for package in packages:
            package['dependsOn'] = sorted({owner for binary in package['binaries'] for needed in binary['needed'] for owner in providers.get(needed, []) if owner != package['name']})
        result[arch] = packages
        print(json.dumps({'arch': arch, 'packages': len(packages), 'binaries': sum(len(p['binaries']) for p in packages),
                          'top': [{'name': p['name'], 'bytes': p['sourceBytes']} for p in sorted(packages, key=lambda p: p['sourceBytes'], reverse=True)[:12]]}), flush=True)
    out = ROOT / 'reports/runtime-dependencies.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
