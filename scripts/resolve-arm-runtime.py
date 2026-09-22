"""Resolve the Debian bookworm ARM64 runtime from official package indices.

Uses the existing x64 package set as roots, then closes ARM dependencies. No
host package installation or package scripts run on the build computer.
"""
import concurrent.futures, hashlib, io, json, lzma, pathlib, re, tarfile, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'arm-resolver'
CACHE.mkdir(parents=True, exist_ok=True)

def fetch(url, file, digest=None):
    if file.exists():
        data = file.read_bytes()
        if not digest or hashlib.sha256(data).hexdigest() == digest:
            return data
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read()
            if digest and hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('Package hash mismatch')
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            return data
        except Exception:
            if attempt == 2: raise

def fields(text):
    result, key = {}, None
    for line in text.splitlines():
        if line.startswith(' ') and key: result[key] += ' ' + line.strip()
        elif ': ' in line:
            key, value = line.split(': ', 1); result[key] = value
    return result

packages = {}
for label, base, suite in [('main', 'https://deb.debian.org/debian/', 'bookworm'),
                          ('updates', 'https://deb.debian.org/debian/', 'bookworm-updates'),
                          ('security', 'https://security.debian.org/debian-security/', 'bookworm-security')]:
    url = f'{base}dists/{suite}/main/binary-arm64/Packages.xz'
    data = fetch(url, CACHE / f'{label}-Packages.xz')
    for record in lzma.decompress(data).decode().split('\n\n'):
        entry = fields(record)
        if 'Package' in entry:
            entry['url'] = base + entry['Filename']; packages[entry['Package']] = entry
print(f'Indexed {len(packages)} ARM64 packages', flush=True)
old = json.loads((ROOT / 'config/runtime-lock.json').read_text())
host = set(old['hostPackages'])
providers = {}
for name, entry in packages.items():
    for provided in entry.get('Provides', '').split(','):
        key = provided.strip().split(' ', 1)[0]
        if key: providers.setdefault(key, name)
selected, pending = {}, [p['name'] for p in old['packages'] if p['name'] in packages]
omitted = [p['name'] for p in old['packages'] if p['name'] not in packages]
while pending:
    name = pending.pop()
    if name in selected or name in host: continue
    entry = packages[name]; selected[name] = entry
    for group in (entry.get('Pre-Depends', '') + ',' + entry.get('Depends', '')).split(','):
        if not group.strip(): continue
        alternatives = [re.split(r'[\s:(\[]', part.strip(), 1)[0] for part in group.split('|')]
        if any(x in host for x in alternatives): continue
        choice = next((x for x in alternatives if x in packages), None)
        choice = choice or next((providers[x] for x in alternatives if x in providers), None)
        if not choice: raise ValueError(f'Unresolved dependency {name}: {group}')
        pending.append(choice)

def prepare(entry):
    data = fetch(entry['url'], CACHE / pathlib.PurePosixPath(entry['Filename']).name, entry['SHA256'])
    if data[:8] != b'!<arch>\n': raise ValueError('Invalid Debian archive')
    pos = 8
    while pos + 60 <= len(data):
        name = data[pos:pos+16].decode().strip().rstrip('/')
        size = int(data[pos+48:pos+58]); payload = data[pos+60:pos+60+size]
        if name.startswith('data.tar'):
            filename = entry['Package'] + '-' + name
            dest = ROOT / '.cache/runtime-arm64' / filename
            dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(payload)
            # The Debian index's architecture is verified against actual ELF
            # members; data-only packages are explicitly recorded as all.
            with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
                for member in archive:
                    if member.isfile() and member.mode & 0o111 and member.size >= 20:
                        header = archive.extractfile(member).read(20)
                        if header[:4] == b'\x7fELF' and int.from_bytes(header[18:20], 'little') != 183:
                            raise ValueError(f'Unexpected ELF architecture: {entry["Package"]} {member.name}')
            return {'name': entry['Package'], 'version': entry['Version'], 'architecture': entry['Architecture'],
                    'url': entry['url'], 'debSha256': entry['SHA256'], 'file': filename, 'sha256': hashlib.sha256(payload).hexdigest()}
        pos += 60 + size + size % 2
    raise ValueError('Missing data archive')

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    tasks = [pool.submit(prepare, entry) for entry in selected.values()]
    for task in concurrent.futures.as_completed(tasks):
        results.append(task.result())
        if len(results) % 30 == 0: print(f'ARM64 runtime verified {len(results)}/{len(tasks)}', flush=True)
lock = {'platform': 'linux-arm64', 'minimumGlibc': '2.36', 'hostPackages': sorted(host),
        'omittedX64Only': omitted, 'packages': sorted(results, key=lambda x: x['name'])}
(ROOT / 'config/runtime-lock-arm64.json').write_text(json.dumps(lock, indent=2) + '\n')
print(f'ARM64 runtime complete: {len(results)} packages; omitted x64-only: {omitted}', flush=True)
